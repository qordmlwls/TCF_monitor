import sys
import unittest
from pathlib import Path

sys.path.append(str(Path(__file__).parent.parent))

from tools.tcf_monitor import detect_events, parse_exam_rows


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


if __name__ == "__main__":
    unittest.main()
