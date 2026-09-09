export const headers = "<tr><th>Exam</th><th>Schedules</th><th>Registration Dates</th><th>Location</th><th>Spots left</th><th>Price</th><th>Bookings</th></tr>";
export const openLink = '<a href="/af/exam-selector/order/?exam_id=129">Book Now</a>';
export const windowText = "Sep 8 2026 12:00pm - Sep 8 2026 2:00pm";
export const at = "2026-09-08T19:00:00.000Z";
export const wallTime = Date.parse("2026-09-08T13:00:00Z");

export function row({ exam = "TCF  Canada - September 18", schedule = "Written Friday 18 Sep 2026 - 1:10pm to 4:10pm",
  dates = windowText, spots = "2", bookings = openLink } = {}) {
  return `<tr><td><span>${exam}</span></td><td>${schedule}</td><td>${dates}</td><td>Alliance Fran&ccedil;aise of Edmonton - Kingsway</td><td>${spots}</td><td>$400.00</td><td>${bookings}</td></tr>`;
}

export function page(rows = row(), more = "") {
  return `<html><body><table id="s8-datatable1">${headers}${rows}</table>${more}</body></html>`;
}

export class Properties {
  data = new Map();
  failWrite = false;
  getProperty(key) { return this.data.get(key) ?? null; }
  setProperty(key, value) { if (this.failWrite) throw new Error("Storage unavailable"); this.data.set(key, String(value)); return this; }
  setProperties(values) { for (const [key, value] of Object.entries(values)) this.setProperty(key, value); return this; }
}
