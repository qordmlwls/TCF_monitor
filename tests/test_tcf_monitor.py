import sys
import unittest
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

sys.path.append(str(Path(__file__).parent.parent))

from tools.tcf_monitor import (
    ExamRow,
    FetchPageError,
    Link,
    SchedulePageError,
    detect_events,
    extract_aec_settings,
    fetch_all_city_rows,
    fetch_schedule_rows,
    main,
    mark_events_sent,
    parse_aec_examinations,
    parse_exam_rows,
    parse_toronto_courses,
)


FIXTURE_HTML = """
<html>
  <body>
    <table id="s8-datatable1">
      <tr>
        <th>Exam</th>
        <th>Schedules</th>
        <th>Registration Dates</th>
        <th>Location</th>
        <th>Spots left</th>
        <th>Price</th>
        <th>Bookings</th>
      </tr>
      <tr>
        <td><span class="es-exam-title">TCF  Canada - July 3</span></td>
        <td><span>Friday 03 Jul 2026 - 9:40am to 12:40pm</span><br><span>Oral To be confirmed</span></td>
        <td>May 13 2026 9:00am -<br>May 13 2026 9:50am</td>
        <td>Alliance Francaise of Edmonton - Kingsway</td>
        <td><strong><span class="es-sold-out">SOLD OUT!</span></strong></td>
        <td>$400.00</td>
        <td><span class="es-status es-status-closed">Closed</span></td>
      </tr>
      <tr>
        <td>TCF Canada - August 10</td>
        <td>Monday 10 Aug 2026 - 9:40am to 12:40pm</td>
        <td>June 1 2026 9:00am - June 1 2026 10:00am</td>
        <td>Alliance Francaise of Edmonton - Kingsway</td>
        <td>3</td>
        <td>$400.00</td>
        <td><a href="/products/tcf-canada-august-10/">Register</a></td>
      </tr>
      <tr>
        <td>TCF Quebec - August 12</td>
        <td>Wednesday 12 Aug 2026</td>
        <td>June 2 2026</td>
        <td>Alliance Francaise of Edmonton - Kingsway</td>
        <td>1</td>
        <td>$400.00</td>
        <td><a href="/products/tcf-quebec-august-12/">Register</a></td>
      </tr>
    </table>
  </body>
</html>
"""


class TcfMonitorTest(unittest.TestCase):
    def test_parse_exam_rows_extracts_tcf_canada_rows(self):
        rows = parse_exam_rows(FIXTURE_HTML)

        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0].exam, "TCF Canada - July 3")
        self.assertTrue(rows[0].is_tcf_canada)
        self.assertTrue(rows[0].is_sold_out)
        self.assertFalse(rows[0].is_available)
        self.assertTrue(rows[1].is_available)
        self.assertEqual(rows[1].booking_links[0].href, "/products/tcf-canada-august-10/")

    def test_register_link_overrides_stale_closed_text(self):
        mixed_status_html = FIXTURE_HTML.replace(
            """<td><a href="/products/tcf-canada-august-10/">Register</a></td>""",
            """<td><span class="es-status es-status-closed">Closed</span> <a href="/products/tcf-canada-august-10/">Register</a></td>""",
        )

        rows = parse_exam_rows(mixed_status_html)

        self.assertTrue(rows[1].is_available)

    def test_register_input_button_counts_available(self):
        input_button_html = FIXTURE_HTML.replace(
            """<td><a href="/products/tcf-canada-august-10/">Register</a></td>""",
            """<td><form><input type="submit" value="Register"></form></td>""",
        )

        rows = parse_exam_rows(input_button_html)

        self.assertEqual(rows[1].bookings, "Register")
        self.assertTrue(rows[1].is_available)

    def test_sold_out_still_suppresses_register_action(self):
        sold_out_with_link_html = FIXTURE_HTML.replace(
            """<td>3</td>
        <td>$400.00</td>
        <td><a href="/products/tcf-canada-august-10/">Register</a></td>""",
            """<td>SOLD OUT!</td>
        <td>$400.00</td>
        <td><span class="es-status es-status-closed">Closed</span> <a href="/products/tcf-canada-august-10/">Register</a></td>""",
        )

        rows = parse_exam_rows(sold_out_with_link_html)

        self.assertFalse(rows[1].is_available)

    def test_negative_availability_wording_does_not_alert(self):
        not_available_html = FIXTURE_HTML.replace(
            """<td><a href="/products/tcf-canada-august-10/">Register</a></td>""",
            """<td>Not available</td>""",
        )

        rows = parse_exam_rows(not_available_html)

        self.assertFalse(rows[1].is_available)
        self.assertFalse(
            replace(rows[1], spots_left="3", bookings="Fully booked").is_available
        )

    def test_fetch_schedule_rows_follows_show_more_link(self):
        first_page = FIXTURE_HTML.replace(
            "</body>",
            """<a class="dataShowMore" href="/en/exams/tcf/?s8-datatable1_rows=200&amp;s8-datatable1_start=3">Show More</a></body>""",
        )
        second_page = FIXTURE_HTML.replace("July 3", "September 1").replace(
            "August 10", "September 2"
        )

        with patch(
            "tools.tcf_monitor.fetch_page",
            side_effect=[first_page, second_page],
        ) as fetch_mock:
            rows = fetch_schedule_rows(
                "https://www.afedmonton.com/en/exams/tcf/",
                20,
            )

        self.assertEqual(len(rows), 5)
        self.assertEqual(sum(row.is_tcf_canada for row in rows), 4)
        self.assertEqual(fetch_mock.call_count, 2)
        self.assertIn("s8-datatable1_rows=200", fetch_mock.call_args_list[0].args[0])
        self.assertIn("s8-datatable1_start=0", fetch_mock.call_args_list[0].args[0])
        self.assertIn("s8-datatable1_start=3", fetch_mock.call_args_list[1].args[0])

    def test_fetch_schedule_rows_rejects_unparseable_page(self):
        with patch(
            "tools.tcf_monitor.fetch_page",
            return_value="<html><body>Maintenance</body></html>",
        ):
            with self.assertRaises(SchedulePageError):
                fetch_schedule_rows(
                    "https://www.afedmonton.com/en/exams/tcf/",
                    20,
                )

    def test_first_run_baselines_closed_rows_but_alerts_available_rows(self):
        rows = parse_exam_rows(FIXTURE_HTML)
        events, state = detect_events(
            rows,
            {"version": 1, "seen": {}},
            checked_at="2026-06-02T00:00:00+00:00",
            alert_new_sessions=False,
            alert_on_first_run=False,
        )

        self.assertEqual([event.kind for event in events], ["available"])
        self.assertEqual(len(state["seen"]), 2)

    def test_available_session_realerts_after_closing_and_reopening(self):
        available_row = parse_exam_rows(FIXTURE_HTML)[1]
        first_events, state = detect_events(
            [available_row],
            {"version": 1, "seen": {}},
            checked_at="2026-06-02T00:00:00+00:00",
            alert_new_sessions=False,
            alert_on_first_run=False,
        )
        mark_events_sent(state, first_events, "2026-06-02T00:00:00+00:00")

        closed_row = replace(
            available_row,
            spots_left="SOLD OUT!",
            bookings="Closed",
            booking_links=(),
        )
        closed_events, state = detect_events(
            [closed_row],
            state,
            checked_at="2026-06-02T00:05:00+00:00",
            alert_new_sessions=False,
            alert_on_first_run=False,
        )
        reopened_events, _ = detect_events(
            [available_row],
            state,
            checked_at="2026-06-02T00:10:00+00:00",
            alert_new_sessions=False,
            alert_on_first_run=False,
        )

        self.assertEqual(closed_events, [])
        self.assertEqual([event.kind for event in reopened_events], ["available"])

    def test_new_tcf_canada_session_alerts_after_baseline(self):
        baseline_rows = parse_exam_rows(
            FIXTURE_HTML.replace("TCF Canada - August 10", "TCF Quebec - August 10")
        )
        _, state = detect_events(
            baseline_rows,
            {"version": 1, "seen": {}},
            checked_at="2026-06-02T00:00:00+00:00",
            alert_new_sessions=False,
            alert_on_first_run=False,
        )

        rows = parse_exam_rows(FIXTURE_HTML)
        events, _ = detect_events(
            rows,
            state,
            checked_at="2026-06-02T00:05:00+00:00",
            alert_new_sessions=False,
            alert_on_first_run=False,
        )

        self.assertEqual([event.kind for event in events], ["available"])

    def test_new_closed_tcf_canada_session_does_not_alert_by_default(self):
        closed_new_html = FIXTURE_HTML.replace(
            """<td>3</td>
        <td>$400.00</td>
        <td><a href="/products/tcf-canada-august-10/">Register</a></td>""",
            """<td>SOLD OUT!</td>
        <td>$400.00</td>
        <td>Closed</td>""",
        )
        baseline_rows = parse_exam_rows(
            closed_new_html.replace("TCF Canada - August 10", "TCF Quebec - August 10")
        )
        _, state = detect_events(
            baseline_rows,
            {"version": 1, "seen": {}},
            checked_at="2026-06-02T00:00:00+00:00",
            alert_new_sessions=False,
            alert_on_first_run=False,
        )

        rows = parse_exam_rows(closed_new_html)
        events, _ = detect_events(
            rows,
            state,
            checked_at="2026-06-02T00:05:00+00:00",
            alert_new_sessions=False,
            alert_on_first_run=False,
        )

        self.assertEqual(events, [])

    def test_new_closed_tcf_canada_session_can_be_opted_in(self):
        closed_new_html = FIXTURE_HTML.replace(
            """<td>3</td>
        <td>$400.00</td>
        <td><a href="/products/tcf-canada-august-10/">Register</a></td>""",
            """<td>SOLD OUT!</td>
        <td>$400.00</td>
        <td>Closed</td>""",
        )
        baseline_rows = parse_exam_rows(
            closed_new_html.replace("TCF Canada - August 10", "TCF Quebec - August 10")
        )
        _, state = detect_events(
            baseline_rows,
            {"version": 1, "seen": {}},
            checked_at="2026-06-02T00:00:00+00:00",
            alert_new_sessions=True,
            alert_on_first_run=False,
        )

        rows = parse_exam_rows(closed_new_html)
        events, _ = detect_events(
            rows,
            state,
            checked_at="2026-06-02T00:05:00+00:00",
            alert_new_sessions=True,
            alert_on_first_run=False,
        )

        self.assertEqual([event.kind for event in events], ["new_session"])

    def test_allow_fetch_failure_skips_network_outage_with_github_warning(self):
        with (
            patch.dict("os.environ", {"GITHUB_ACTIONS": "true"}),
            patch(
                "tools.tcf_monitor.run_once",
                side_effect=FetchPageError("connection refused"),
            ),
            patch("builtins.print") as print_mock,
        ):
            exit_code = main(["--once", "--allow-fetch-failure"])

        self.assertEqual(exit_code, 0)
        self.assertTrue(
            any(
                "::warning title=TCF page temporarily unavailable::" in call.args[0]
                for call in print_mock.call_args_list
            )
        )

    def test_allow_fetch_failure_does_not_hide_parser_failure(self):
        with (
            patch(
                "tools.tcf_monitor.run_once",
                side_effect=SchedulePageError("schedule table changed"),
            ),
            patch("tools.tcf_monitor.logging.error") as error_mock,
        ):
            exit_code = main(["--once", "--allow-fetch-failure"])

        self.assertEqual(exit_code, 1)
        error_mock.assert_called_once()

    def test_toronto_feed_keeps_open_courses_and_ignores_expired_deadlines(self):
        data = {
            "items": [
                {
                    "id": 101,
                    "name": "E-TCF CANADA - 4 modules",
                    "open_spaces": 2,
                    "price": 390,
                    "registration_deadline": "2026-08-05T03:59:59+00:00",
                    "campus": {"full_name": "Alliance Francaise Toronto - Oakville"},
                    "date_patterns": [
                        {
                            "activity_start_date": "2026-08-20",
                            "activity_start_time": "08:30:00",
                            "activity_end_time": "14:30:00",
                        }
                    ],
                },
                {
                    "id": 102,
                    "name": "E-TCF CANADA - 4 modules",
                    "open_spaces": 1,
                    "registration_deadline": "2026-08-01T03:59:59+00:00",
                    "campus": {"name": "Mississauga"},
                },
            ]
        }

        rows = parse_toronto_courses(
            data,
            checked_at=datetime.fromisoformat("2026-08-04T12:00:00+00:00"),
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].city, "Toronto")
        self.assertEqual(rows[0].spots_left, "2")
        self.assertTrue(rows[0].is_available)
        self.assertIn("Activity_Search/101", rows[0].booking_links[0].href)

    def test_aec_feed_distinguishes_bookable_and_full_sessions(self):
        data = [
            {
                "IDEXAMINATION_TYPE": 10,
                "examinations": [
                    {
                        "IDEXAMINATION": 201,
                        "product_name": "TCF CANADA",
                        "qty_student": 31,
                        "max_student": 32,
                        "examination_coloquial_date": "Thursday, September 3, 2026",
                        "examination_date_registration_formatted": "Registration open",
                        "examination_location": "Montreal",
                        "price_formatted": "$390.00",
                        "isFull": False,
                        "mainRegisterLink": {
                            "link": "https://example.test/addExamination/201",
                            "cantRegisterReason": "",
                        },
                    },
                    {
                        "IDEXAMINATION": 202,
                        "product_name": "TCF CANADA",
                        "qty_student": 32,
                        "max_student": 32,
                        "examination_date": "2026-09-04",
                        "isFull": True,
                        "mainRegisterLink": {
                            "link": "https://example.test/addExamination/202",
                            "cantRegisterReason": "",
                        },
                    },
                    {
                        "IDEXAMINATION": 203,
                        "product_name": "TCF CANADA",
                        "qty_student": 1,
                        "max_student": 32,
                        "examination_date": "2026-09-05",
                        "isFull": False,
                        "mainRegisterLink": {
                            "link": "",
                            "cantRegisterReason": "Les inscriptions ne sont pas ouvertes",
                        },
                    },
                ],
            }
        ]

        rows = parse_aec_examinations(
            data,
            city="Montreal",
            page_url="https://example.test/tcf",
        )

        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0].spots_left, "1")
        self.assertTrue(rows[0].is_available)
        self.assertEqual(rows[1].spots_left, "SOLD OUT!")
        self.assertFalse(rows[1].is_available)
        self.assertEqual(rows[1].booking_links, ())
        self.assertEqual(rows[2].spots_left, "31")
        self.assertFalse(rows[2].is_available)

    def test_aec_settings_are_discovered_from_official_page(self):
        html = """
        <script>
          var aec_app_url = "https://city.aec.app";
          var aecExtranetWebAppsAPIKey = "public-page-key";
        </script>
        """

        self.assertEqual(
            extract_aec_settings(html),
            ("https://city.aec.app", "public-page-key"),
        )
        with self.assertRaises(SchedulePageError):
            extract_aec_settings("<html>changed</html>")

    def test_city_source_ids_do_not_collide(self):
        common = dict(
            exam="TCF Canada",
            schedule="2026-09-01",
            registration_dates="Open",
            location="Alliance Francaise",
            spots_left="1",
            price="$400",
            bookings="Open",
            booking_links=(Link("Register", "https://example.test/register"),),
            source_id="examination:123",
        )

        montreal = ExamRow(city="Montreal", **common)
        ottawa = ExamRow(city="Ottawa", **common)

        self.assertNotEqual(montreal.key, ottawa.key)

    def test_failed_city_state_is_not_marked_missing(self):
        toronto = ExamRow(
            exam="TCF Canada",
            schedule="2026-09-01",
            registration_dates="Open",
            location="Toronto",
            spots_left="1",
            price="$400",
            bookings="Open",
            city="Toronto",
            source_id="course:1",
        )
        montreal = ExamRow(
            exam="TCF Canada",
            schedule="2026-09-02",
            registration_dates="Open",
            location="Montreal",
            spots_left="1",
            price="$400",
            bookings="Open",
            city="Montreal",
            source_id="examination:2",
        )
        initial_events, state = detect_events(
            [toronto, montreal],
            {"version": 2, "seen": {}},
            checked_at="2026-08-04T00:00:00+00:00",
            alert_new_sessions=False,
            alert_on_first_run=False,
            active_cities={"Toronto", "Montreal"},
        )
        mark_events_sent(state, initial_events, "2026-08-04T00:00:00+00:00")

        _, next_state = detect_events(
            [toronto],
            state,
            checked_at="2026-08-04T00:05:00+00:00",
            alert_new_sessions=False,
            alert_on_first_run=False,
            active_cities={"Toronto"},
        )

        self.assertNotIn("last_missing_at", next_state["seen"][montreal.key])
        self.assertTrue(next_state["seen"][montreal.key]["notified_available"])

    def test_multi_city_fetch_continues_after_one_network_failure(self):
        edmonton_row = parse_exam_rows(FIXTURE_HTML)[0]
        with (
            patch("tools.tcf_monitor.fetch_schedule_rows", return_value=[edmonton_row]),
            patch(
                "tools.tcf_monitor.fetch_toronto_rows",
                side_effect=FetchPageError("Toronto unavailable"),
            ),
            patch("tools.tcf_monitor.fetch_aec_rows", side_effect=[[], []]),
            patch("tools.tcf_monitor.report_skipped_fetch") as report_mock,
        ):
            result = fetch_all_city_rows(
                "https://www.afedmonton.com/en/exams/tcf/",
                20,
                attempts=1,
                retry_delay_seconds=0,
                checked_at=datetime.fromisoformat("2026-08-04T12:00:00+00:00"),
            )

        self.assertEqual(result.successful_cities, ("Edmonton", "Montreal", "Ottawa"))
        self.assertEqual([failure.city for failure in result.skipped_failures], ["Toronto"])
        report_mock.assert_called_once()


if __name__ == "__main__":
    unittest.main()
