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
TORONTO_ACTIVENET_URL = "https://anc.ca.apm.activecommunities.com/aftoronto"
MONTREAL_PAGE_URL = "https://www.afmontreal.ca/en/tcf-2/"
OTTAWA_PAGE_URL = "https://af.ca/ottawa/en/tests_et_examens/tcf/"
MONTREAL_AEC_SETTINGS_URL = (
    "https://afmontreal.extranet-aec.com/examinations/"
    "examination_type_detail?examinationTypeId=10"
)
MONTREAL_AEC_API_URL = "https://afmontreal.aec.app"
OTTAWA_AEC_SETTINGS_URL = (
    "https://afottawa.extranet-aec.com/examinations/"
    "examination_type_detail?examinationTypeId=5"
)
OTTAWA_AEC_API_URL = "https://afottawa.aec.app"
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
ACTIVENET_ENROLL_ACTION_RE = re.compile(r"/activity/(?:search/)?enroll", re.IGNORECASE)
TORONTO_EXAM_NAME = "e-tcf canada - 4 modules"


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
    json_body: dict[str, Any] | None = None,
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
            request = requests.post if json_body is not None else requests.get
            request_options: dict[str, Any] = {
                "timeout": timeout_seconds,
                "headers": request_headers,
            }
            if json_body is not None:
                request_options["json"] = json_body
            response = request(url, **request_options)
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


def parse_activenet_search_page(
    data: Any, *, expected_page_number: int | None = None
) -> tuple[list[dict[str, Any]], int]:
    if not isinstance(data, dict):
        raise SchedulePageError("Toronto ActiveNet search response was not an object.")
    headers = data.get("headers")
    if not isinstance(headers, dict) or headers.get("response_code") != "0000":
        raise SchedulePageError("Toronto ActiveNet search was not successful.")
    page_info = headers.get("page_info")
    total_pages = page_info.get("total_page") if isinstance(page_info, dict) else None
    total_records = page_info.get("total_records") if isinstance(page_info, dict) else None
    records_per_page = (
        page_info.get("total_records_per_page") if isinstance(page_info, dict) else None
    )
    page_number = page_info.get("page_number") if isinstance(page_info, dict) else None
    if (
        not isinstance(total_pages, int)
        or total_pages < 1
        or total_pages > MAX_TABLE_PAGES
        or not isinstance(total_records, int)
        or total_records < 0
        or not isinstance(records_per_page, int)
        or records_per_page < 1
        or not isinstance(page_number, int)
        or page_number < 1
    ):
        raise SchedulePageError("Toronto ActiveNet search returned invalid pagination.")
    if expected_page_number is not None and page_number != expected_page_number:
        raise FetchPageError(
            "Toronto ActiveNet returned the wrong search page "
            f"({page_number} instead of {expected_page_number})."
        )

    body = data.get("body")
    items = body.get("activity_items") if isinstance(body, dict) else None
    if not isinstance(items, list):
        raise SchedulePageError("Toronto ActiveNet search contained no activity list.")
    expected_items = min(
        records_per_page,
        max(0, total_records - ((page_number - 1) * records_per_page)),
    )
    if len(items) != expected_items:
        raise FetchPageError(
            "Toronto ActiveNet returned an incomplete search page "
            f"({len(items)} of {expected_items} reported activities)."
        )

    candidates: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            raise SchedulePageError("Toronto ActiveNet search contained a malformed activity.")
        if clean_text(str(item.get("name") or "")).lower() != TORONTO_EXAM_NAME:
            continue
        course_id = item.get("id")
        sub_count = item.get("num_of_sub_activities")
        if (
            not isinstance(course_id, int)
            or isinstance(course_id, bool)
            or not isinstance(sub_count, int)
            or isinstance(sub_count, bool)
            or sub_count < 0
        ):
            raise SchedulePageError(
                "Toronto ActiveNet exam activity is missing its id or sub-course count."
            )
        candidates.append(item)
    return candidates, total_pages


def fetch_activenet_search_page(
    url: str,
    timeout_seconds: int,
    *,
    attempts: int,
    retry_delay_seconds: int,
    headers: dict[str, str],
    json_body: dict[str, Any],
    expected_page_number: int,
) -> tuple[list[dict[str, Any]], int]:
    last_error: FetchPageError | None = None
    for attempt in range(1, attempts + 1):
        try:
            data = fetch_json(
                url,
                timeout_seconds,
                attempts=1,
                retry_delay_seconds=retry_delay_seconds,
                headers=headers,
                json_body=json_body,
            )
            return parse_activenet_search_page(
                data, expected_page_number=expected_page_number
            )
        except FetchPageError as exc:
            last_error = exc
            if attempt >= attempts:
                break
            sleep_seconds = retry_delay_seconds * attempt
            logging.warning(
                "Toronto ActiveNet search attempt %s/%s returned incomplete data: %s "
                "Retrying in %ss.",
                attempt,
                attempts,
                exc,
                sleep_seconds,
            )
            time.sleep(sleep_seconds)

    raise FetchPageError(
        f"Toronto ActiveNet search remained incomplete after {attempts} attempts: "
        f"{last_error}"
    )


def record_activenet_candidate(
    candidates_by_id: dict[int, dict[str, Any]], candidate: dict[str, Any]
) -> None:
    course_id = candidate["id"]
    previous = candidates_by_id.get(course_id)
    if previous is None:
        candidates_by_id[course_id] = candidate
        return

    previous_name = clean_text(str(previous.get("name") or "")).lower()
    candidate_name = clean_text(str(candidate.get("name") or "")).lower()
    previous_number = clean_text(str(previous.get("number") or ""))
    candidate_number = clean_text(str(candidate.get("number") or ""))
    if previous_name != candidate_name or (
        previous_number and candidate_number and previous_number != candidate_number
    ):
        raise SchedulePageError(
            f"Toronto ActiveNet returned conflicting identity for course {course_id}."
        )

    merged = previous.copy()
    for key, value in candidate.items():
        if key not in merged or merged[key] in (None, "", [], {}):
            merged[key] = value
    candidates_by_id[course_id] = merged


def parse_activenet_subactivities(
    data: Any, *, parent_id: int, expected_count: int
) -> list[dict[str, Any]]:
    if not isinstance(data, dict):
        raise SchedulePageError(
            f"Toronto ActiveNet sub-courses for {parent_id} were not an object."
        )
    headers = data.get("headers")
    if not isinstance(headers, dict) or headers.get("response_code") != "0000":
        raise SchedulePageError(
            f"Toronto ActiveNet sub-course search for {parent_id} was not successful."
        )
    body = data.get("body")
    items = body.get("sub_activities") if isinstance(body, dict) else None
    if not isinstance(items, list):
        raise SchedulePageError(
            f"Toronto ActiveNet parent course {parent_id} had no sub-course list."
        )
    if len(items) != expected_count:
        raise FetchPageError(
            f"Toronto ActiveNet parent course {parent_id} returned "
            f"{len(items)} of {expected_count} reported sub-courses."
        )

    candidates: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            raise SchedulePageError(
                f"Toronto ActiveNet parent course {parent_id} had a malformed sub-course."
            )
        if clean_text(str(item.get("name") or "")).lower() != TORONTO_EXAM_NAME:
            continue
        course_id = item.get("id")
        if not isinstance(course_id, int) or isinstance(course_id, bool):
            raise SchedulePageError(
                f"Toronto ActiveNet parent course {parent_id} had a sub-course without an id."
            )
        candidates.append(item)
    if not candidates:
        raise SchedulePageError(
            f"Toronto ActiveNet parent course {parent_id} had no TCF Canada sub-courses."
        )
    return candidates


def fetch_activenet_subactivities(
    url: str,
    timeout_seconds: int,
    *,
    attempts: int,
    retry_delay_seconds: int,
    headers: dict[str, str],
    parent_id: int,
    expected_count: int,
) -> list[dict[str, Any]]:
    last_error: FetchPageError | None = None
    for attempt in range(1, attempts + 1):
        try:
            data = fetch_json(
                url,
                timeout_seconds,
                attempts=1,
                retry_delay_seconds=retry_delay_seconds,
                headers=headers,
                json_body={},
            )
            return parse_activenet_subactivities(
                data,
                parent_id=parent_id,
                expected_count=expected_count,
            )
        except FetchPageError as exc:
            last_error = exc
            if attempt >= attempts:
                break
            sleep_seconds = retry_delay_seconds * attempt
            logging.warning(
                "Toronto ActiveNet sub-course attempt %s/%s failed or returned "
                "incomplete data for parent %s: %s Retrying in %ss.",
                attempt,
                attempts,
                parent_id,
                exc,
                sleep_seconds,
            )
            time.sleep(sleep_seconds)

    raise FetchPageError(
        f"Toronto ActiveNet sub-courses for parent {parent_id} remained unavailable "
        f"after {attempts} attempts: {last_error}"
    )


def parse_activenet_detail(
    data: Any,
    *,
    candidate: dict[str, Any],
    action_href: str,
) -> ExamRow:
    course_id = candidate["id"]
    if not isinstance(data, dict):
        raise SchedulePageError(
            f"Toronto ActiveNet detail for course {course_id} was not an object."
        )
    headers = data.get("headers")
    body = data.get("body")
    detail = body.get("detail") if isinstance(body, dict) else None
    if (
        not isinstance(headers, dict)
        or headers.get("response_code") != "0000"
        or not isinstance(detail, dict)
        or detail.get("activity_id") != course_id
    ):
        raise SchedulePageError(
            f"Toronto ActiveNet detail for course {course_id} was not successful."
        )
    exam_name = clean_exam_name(str(detail.get("activity_name") or ""))
    if exam_name.lower() != TORONTO_EXAM_NAME:
        raise SchedulePageError(
            f"Toronto ActiveNet detail for course {course_id} was not a TCF Canada exam."
        )

    first_date = clean_text(str(detail.get("first_date") or ""))
    last_date = clean_text(str(detail.get("last_date") or ""))
    schedule = first_date
    if last_date and last_date != first_date:
        schedule = f"{first_date} - {last_date}" if first_date else last_date
    if not schedule:
        schedule = clean_text(
            str(candidate.get("date_range") or candidate.get("number") or "")
        )

    location_data = candidate.get("location")
    location_data = location_data if isinstance(location_data, dict) else {}
    fee_data = candidate.get("fee")
    fee_data = fee_data if isinstance(fee_data, dict) else {}
    booking_url = urljoin(f"{TORONTO_ACTIVENET_URL}/", action_href)
    return ExamRow(
        exam=exam_name,
        schedule=schedule,
        registration_dates="Open now; final enrollment action verified",
        location=clean_text(
            str(
                detail.get("location_description")
                or location_data.get("label")
                or "Alliance Francaise Toronto"
            )
        ),
        spots_left=clean_text(str(detail.get("space_status") or "Available")),
        price=clean_text(str(fee_data.get("label") or "")),
        bookings="Open on ActiveNet",
        booking_links=(Link(text="Register", href=booking_url),),
        city="Toronto",
        page_url=TORONTO_PAGE_URL,
        source_id=f"course:{course_id}",
        available_override=True,
    )


def fetch_toronto_rows(
    timeout_seconds: int,
    *,
    attempts: int,
    retry_delay_seconds: int,
    checked_at: datetime,
) -> list[ExamRow]:
    del checked_at  # ActiveNet's search already limits results to current and future courses.
    request_headers = {
        "Origin": "https://anc.ca.apm.activecommunities.com",
        "Referer": (
            f"{TORONTO_ACTIVENET_URL}/activity/search?onlineSiteId=0&"
            "activity_select_param=2&activity_keyword=TCF&viewMode=list"
        ),
    }
    search_url = f"{TORONTO_ACTIVENET_URL}/rest/activities/list"
    parent_candidates: list[dict[str, Any]] = []
    expected_pages: int | None = None
    for page_number in range(1, MAX_TABLE_PAGES + 1):
        page_headers = {
            **request_headers,
            # ActiveNet's web client transmits pagination as a JSON HTTP header.
            "page_info": json.dumps(
                {
                    "page_number": page_number,
                    "total_records_per_page": 20,
                    "order_by": "Name",
                },
                separators=(",", ":"),
            ),
        }
        page_candidates, total_pages = fetch_activenet_search_page(
            search_url,
            timeout_seconds,
            attempts=attempts,
            retry_delay_seconds=retry_delay_seconds,
            headers=page_headers,
            json_body={
                "activity_search_pattern": {
                    "activity_keyword": "TCF",
                    "activity_select_param": "2",
                },
                "activity_transfer_pattern": {},
            },
            expected_page_number=page_number,
        )
        if expected_pages is None:
            expected_pages = total_pages
        elif total_pages != expected_pages:
            raise FetchPageError("Toronto ActiveNet pagination changed during the check.")
        parent_candidates.extend(page_candidates)
        if page_number >= total_pages:
            break
    else:
        raise SchedulePageError("Toronto ActiveNet search exceeded the pagination limit.")

    candidates_by_id: dict[int, dict[str, Any]] = {}
    for candidate in parent_candidates:
        course_id = candidate["id"]
        if candidate["num_of_sub_activities"]:
            leaf_candidates = fetch_activenet_subactivities(
                f"{TORONTO_ACTIVENET_URL}/rest/activities/subs/{course_id}",
                timeout_seconds,
                attempts=attempts,
                retry_delay_seconds=retry_delay_seconds,
                headers=request_headers,
                parent_id=course_id,
                expected_count=candidate["num_of_sub_activities"],
            )
        else:
            leaf_candidates = [candidate]

        for leaf in leaf_candidates:
            record_activenet_candidate(candidates_by_id, leaf)

    verified: list[ExamRow] = []
    for course_id, candidate in candidates_by_id.items():
        status_data = fetch_json(
            f"{TORONTO_ACTIVENET_URL}/rest/activity/detail/buttonstatus/{course_id}?",
            timeout_seconds,
            attempts=attempts,
            retry_delay_seconds=retry_delay_seconds,
            headers={
                "Referer": (
                    f"{TORONTO_ACTIVENET_URL}/activity/search/detail/{course_id}"
                    "?onlineSiteId=0&from_original_cui=true"
                ),
            },
        )
        is_available, notification, action_href = parse_activenet_button_status(
            status_data, course_id=course_id
        )
        if not is_available:
            urgency = candidate.get("urgent_message")
            urgency = urgency if isinstance(urgency, dict) else {}
            logging.info(
                "Toronto course %s rejected by final ActiveNet status: %s",
                course_id,
                notification
                or clean_text(str(urgency.get("status_description") or ""))
                or "no enrollment action",
            )
            continue

        detail_data = fetch_json(
            f"{TORONTO_ACTIVENET_URL}/rest/activity/detail/{course_id}?",
            timeout_seconds,
            attempts=attempts,
            retry_delay_seconds=retry_delay_seconds,
            headers={
                "Referer": (
                    f"{TORONTO_ACTIVENET_URL}/activity/search/detail/{course_id}"
                    "?onlineSiteId=0&from_original_cui=true"
                ),
            },
        )
        verified.append(
            parse_activenet_detail(
                detail_data,
                candidate=candidate,
                action_href=action_href,
            )
        )

    logging.info(
        "Toronto final verification accepted %s of %s candidate course(s).",
        len(verified),
        len(candidates_by_id),
    )
    return verified


def parse_activenet_button_status(
    data: Any, *, course_id: str | int
) -> tuple[bool, str, str]:
    if not isinstance(data, dict):
        raise SchedulePageError(
            f"Toronto ActiveNet status for course {course_id} was not an object."
        )
    headers = data.get("headers")
    if not isinstance(headers, dict) or headers.get("response_code") != "0000":
        raise SchedulePageError(
            f"Toronto ActiveNet status for course {course_id} was not successful."
        )
    body = data.get("body")
    status = body.get("button_status") if isinstance(body, dict) else None
    if not isinstance(status, dict):
        raise SchedulePageError(
            f"Toronto ActiveNet status for course {course_id} had no button_status."
        )

    action = status.get("action_link")
    action = action if isinstance(action, dict) else {}
    action_href = clean_text(str(action.get("href") or ""))
    notification = clean_text(str(status.get("notification") or ""))
    return (
        bool(ACTIVENET_ENROLL_ACTION_RE.search(action_href)),
        notification,
        action_href,
    )


def extract_aec_settings(
    html: str, *, default_base_url: str | None = None
) -> tuple[str, str]:
    base_match = re.search(r'aec_app_url\s*=\s*["\']([^"\']+)', html)
    key_match = re.search(r'aecExtranetWebAppsAPIKey\s*=\s*["\']([^"\']+)', html)
    base_url = base_match.group(1) if base_match else default_base_url
    if not base_url or not key_match:
        raise SchedulePageError(
            "The official page no longer exposes the expected AEC registration settings."
        )
    return base_url.rstrip("/"), key_match.group(1)


def fetch_aec_settings(
    page_url: str,
    timeout_seconds: int,
    *,
    attempts: int,
    retry_delay_seconds: int,
    default_base_url: str | None = None,
) -> tuple[str, str]:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            html = fetch_page(
                page_url,
                timeout_seconds,
                attempts=1,
                retry_delay_seconds=retry_delay_seconds,
            )
            return extract_aec_settings(html, default_base_url=default_base_url)
        except (FetchPageError, SchedulePageError) as exc:
            last_error = exc
            if attempt >= attempts:
                break
            sleep_seconds = retry_delay_seconds * attempt
            logging.warning(
                "AEC settings attempt %s/%s failed for %s: %s. Retrying in %ss.",
                attempt,
                attempts,
                page_url,
                exc,
                sleep_seconds,
            )
            time.sleep(sleep_seconds)

    raise FetchPageError(
        f"Failed to load AEC registration settings from {page_url} after "
        f"{attempts} attempts: {last_error}"
    )


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
    settings_page_url: str | None = None,
    api_base_url: str | None = None,
) -> list[ExamRow]:
    base_url, api_key = fetch_aec_settings(
        settings_page_url or page_url,
        timeout_seconds,
        attempts=attempts,
        retry_delay_seconds=retry_delay_seconds,
        default_base_url=api_base_url,
    )
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
                settings_page_url=MONTREAL_AEC_SETTINGS_URL,
                api_base_url=MONTREAL_AEC_API_URL,
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
                settings_page_url=OTTAWA_AEC_SETTINGS_URL,
                api_base_url=OTTAWA_AEC_API_URL,
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
