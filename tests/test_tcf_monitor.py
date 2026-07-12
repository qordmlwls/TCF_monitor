import sys
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

sys.path.append(str(Path(__file__).parent.parent))

from tools.tcf_monitor import (
    FetchPageError,
    SchedulePageError,
    detect_events,
    fetch_schedule_rows,
    main,
    mark_events_sent,
    parse_exam_rows,
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


if __name__ == "__main__":
    unittest.main()
