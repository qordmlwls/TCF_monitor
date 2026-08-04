"""Monitor official TCF Canada registration feeds for several Canadian cities.

The script sends email alerts for bookable sessions. It does not automate
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
from urllib.parse import parse_qsl, quote, urlencode, urljoin, urlsplit, urlunsplit

import requests

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - dependency is declared in requirements.txt.
    def load_dotenv(*_args: Any, **_kwargs: Any) -> bool:
        return False


DEFAULT_URL = "https://www.afedmonton.com/en/exams/tcf/"
TORONTO_PAGE_URL = (
    "https://www.alliance-francaise.ca/en/exams/tests/"
    "informations-about-tcf-canada/tcf-canada"
)
TORONTO_API_URL = "https://cm-api.alliance-francaise.ca/groupcourses"
MONTREAL_PAGE_URL = "https://www.afmontreal.ca/en/tcf-2/"
OTTAWA_PAGE_URL = "https://af.ca/ottawa/en/tests_et_examens/tcf/"
DEFAULT_RECIPIENT = "qordmlwls@gmail.com"
DEFAULT_STATE_FILE = Path.home() / ".tcf-monitor" / "afedmonton-tcf-state.json"
DEFAULT_INTERVAL_SECONDS = 180
DEFAULT_FETCH_ATTEMPTS = 4
DEFAULT_RETRY_DELAY_SECONDS = 10
DEFAULT_TABLE_PAGE_SIZE = 200
MAX_TABLE_PAGES = 10
MIN_INTERVAL_SECONDS = 30
USER_AGENT = (
    "TCF-Availability-Monitor/1.0 "
    "(public schedule checker; no automated registration)"
)

TEXT_SPACE_RE = re.compile(r"\s+")
EXPLICIT_BOOKING_ACTION_RE = re.compile(
    r"\b(register|book(?: now)?|add to cart|cart|purchase|buy)\b"
)
POSITIVE_BOOKING_STATUS_RE = re.compile(r"\b(available|open)\b")
CLOSED_BOOKING_STATUS_RE = re.compile(
    r"\b(closed|not available|unavailable|not open|registration ended|registration closed)\b"
)
SOLD_OUT_STATUS_RE = re.compile(r"\b(sold out|fully booked|full|no spots?)\b")
ZERO_SPOTS_RE = re.compile(r"^0(?:\s+spots?(?:\s+left)?)?[!.]?$", re.IGNORECASE)


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
    city: str = "Edmonton"
    page_url: str = DEFAULT_URL
    source_id: str = ""
    available_override: bool | None = None

    @property
    def is_tcf_canada(self) -> bool:
        return "tcf canada" in self.exam.lower()

    @property
    def is_sold_out(self) -> bool:
        spots = self.spots_left.lower()
        combined = f"{self.spots_left} {self.bookings}".lower()
        return bool(SOLD_OUT_STATUS_RE.search(combined) or ZERO_SPOTS_RE.fullmatch(spots))

    @property
    def is_booking_closed(self) -> bool:
        return bool(CLOSED_BOOKING_STATUS_RE.search(self.bookings.lower()))

    @property
    def has_booking_action(self) -> bool:
        link_text = " ".join(f"{link.text} {link.href}" for link in self.booking_links)
        combined = f"{self.spots_left} {self.bookings} {link_text}".lower()
        if EXPLICIT_BOOKING_ACTION_RE.search(combined):
            return True
        return bool(
            POSITIVE_BOOKING_STATUS_RE.search(combined)
            and not CLOSED_BOOKING_STATUS_RE.search(combined)
        )

    @property
    def is_available(self) -> bool:
        if self.available_override is not None:
            return self.available_override

        if self.is_sold_out:
            return False

        if self.has_booking_action:
            return True

        if self.is_booking_closed:
            return False

        if re.search(r"\b([1-9][0-9]*)\b", self.spots_left):
            return True

        return bool(self.booking_links)

    @property
    def key(self) -> str:
        if self.source_id:
            return stable_hash(f"{self.city}|{self.source_id}")

        # Preserve the original Edmonton keys so deployment does not reset its state.
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
                self.city,
                self.source_id,
                str(self.available_override),
            ]
        )
        return stable_hash(raw)


@dataclass(frozen=True)
class ParsedSchedulePage:
    rows: tuple[ExamRow, ...]
    show_more_href: str | None = None


@dataclass(frozen=True)
class AlertEvent:
    kind: str
    reason: str
    row: ExamRow


@dataclass(frozen=True)
class SourceFailure:
    city: str
    error: Exception


@dataclass(frozen=True)
class MultiCityFetchResult:
    rows: tuple[ExamRow, ...]
    successful_cities: tuple[str, ...]
    skipped_failures: tuple[SourceFailure, ...] = ()
    validation_failures: tuple[SourceFailure, ...] = ()


class FetchPageError(RuntimeError):
    pass


class SchedulePageError(RuntimeError):
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
        self.show_more_href: str | None = None
        self._current_row: list[Cell] | None = None
        self._cell_parts: list[str] | None = None
        self._cell_links: list[Link] | None = None
        self._current_link_href: str | None = None
        self._current_link_parts: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        attr_map = {name.lower(): value for name, value in attrs}
        if tag == "a":
            classes = (attr_map.get("class") or "").lower().split()
            if "datashowmore" in classes and attr_map.get("href"):
                self.show_more_href = attr_map["href"]

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
            self._current_link_href = attr_map.get("href") or ""
            self._current_link_parts = []
            return

        if tag in {"button", "input"}:
            value = attr_map.get("value") or attr_map.get("aria-label") or attr_map.get("title")
            if value:
                self._cell_parts.append(f" {value} ")
                if self._current_link_parts is not None:
                    self._current_link_parts.append(f" {value} ")

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


def redact_url(url: str) -> str:
    parts = urlsplit(url)
    query = [
        (name, "REDACTED" if name.upper() == "API_KEY" else value)
        for name, value in parse_qsl(parts.query, keep_blank_values=True)
    ]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def clean_exam_name(value: str) -> str:
    return clean_text(value.replace("TCF  Canada", "TCF Canada"))


def parse_schedule_page(html: str) -> ParsedSchedulePage:
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

    return ParsedSchedulePage(rows=tuple(rows), show_more_href=parser.show_more_href)


def parse_exam_rows(html: str) -> list[ExamRow]:
    return list(parse_schedule_page(html).rows)


def build_schedule_page_url(
    url: str,
    *,
    start: int = 0,
    page_size: int = DEFAULT_TABLE_PAGE_SIZE,
) -> str:
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query["s8-datatable1_rows"] = str(page_size)
    query["s8-datatable1_start"] = str(start)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


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


def fetch_json(
    url: str,
    timeout_seconds: int,
    *,
    attempts: int = DEFAULT_FETCH_ATTEMPTS,
    retry_delay_seconds: int = DEFAULT_RETRY_DELAY_SECONDS,
    headers: dict[str, str] | None = None,
) -> Any:
    display_url = redact_url(url)
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            request_headers = {
                "User-Agent": USER_AGENT,
                "Accept": "application/json",
            }
            request_headers.update(headers or {})
            response = requests.get(
                url,
                timeout=timeout_seconds,
                headers=request_headers,
            )
            response.raise_for_status()
            try:
                return response.json()
            except requests.exceptions.JSONDecodeError as exc:
                last_error = RuntimeError(
                    "non-JSON response "
                    f"(status={response.status_code}, "
                    f"content-type={response.headers.get('Content-Type', 'unknown')!r}, "
                    f"bytes={len(response.content)}): {exc}"
                )
                if attempt >= attempts:
                    break
                sleep_seconds = retry_delay_seconds * attempt
                logging.warning(
                    "JSON fetch attempt %s/%s returned unusable content for %s: %s. "
                    "Retrying in %ss.",
                    attempt,
                    attempts,
                    display_url,
                    last_error,
                    sleep_seconds,
                )
                time.sleep(sleep_seconds)
                continue
        except requests.RequestException as exc:
            last_error = exc
            if attempt >= attempts:
                break
            sleep_seconds = retry_delay_seconds * attempt
            logging.warning(
                "JSON fetch attempt %s/%s failed for %s: %s. Retrying in %ss.",
                attempt,
                attempts,
                display_url,
                exc,
                sleep_seconds,
            )
            time.sleep(sleep_seconds)

    raise FetchPageError(
        f"Failed to fetch {display_url} after {attempts} attempts: {last_error}"
    )


def fetch_schedule_rows(
    url: str,
    timeout_seconds: int,
    *,
    attempts: int = DEFAULT_FETCH_ATTEMPTS,
    retry_delay_seconds: int = DEFAULT_RETRY_DELAY_SECONDS,
    page_size: int = DEFAULT_TABLE_PAGE_SIZE,
) -> list[ExamRow]:
    if page_size < 1:
        raise ValueError("page_size must be positive.")

    page_url = build_schedule_page_url(url, start=0, page_size=page_size)
    seen_page_urls: set[str] = set()
    row_fingerprints: dict[str, str] = {}
    rows: list[ExamRow] = []
    pages_fetched = 0

    for page_number in range(MAX_TABLE_PAGES):
        if page_url in seen_page_urls:
            raise SchedulePageError(f"Schedule pagination loop detected at {page_url}.")
        seen_page_urls.add(page_url)

        html = fetch_page(
            page_url,
            timeout_seconds,
            attempts=attempts,
            retry_delay_seconds=retry_delay_seconds,
        )
        page = parse_schedule_page(html)
        pages_fetched += 1

        if page_number == 0 and not page.rows:
            raise SchedulePageError(
                "The schedule table could not be parsed. The page may be unavailable or its "
                "HTML structure may have changed."
            )

        for row in page.rows:
            previous_fingerprint = row_fingerprints.get(row.key)
            if previous_fingerprint is None:
                row_fingerprints[row.key] = row.fingerprint
                rows.append(row)
            elif previous_fingerprint != row.fingerprint:
                raise SchedulePageError(
                    f"Conflicting duplicate schedule row detected for {row.exam!r}."
                )

        if page.show_more_href:
            page_url = urljoin(page_url, page.show_more_href)
            continue

        if len(page.rows) >= page_size:
            page_url = build_schedule_page_url(
                url,
                start=(page_number + 1) * page_size,
                page_size=page_size,
            )
            continue

        break
    else:
        raise SchedulePageError(
            f"Schedule pagination exceeded the safety limit of {MAX_TABLE_PAGES} pages."
        )

    tcf_rows = [row for row in rows if row.is_tcf_canada]
    if not tcf_rows:
        raise SchedulePageError(
            "The parsed schedule contained no TCF Canada rows. Refusing to treat this as a "
            "successful check."
        )

    logging.info(
        "Fetched the complete schedule across %s page(s); parsed %s total exam rows.",
        pages_fetched,
        len(rows),
    )
    return rows


def parse_iso_datetime(value: str, *, field_name: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise SchedulePageError(f"Invalid {field_name} timestamp: {value!r}.") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def format_toronto_schedule(course: dict[str, Any]) -> str:
    patterns = course.get("date_patterns")
    if isinstance(patterns, list) and patterns and isinstance(patterns[0], dict):
        pattern = patterns[0]
        date = clean_text(str(pattern.get("activity_start_date") or ""))
        start = clean_text(str(pattern.get("activity_start_time") or ""))
        end = clean_text(str(pattern.get("activity_end_time") or ""))
        schedule = " ".join(value for value in (date, start) if value)
        if end:
            schedule = f"{schedule} - {end}" if schedule else end
        if schedule:
            return schedule
    return clean_text(str(course.get("start_date") or course.get("end_date") or ""))


def parse_toronto_courses(data: Any, *, checked_at: datetime) -> list[ExamRow]:
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise SchedulePageError("Toronto course feed did not contain an items list.")

    rows: list[ExamRow] = []
    for course in data["items"]:
        if not isinstance(course, dict):
            raise SchedulePageError("Toronto course feed contained a malformed item.")

        course_id = course.get("id")
        open_spaces = course.get("open_spaces")
        if course_id is None or not isinstance(open_spaces, (int, float)):
            raise SchedulePageError("Toronto course item is missing id or open_spaces.")

        deadline = clean_text(str(course.get("registration_deadline") or ""))
        if deadline and parse_iso_datetime(deadline, field_name="registration_deadline") <= checked_at:
            continue
        if open_spaces <= 0:
            continue

        campus = course.get("campus") if isinstance(course.get("campus"), dict) else {}
        location = clean_text(
            str(campus.get("full_name") or campus.get("name") or "Alliance Francaise Toronto")
        )
        price_value = course.get("price")
        price = f"${price_value:.2f}" if isinstance(price_value, (int, float)) else clean_text(
            str(price_value or "")
        )
        booking_url = f"https://ca.apm.activecommunities.com/aftoronto/Activity_Search/{course_id}"
        rows.append(
            ExamRow(
                exam=clean_exam_name(str(course.get("name") or "TCF Canada")),
                schedule=format_toronto_schedule(course),
                registration_dates=f"Open until {deadline}" if deadline else "Open now",
                location=location,
                spots_left=str(int(open_spaces) if float(open_spaces).is_integer() else open_spaces),
                price=price,
                bookings="Open",
                booking_links=(Link(text="Register", href=booking_url),),
                city="Toronto",
                page_url=TORONTO_PAGE_URL,
                source_id=f"course:{course_id}",
                available_override=True,
            )
        )
    return rows


def fetch_toronto_rows(
    timeout_seconds: int,
    *,
    attempts: int,
    retry_delay_seconds: int,
    checked_at: datetime,
) -> list[ExamRow]:
    query = urlencode(
        {
            "enddate": "gte",
            "status": "0",
            "openspaces": "1",
            "limit": "300",
            "othercategory": "367",
            "orderby": "course.startDate",
        }
    )
    data = fetch_json(
        f"{TORONTO_API_URL}?{query}",
        timeout_seconds,
        attempts=attempts,
        retry_delay_seconds=retry_delay_seconds,
        headers={
            "Origin": "https://www.alliance-francaise.ca",
            "Referer": TORONTO_PAGE_URL,
        },
    )
    return parse_toronto_courses(data, checked_at=checked_at)


def extract_aec_settings(html: str) -> tuple[str, str]:
    base_match = re.search(r'aec_app_url\s*=\s*["\']([^"\']+)', html)
    key_match = re.search(r'aecExtranetWebAppsAPIKey\s*=\s*["\']([^"\']+)', html)
    if not base_match or not key_match:
        raise SchedulePageError(
            "The official page no longer exposes the expected AEC registration settings."
        )
    return base_match.group(1).rstrip("/"), key_match.group(1)


def aec_spots_text(exam: dict[str, Any]) -> str:
    quantity = exam.get("qty_student")
    maximum = exam.get("max_student")
    if isinstance(quantity, (int, float)) and isinstance(maximum, (int, float)):
        return str(max(0, int(maximum - quantity)))
    return clean_text(str(exam.get("places_available") or ""))


def parse_aec_examinations(data: Any, *, city: str, page_url: str) -> list[ExamRow]:
    if not isinstance(data, list) or not data:
        raise SchedulePageError(f"{city} examination feed did not contain examination types.")

    rows: list[ExamRow] = []
    for examination_type in data:
        if not isinstance(examination_type, dict) or not isinstance(
            examination_type.get("examinations"), list
        ):
            raise SchedulePageError(f"{city} examination feed contained a malformed type.")

        for exam in examination_type["examinations"]:
            if not isinstance(exam, dict) or exam.get("IDEXAMINATION") is None:
                raise SchedulePageError(f"{city} examination feed contained a malformed session.")

            register = exam.get("mainRegisterLink")
            register = register if isinstance(register, dict) else {}
            booking_url = clean_text(str(register.get("link") or ""))
            blocked_reason = clean_text(str(register.get("cantRegisterReason") or ""))
            is_full = exam.get("isFull") is True
            can_register = bool(booking_url and not blocked_reason and not is_full)
            booking_links = (
                (Link(text="Register", href=booking_url),) if can_register else ()
            )
            bookings = "Open" if can_register else blocked_reason or "Closed"
            spots = "SOLD OUT!" if is_full else aec_spots_text(exam)

            date_text = clean_text(
                str(
                    exam.get("examination_coloquial_date")
                    or exam.get("examination_date_formatted")
                    or exam.get("examination_date")
                    or ""
                )
            )
            start = clean_text(str(exam.get("examination_start_time_formatted") or ""))
            end = clean_text(str(exam.get("examination_end_time_formatted") or ""))
            if start and end and (start, end) != ("00:00", "00:00"):
                date_text = f"{date_text}, {start} - {end}"

            rows.append(
                ExamRow(
                    exam=clean_exam_name(str(exam.get("product_name") or "TCF Canada")),
                    schedule=date_text,
                    registration_dates=clean_text(
                        str(
                            exam.get("examination_date_registration_formatted")
                            or " - ".join(
                                value
                                for value in (
                                    clean_text(str(exam.get("date_start_enroll") or "")),
                                    clean_text(str(exam.get("date_end_enroll") or "")),
                                )
                                if value
                            )
                        )
                    ),
                    location=clean_text(
                        str(exam.get("examination_location") or exam.get("location") or city)
                    ),
                    spots_left=spots,
                    price=clean_text(str(exam.get("price_formatted") or exam.get("price") or "")),
                    bookings=bookings,
                    booking_links=booking_links,
                    city=city,
                    page_url=page_url,
                    source_id=f"examination:{exam['IDEXAMINATION']}",
                    available_override=can_register,
                )
            )
    return rows


def fetch_aec_rows(
    *,
    city: str,
    page_url: str,
    branch_id: int,
    examination_type_ids: tuple[int, ...],
    timeout_seconds: int,
    attempts: int,
    retry_delay_seconds: int,
) -> list[ExamRow]:
    html = fetch_page(
        page_url,
        timeout_seconds,
        attempts=attempts,
        retry_delay_seconds=retry_delay_seconds,
    )
    base_url, api_key = extract_aec_settings(html)
    type_ids = quote("|".join(str(value) for value in examination_type_ids), safe="")
    endpoint = (
        f"{base_url}/api/v1/public/examinations/list/{branch_id}/{type_ids}?"
        f"{urlencode({'API_KEY': api_key})}"
    )
    data = fetch_json(
        endpoint,
        timeout_seconds,
        attempts=attempts,
        retry_delay_seconds=retry_delay_seconds,
    )
    return parse_aec_examinations(data, city=city, page_url=page_url)


def fetch_all_city_rows(
    edmonton_url: str,
    timeout_seconds: int,
    *,
    attempts: int,
    retry_delay_seconds: int,
    checked_at: datetime,
) -> MultiCityFetchResult:
    source_fetchers = (
        (
            "Edmonton",
            lambda: fetch_schedule_rows(
                edmonton_url,
                timeout_seconds,
                attempts=attempts,
                retry_delay_seconds=retry_delay_seconds,
            ),
        ),
        (
            "Toronto",
            lambda: fetch_toronto_rows(
                timeout_seconds,
                attempts=attempts,
                retry_delay_seconds=retry_delay_seconds,
                checked_at=checked_at,
            ),
        ),
        (
            "Montreal",
            lambda: fetch_aec_rows(
                city="Montreal",
                page_url=MONTREAL_PAGE_URL,
                branch_id=0,
                examination_type_ids=(10,),
                timeout_seconds=timeout_seconds,
                attempts=attempts,
                retry_delay_seconds=retry_delay_seconds,
            ),
        ),
        (
            "Ottawa",
            lambda: fetch_aec_rows(
                city="Ottawa",
                page_url=OTTAWA_PAGE_URL,
                branch_id=1,
                examination_type_ids=(5, 79),
                timeout_seconds=timeout_seconds,
                attempts=attempts,
                retry_delay_seconds=retry_delay_seconds,
            ),
        ),
    )

    rows: list[ExamRow] = []
    successful_cities: list[str] = []
    skipped_failures: list[SourceFailure] = []
    validation_failures: list[SourceFailure] = []
    for city, fetcher in source_fetchers:
        try:
            city_rows = fetcher()
        except FetchPageError as exc:
            skipped_failures.append(SourceFailure(city=city, error=exc))
            report_skipped_fetch(exc, city=city)
            continue
        except SchedulePageError as exc:
            validation_failures.append(SourceFailure(city=city, error=exc))
            logging.error("%s validation failed: %s", city, exc)
            continue

        successful_cities.append(city)
        rows.extend(city_rows)
        logging.info("%s: %s", city, summarize_rows(city_rows))

    if not successful_cities and skipped_failures and not validation_failures:
        raise FetchPageError("Every city fetch failed after all retries; state was preserved.")

    return MultiCityFetchResult(
        rows=tuple(rows),
        successful_cities=tuple(successful_cities),
        skipped_failures=tuple(skipped_failures),
        validation_failures=tuple(validation_failures),
    )


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": 2, "seen": {}}
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
    active_cities: set[str] | None = None,
) -> tuple[list[AlertEvent], dict[str, Any]]:
    row_list = list(rows)
    next_state = copy.deepcopy(state)
    seen = next_state.setdefault("seen", {})
    existing_cities = {
        clean_text(str(value.get("city") or "Edmonton"))
        for value in seen.values()
        if isinstance(value, dict)
    }
    checked_cities = active_cities or {row.city for row in row_list}
    events: list[AlertEvent] = []

    current_keys: set[str] = set()
    for row in row_list:
        if not row.is_tcf_canada:
            continue

        first_city_run = row.city not in existing_cities
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
                "city": row.city,
                "page_url": row.page_url,
                "source_id": row.source_id,
                "notified_new": bool(first_city_run and not alert_on_first_run),
                "notified_available": False,
            }
            seen[row.key] = previous

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
            and (not first_city_run or alert_on_first_run)
        ):
            events.append(
                AlertEvent(
                    kind="new_session",
                    reason="A new TCF Canada session was posted to the schedule table.",
                    row=row,
                )
            )

        if not row.is_available:
            previous["notified_available"] = False

        previous.update(
            {
                "fingerprint": row.fingerprint,
                "exam": row.exam,
                "schedule": row.schedule,
                "registration_dates": row.registration_dates,
                "location": row.location,
                "spots_left": row.spots_left,
                "bookings": row.bookings,
                "city": row.city,
                "page_url": row.page_url,
                "source_id": row.source_id,
                "last_seen_at": checked_at,
            }
        )
        previous.pop("last_missing_at", None)

    for key, value in seen.items():
        city = clean_text(str(value.get("city") or "Edmonton"))
        if city in checked_cities and key not in current_keys:
            value["last_missing_at"] = checked_at
            value["notified_available"] = False

    next_state["last_checked_at"] = checked_at
    last_checked_by_city = next_state.setdefault("last_checked_at_by_city", {})
    for city in checked_cities:
        last_checked_by_city[city] = checked_at
    next_state["version"] = 2
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


def report_skipped_fetch(exc: FetchPageError, *, city: str | None = None) -> None:
    city_label = f" for {city}" if city else ""
    logging.warning("%s", exc)
    logging.warning("Treating the exhausted network fetch%s as a skipped check.", city_label)
    if env_bool("GITHUB_ACTIONS", default=False):
        print(
            f"::warning title=TCF page temporarily unavailable{city_label}::"
            "The network fetch failed after all retries. This city was skipped and its "
            "previous monitor state was preserved."
        )


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
        return "[TCF Canada] No availability changes"
    if len(events) == 1:
        event = events[0]
        return f"[TCF Canada - {event.row.city}] {event.row.exam}: {event.kind.replace('_', ' ')}"
    cities = ", ".join(sorted({event.row.city for event in events}))
    return f"[TCF Canada] {len(events)} available sessions ({cities})"


def build_alert_body(
    events: list[AlertEvent], *, checked_at: str, page_url: str | None = None
) -> str:
    if not events:
        page_line = f"\n\nPage: {page_url}" if page_url else ""
        return f"No TCF Canada availability changes were detected at {checked_at}.{page_line}\n"

    parts = [
        "TCF Canada schedule alert",
        "",
        f"Checked at: {checked_at}",
        "",
    ]
    for index, event in enumerate(events, start=1):
        row = event.row
        parts.extend(
            [
                f"{index}. {event.reason}",
                f"City: {row.city}",
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
                    f"{link.text or 'link'} ({urljoin(row.page_url, link.href)})"
                    for link in row.booking_links
                )
            )
        parts.append(f"Official page: {row.page_url}")
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
    checked_at_datetime = datetime.now(timezone.utc)
    checked_at = checked_at_datetime.isoformat(timespec="seconds")
    state_path = Path(args.state_file).expanduser()
    state = load_state(state_path)

    result = fetch_all_city_rows(
        args.url,
        args.timeout_seconds,
        attempts=args.fetch_attempts,
        retry_delay_seconds=args.retry_delay_seconds,
        checked_at=checked_at_datetime,
    )
    events, next_state = detect_events(
        result.rows,
        state,
        checked_at=checked_at,
        alert_new_sessions=args.alert_new_sessions and not args.no_alert_new_sessions,
        alert_on_first_run=args.alert_on_first_run,
        active_cities=set(result.successful_cities),
    )

    if events:
        body = build_alert_body(events, checked_at=checked_at)
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

    if result.validation_failures:
        details = "; ".join(
            f"{failure.city}: {failure.error}" for failure in result.validation_failures
        )
        raise SchedulePageError(
            "One or more official feeds could not be validated after healthy city state "
            f"was processed: {details}"
        )
    return 0


def run_watch(args: argparse.Namespace) -> int:
    if args.interval_seconds < MIN_INTERVAL_SECONDS:
        raise RuntimeError(f"--interval-seconds must be at least {MIN_INTERVAL_SECONDS}.")

    logging.info("Watching all configured TCF Canada cities every ~%s seconds.", args.interval_seconds)
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
            city="Test",
            page_url=args.url,
        ),
    )
    body = build_alert_body([event], page_url=args.url, checked_at=checked_at)
    subject = "[TCF Canada] Test alert"
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
        description="Monitor official TCF Canada registration feeds in multiple cities."
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
        "--alert-new-sessions",
        action="store_true",
        help="Also alert when a new TCF Canada row is posted, even if it is closed.",
    )
    parser.add_argument(
        "--no-alert-new-sessions",
        action="store_true",
        help="Deprecated compatibility flag. New closed rows are ignored by default.",
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
            report_skipped_fetch(exc)
            return 0
        logging.error("%s", exc)
        return 1
    except Exception as exc:
        logging.error("%s", exc)
        return 1


if __name__ == "__main__":
    sys.exit(main())
