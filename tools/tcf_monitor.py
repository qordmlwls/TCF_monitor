"""
Monitor Alliance Francaise Edmonton TCF Canada registration availability.

The script checks the public schedule table and sends an email alert when a
TCF Canada session is newly posted or appears available. It does not automate
checkout, payment, CAPTCHA, queueing, or final registration submission.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import logging
import os
import random
import re
import smtplib
import ssl
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from email.message import EmailMessage
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urljoin

import requests

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - dependency is declared in requirements.txt.
    def load_dotenv(*_args: Any, **_kwargs: Any) -> bool:
        return False


DEFAULT_URL = "https://www.afedmonton.com/en/exams/tcf/"
DEFAULT_RECIPIENT = "qordmlwls@gmail.com"
DEFAULT_STATE_FILE = Path.home() / ".tcf-monitor" / "afedmonton-tcf-state.json"
DEFAULT_INTERVAL_SECONDS = 180
DEFAULT_FETCH_ATTEMPTS = 4
DEFAULT_RETRY_DELAY_SECONDS = 10
MIN_INTERVAL_SECONDS = 30
USER_AGENT = (
    "TCF-Availability-Monitor/1.0 "
    "(public schedule checker; no automated registration)"
)

TEXT_SPACE_RE = re.compile(r"\s+")


@dataclass(frozen=True)
class Link:
    text: str
    href: str


@dataclass(frozen=True)
class Cell:
    text: str
    links: tuple[Link, ...] = ()


@dataclass(frozen=True)
class ParsedRow:
    cells: tuple[Cell, ...]


@dataclass(frozen=True)
class ExamRow:
    exam: str
    schedule: str
    registration_dates: str
    location: str
    spots_left: str
    price: str
    bookings: str
    booking_links: tuple[Link, ...] = ()

    @property
    def is_tcf_canada(self) -> bool:
        return "tcf canada" in self.exam.lower()

    @property
    def is_sold_out(self) -> bool:
        spots = self.spots_left.lower()
        return "sold out" in spots or spots in {"0", "0 spots", "0 spot"}

    @property
    def is_booking_closed(self) -> bool:
        return "closed" in self.bookings.lower()

    @property
    def is_available(self) -> bool:
        if self.is_sold_out or self.is_booking_closed:
            return False

        combined = f"{self.spots_left} {self.bookings}".lower()
        if re.search(r"\b(register|book|booking|available|open|cart|purchase)\b", combined):
            return True

        if re.search(r"\b([1-9][0-9]*)\b", self.spots_left):
            return True

        return bool(self.booking_links)

    @property
    def key(self) -> str:
        raw = "|".join(
            [
                self.exam,
                self.schedule,
                self.registration_dates,
                self.location,
            ]
        )
        return stable_hash(raw)

    @property
    def fingerprint(self) -> str:
        raw = "|".join(
            [
                self.exam,
                self.schedule,
                self.registration_dates,
                self.location,
                self.spots_left,
                self.price,
                self.bookings,
                ",".join(link.href for link in self.booking_links),
            ]
        )
        return stable_hash(raw)


@dataclass(frozen=True)
class AlertEvent:
    kind: str
    reason: str
    row: ExamRow


class FetchPageError(RuntimeError):
    pass


@dataclass(frozen=True)
class EmailConfig:
    recipient: str
    sender: str
    host: str
    port: int
    username: str | None = None
    password: str | None = None
    starttls: bool = True
    ssl_mode: bool = False


class ScheduleTableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[ParsedRow] = []
        self._current_row: list[Cell] | None = None
        self._cell_parts: list[str] | None = None
        self._cell_links: list[Link] | None = None
        self._current_link_href: str | None = None
        self._current_link_parts: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag == "tr":
            self._finish_row()
            self._current_row = []
            return

        if self._current_row is None:
            return

        if tag in {"th", "td"}:
            self._finish_cell()
            self._cell_parts = []
            self._cell_links = []
            return

        if self._cell_parts is None:
            return

        if tag == "br":
            self._cell_parts.append(" ")
            if self._current_link_parts is not None:
                self._current_link_parts.append(" ")
            return

        if tag == "a":
            attr_map = {name.lower(): value for name, value in attrs}
            self._current_link_href = attr_map.get("href") or ""
            self._current_link_parts = []

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "a":
            self._finish_link()
        elif tag in {"th", "td"}:
            self._finish_cell()
        elif tag == "tr":
            self._finish_row()

    def handle_data(self, data: str) -> None:
        if self._cell_parts is None:
            return
        self._cell_parts.append(data)
        if self._current_link_parts is not None:
            self._current_link_parts.append(data)

    def close(self) -> None:
        self._finish_link()
        self._finish_cell()
        self._finish_row()
        super().close()

    def _finish_link(self) -> None:
        if self._current_link_parts is None:
            return
        href = clean_text(self._current_link_href or "")
        text = clean_text("".join(self._current_link_parts))
        if href and self._cell_links is not None:
            self._cell_links.append(Link(text=text, href=href))
        self._current_link_href = None
        self._current_link_parts = None

    def _finish_cell(self) -> None:
        if self._cell_parts is None:
            return
        self._finish_link()
        text = clean_text("".join(self._cell_parts))
        links = tuple(self._cell_links or [])
        if self._current_row is not None:
            self._current_row.append(Cell(text=text, links=links))
        self._cell_parts = None
        self._cell_links = None

    def _finish_row(self) -> None:
        if self._current_row is None:
            return
        self._finish_cell()
        if any(cell.text for cell in self._current_row):
            self.rows.append(ParsedRow(cells=tuple(self._current_row)))
        self._current_row = None


def clean_text(value: str) -> str:
    return TEXT_SPACE_RE.sub(" ", unescape(value)).strip()


def stable_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:24]


def clean_exam_name(value: str) -> str:
    return clean_text(value.replace("TCF  Canada", "TCF Canada"))


def parse_exam_rows(html: str) -> list[ExamRow]:
    parser = ScheduleTableParser()
    parser.feed(html)
    parser.close()

    rows: list[ExamRow] = []
    in_exam_table = False
    expected_headers = [
        "exam",
        "schedules",
        "registration dates",
        "location",
        "spots left",
        "price",
        "bookings",
    ]

    for parsed_row in parser.rows:
        lowered = [cell.text.lower() for cell in parsed_row.cells]

        if lowered[: len(expected_headers)] == expected_headers:
            in_exam_table = True
            continue

        if not in_exam_table or len(parsed_row.cells) < len(expected_headers):
            continue

        cells = parsed_row.cells
        rows.append(
            ExamRow(
                exam=clean_exam_name(cells[0].text),
                schedule=cells[1].text,
                registration_dates=cells[2].text,
                location=cells[3].text,
                spots_left=cells[4].text,
                price=cells[5].text,
                bookings=cells[6].text,
                booking_links=cells[6].links,
            )
        )

    return rows


def fetch_page(
    url: str,
    timeout_seconds: int,
    *,
    attempts: int = DEFAULT_FETCH_ATTEMPTS,
    retry_delay_seconds: int = DEFAULT_RETRY_DELAY_SECONDS,
) -> str:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            response = requests.get(
                url,
                timeout=timeout_seconds,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                },
            )
            response.raise_for_status()
            return response.text
        except requests.RequestException as exc:
            last_error = exc
            if attempt >= attempts:
                break
            sleep_seconds = retry_delay_seconds * attempt
            logging.warning(
                "Fetch attempt %s/%s failed: %s. Retrying in %ss.",
                attempt,
                attempts,
                exc,
                sleep_seconds,
            )
            time.sleep(sleep_seconds)

    raise FetchPageError(f"Failed to fetch {url} after {attempts} attempts: {last_error}")


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": 1, "seen": {}}
    with path.open("r", encoding="utf-8") as handle:
        state = json.load(handle)
    if "seen" not in state or not isinstance(state["seen"], dict):
        state["seen"] = {}
    return state


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=2, sort_keys=True)
        handle.write("\n")
    tmp_path.replace(path)


def detect_events(
    rows: Iterable[ExamRow],
    state: dict[str, Any],
    *,
    checked_at: str,
    alert_new_sessions: bool,
    alert_on_first_run: bool,
) -> tuple[list[AlertEvent], dict[str, Any]]:
    next_state = copy.deepcopy(state)
    seen = next_state.setdefault("seen", {})
    first_run = not bool(seen)
    events: list[AlertEvent] = []

    current_keys: set[str] = set()
    for row in rows:
        if not row.is_tcf_canada:
            continue

        current_keys.add(row.key)
        previous = seen.get(row.key)
        if previous is None:
            previous = {
                "fingerprint": row.fingerprint,
                "exam": row.exam,
                "schedule": row.schedule,
                "registration_dates": row.registration_dates,
                "location": row.location,
                "spots_left": row.spots_left,
                "bookings": row.bookings,
                "last_seen_at": checked_at,
                "notified_new": bool(first_run and not alert_on_first_run),
                "notified_available": False,
            }
            seen[row.key] = previous

        was_sold_out = "sold out" in str(previous.get("spots_left", "")).lower()
        was_closed = "closed" in str(previous.get("bookings", "")).lower()

        if row.is_available and not previous.get("notified_available"):
            events.append(
                AlertEvent(
                    kind="available",
                    reason="TCF Canada booking appears available or no longer closed/sold out.",
                    row=row,
                )
            )
        elif (
            alert_new_sessions
            and not previous.get("notified_new")
            and (not first_run or alert_on_first_run)
        ):
            events.append(
                AlertEvent(
                    kind="new_session",
                    reason="A new TCF Canada session was posted to the schedule table.",
                    row=row,
                )
            )
        elif (
            previous.get("fingerprint") != row.fingerprint
            and (was_sold_out and not row.is_sold_out or was_closed and not row.is_booking_closed)
            and not previous.get("notified_available")
        ):
            events.append(
                AlertEvent(
                    kind="status_changed",
                    reason="A TCF Canada row changed from sold out/closed to a more interesting status.",
                    row=row,
                )
            )

        previous.update(
            {
                "fingerprint": row.fingerprint,
                "exam": row.exam,
                "schedule": row.schedule,
                "registration_dates": row.registration_dates,
                "location": row.location,
                "spots_left": row.spots_left,
                "bookings": row.bookings,
                "last_seen_at": checked_at,
            }
        )

    for key, value in seen.items():
        if key not in current_keys:
            value["last_missing_at"] = checked_at

    next_state["last_checked_at"] = checked_at
    next_state["version"] = 1
    return events, next_state


def mark_events_sent(state: dict[str, Any], events: Iterable[AlertEvent], sent_at: str) -> None:
    seen = state.setdefault("seen", {})
    for event in events:
        entry = seen.get(event.row.key)
        if entry is None:
            continue
        if event.kind in {"new_session", "available", "status_changed"}:
            entry["notified_new"] = True
        if event.kind in {"available", "status_changed"}:
            entry["notified_available"] = True
        entry["last_alert_sent_at"] = sent_at


def email_config_from_env(recipient: str) -> EmailConfig:
    host = os.getenv("TCF_SMTP_HOST", "").strip()
    username = os.getenv("TCF_SMTP_USERNAME", "").strip() or None
    password = os.getenv("TCF_SMTP_PASSWORD", "").strip() or None
    sender = os.getenv("TCF_SMTP_FROM", "").strip() or username or recipient
    port = int(os.getenv("TCF_SMTP_PORT", "587"))
    starttls = env_bool("TCF_SMTP_STARTTLS", default=True)
    ssl_mode = env_bool("TCF_SMTP_SSL", default=False)

    return EmailConfig(
        recipient=recipient,
        sender=sender,
        host=host,
        port=port,
        username=username,
        password=password,
        starttls=starttls,
        ssl_mode=ssl_mode,
    )


def env_bool(name: str, *, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def validate_email_config(config: EmailConfig) -> None:
    missing = []
    if not config.host:
        missing.append("TCF_SMTP_HOST")
    if not config.sender:
        missing.append("TCF_SMTP_FROM or TCF_SMTP_USERNAME")
    if "gmail.com" in config.host.lower() and not config.username:
        missing.append("TCF_SMTP_USERNAME")
    if config.username and not config.password:
        missing.append("TCF_SMTP_PASSWORD")
    if missing:
        raise RuntimeError(
            "Email is not configured. Missing: "
            + ", ".join(missing)
            + ". For Gmail, use smtp.gmail.com:587 with a Gmail app password."
        )


def send_email(config: EmailConfig, subject: str, body: str) -> None:
    validate_email_config(config)

    message = EmailMessage()
    message["To"] = config.recipient
    message["From"] = config.sender
    message["Subject"] = subject
    message.set_content(body)

    if config.ssl_mode:
        with smtplib.SMTP_SSL(config.host, config.port, context=ssl.create_default_context()) as smtp:
            login_if_needed(smtp, config)
            smtp.send_message(message)
        return

    with smtplib.SMTP(config.host, config.port) as smtp:
        smtp.ehlo()
        if config.starttls:
            smtp.starttls(context=ssl.create_default_context())
            smtp.ehlo()
        login_if_needed(smtp, config)
        smtp.send_message(message)


def login_if_needed(smtp: smtplib.SMTP, config: EmailConfig) -> None:
    if config.username:
        smtp.login(config.username, config.password or "")


def build_alert_subject(events: list[AlertEvent]) -> str:
    if not events:
        return "[TCF Edmonton] No availability changes"
    if len(events) == 1:
        return f"[TCF Edmonton] {events[0].row.exam}: {events[0].kind.replace('_', ' ')}"
    return f"[TCF Edmonton] {len(events)} TCF Canada schedule alerts"


def build_alert_body(events: list[AlertEvent], *, page_url: str, checked_at: str) -> str:
    if not events:
        return f"No TCF Canada availability changes were detected at {checked_at}.\n\nPage: {page_url}\n"

    parts = [
        "TCF Canada schedule alert",
        "",
        f"Checked at: {checked_at}",
        f"Page: {page_url}",
        "",
    ]
    for index, event in enumerate(events, start=1):
        row = event.row
        parts.extend(
            [
                f"{index}. {event.reason}",
                f"Exam: {row.exam}",
                f"Schedule: {row.schedule}",
                f"Registration dates: {row.registration_dates}",
                f"Location: {row.location}",
                f"Spots left: {row.spots_left}",
                f"Bookings: {row.bookings}",
                f"Price: {row.price}",
            ]
        )
        if row.booking_links:
            parts.append(
                "Booking links: "
                + ", ".join(
                    f"{link.text or 'link'} ({urljoin(page_url, link.href)})"
                    for link in row.booking_links
                )
            )
        parts.append("")

    parts.append("Review the page yourself before submitting payment or final registration.")
    return "\n".join(parts)


def summarize_rows(rows: Iterable[ExamRow]) -> str:
    tcf_rows = [row for row in rows if row.is_tcf_canada]
    if not tcf_rows:
        return "No TCF Canada rows found."
    available = [row for row in tcf_rows if row.is_available]
    return f"Found {len(tcf_rows)} TCF Canada rows; {len(available)} appear available."


def run_once(args: argparse.Namespace) -> int:
    checked_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    state_path = Path(args.state_file).expanduser()
    state = load_state(state_path)

    html = fetch_page(
        args.url,
        args.timeout_seconds,
        attempts=args.fetch_attempts,
        retry_delay_seconds=args.retry_delay_seconds,
    )
    rows = parse_exam_rows(html)
    events, next_state = detect_events(
        rows,
        state,
        checked_at=checked_at,
        alert_new_sessions=not args.no_alert_new_sessions,
        alert_on_first_run=args.alert_on_first_run,
    )

    logging.info("%s", summarize_rows(rows))
    if events:
        body = build_alert_body(events, page_url=args.url, checked_at=checked_at)
        subject = build_alert_subject(events)
        if args.dry_run:
            print(subject)
            print()
            print(body)
        else:
            send_email(email_config_from_env(args.email_to), subject, body)
            logging.info("Sent %s alert event(s) to %s.", len(events), args.email_to)
            mark_events_sent(next_state, events, checked_at)
    else:
        logging.info("No alertable changes.")

    if args.dry_run:
        logging.info("Dry run mode; state was not saved.")
    else:
        save_state(state_path, next_state)
        logging.info("State saved to %s.", state_path)
    return 0


def run_watch(args: argparse.Namespace) -> int:
    if args.interval_seconds < MIN_INTERVAL_SECONDS:
        raise RuntimeError(f"--interval-seconds must be at least {MIN_INTERVAL_SECONDS}.")

    logging.info("Watching %s every ~%s seconds.", args.url, args.interval_seconds)
    while True:
        try:
            run_once(args)
        except Exception:
            logging.exception("Check failed.")

        sleep_seconds = jittered_interval(args.interval_seconds, args.jitter_percent)
        logging.info("Sleeping %.1f seconds.", sleep_seconds)
        time.sleep(sleep_seconds)


def jittered_interval(interval_seconds: int, jitter_percent: float) -> float:
    if jitter_percent <= 0:
        return float(interval_seconds)
    low = max(MIN_INTERVAL_SECONDS, interval_seconds * (1 - jitter_percent))
    high = interval_seconds * (1 + jitter_percent)
    return random.uniform(low, high)


def send_test_alert(args: argparse.Namespace) -> int:
    checked_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    event = AlertEvent(
        kind="test",
        reason="This is a test alert from the TCF monitor.",
        row=ExamRow(
            exam="TCF Canada test",
            schedule="Test schedule",
            registration_dates="Test registration window",
            location="Alliance Francaise of Edmonton",
            spots_left="Test",
            price="$400.00",
            bookings="Test",
        ),
    )
    body = build_alert_body([event], page_url=args.url, checked_at=checked_at)
    subject = "[TCF Edmonton] Test alert"
    if args.dry_run:
        print(subject)
        print()
        print(body)
        return 0
    send_email(email_config_from_env(args.email_to), subject, body)
    logging.info("Sent test alert to %s.", args.email_to)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Monitor the Alliance Francaise Edmonton TCF Canada schedule table."
    )
    parser.add_argument("--url", default=os.getenv("TCF_MONITOR_URL", DEFAULT_URL))
    parser.add_argument(
        "--email-to",
        default=os.getenv("TCF_ALERT_EMAIL_TO", DEFAULT_RECIPIENT),
        help="Alert recipient email address.",
    )
    parser.add_argument(
        "--state-file",
        default=os.getenv("TCF_MONITOR_STATE_FILE", str(DEFAULT_STATE_FILE)),
        help="Path to the JSON state file used for deduping alerts.",
    )
    parser.add_argument(
        "--interval-seconds",
        type=int,
        default=int(os.getenv("TCF_MONITOR_INTERVAL_SECONDS", str(DEFAULT_INTERVAL_SECONDS))),
    )
    parser.add_argument(
        "--jitter-percent",
        type=float,
        default=float(os.getenv("TCF_MONITOR_JITTER_PERCENT", "0.2")),
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=int(os.getenv("TCF_MONITOR_TIMEOUT_SECONDS", "20")),
    )
    parser.add_argument(
        "--fetch-attempts",
        type=int,
        default=int(os.getenv("TCF_MONITOR_FETCH_ATTEMPTS", str(DEFAULT_FETCH_ATTEMPTS))),
        help="Number of times to retry fetching the TCF page before failing.",
    )
    parser.add_argument(
        "--retry-delay-seconds",
        type=int,
        default=int(
            os.getenv("TCF_MONITOR_RETRY_DELAY_SECONDS", str(DEFAULT_RETRY_DELAY_SECONDS))
        ),
        help="Base retry delay. Delay increases linearly for each failed fetch attempt.",
    )
    parser.add_argument(
        "--allow-fetch-failure",
        action="store_true",
        help="Exit successfully when the page cannot be fetched after retries.",
    )
    parser.add_argument("--once", action="store_true", help="Run one check and exit.")
    parser.add_argument("--watch", action="store_true", help="Run checks forever.")
    parser.add_argument("--dry-run", action="store_true", help="Print alerts and do not save state.")
    parser.add_argument(
        "--alert-on-first-run",
        action="store_true",
        help="Alert for all matching rows on first run instead of using them as the baseline.",
    )
    parser.add_argument(
        "--no-alert-new-sessions",
        action="store_true",
        help="Only alert for rows that appear available, not newly posted closed rows.",
    )
    parser.add_argument("--test-alert", action="store_true", help="Send a test email and exit.")
    parser.add_argument(
        "--log-level",
        default=os.getenv("TCF_MONITOR_LOG_LEVEL", "INFO"),
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    load_dotenv()
    parser = build_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(levelname)s %(message)s",
    )

    try:
        if args.test_alert:
            return send_test_alert(args)
        if args.watch:
            return run_watch(args)
        return run_once(args)
    except KeyboardInterrupt:
        logging.info("Stopped.")
        return 130
    except FetchPageError as exc:
        if args.allow_fetch_failure:
            logging.warning("%s", exc)
            logging.warning("Treating fetch failure as a skipped check.")
            return 0
        logging.error("%s", exc)
        return 1
    except Exception as exc:
        logging.error("%s", exc)
        return 1


if __name__ == "__main__":
    sys.exit(main())
