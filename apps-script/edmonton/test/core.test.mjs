import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePage, fetchComplete, evaluate, classify, markSent, registrationWindow, alertBody } from "../src/core.js";
import { loadState, saveState, emptyState, summarize } from "../src/storage.js";
import { page, row, openLink, headers, at, wallTime, Properties } from "./fixtures.mjs";

const parseRow = options => parsePage(page(row(options))).rows[0];
test("extracts and normalizes the Edmonton schedule using the real HTML parser", () => {
  const parsed = parseRow();
  assert.equal(parsed.exam, "TCF Canada - September 18");
  assert.match(parsed.location, /Fran\u00e7aise/);
  assert.deepEqual(classify(parsed, wallTime), { available: true, reason: "active_booking_link" });
});

for (const options of [
  { spots: "SOLD OUT!" }, { spots: "0" }, { spots: "0 spots left" }, { bookings: `Closed ${openLink}` },
  { bookings: `Not available ${openLink}` }, { bookings: `Fully booked ${openLink}` },
  { bookings: `Opens in 1h ${openLink}` }, { bookings: `Waitlist ${openLink}` },
  { bookings: "Open", spots: "3" }, { bookings: "Closed", spots: "1" },
  { bookings: openLink.replace("Book Now", "More information") },
  { bookings: openLink.replace('<a ', '<a aria-disabled="true" ') },
  { bookings: `<div style="display: none">${openLink}</div>` },
]) {
  test(`suppresses unsafe availability: ${JSON.stringify(options)}`, () => assert.equal(classify(parseRow(options), wallTime).available, false));
}

test("changed or unsupported booking actions raise an error instead of silent false negatives", () => {
  for (const bookings of ['<a href="https://attacker.example/register">Register</a>',
    '<a href="javascript:register()">Register</a>',
    '<a href="/af/exam-selector/order/?exam_id=abc">Book Now</a>',
    '<form><input type="submit" value="Register"></form>']) {
    assert.throws(() => classify(parseRow({ bookings }), wallTime), /Unsupported booking action/);
  }
});

test("ignores other exam types and unrelated tables", () => {
  const html = page(row() + row({ exam: "TCF Quebec" })) + `<table>${headers}${row()}</table>`;
  assert.equal(parsePage(html).rows.length, 1);
});
test("rejects malformed, maintenance, and changed-column responses", () => {
  for (const html of ["<html>Maintenance</html>", page().replace("Spots left", "New column"), page().replace("<td>$400.00</td>", ""), page() + page()]) {
    assert.throws(() => parsePage(html));
  }
});
test("complete fetch follows Show More and rejects partial page failure", () => {
  const next = '<a class="dataShowMore" href="?s8-datatable1_rows=200&amp;s8-datatable1_start=1">Show More</a>';
  let count = 0;
  const complete = fetchComplete(() => ({ status: 200, body: count++ === 0 ? page(row(), next) : page(row({ exam: "TCF Canada - October 7" })) }));
  assert.equal(complete.pages, 2);
  assert.equal(complete.rows.length, 2);
  count = 0;
  assert.throws(() => fetchComplete(() => count++ ? { status: 503, body: "Unavailable" } : { status: 200, body: page(row(), next) }), /503/);
});
test("rejects pagination loops, repeated data, foreign origins, and conflicting duplicates", () => {
  const more = '<a class="dataShowMore" href="?s8-datatable1_start=1">Show More</a>';
  assert.throws(() => fetchComplete(() => ({ status: 200, body: page(row(), more) })), /repeated/);
  assert.throws(() => parsePage(page(row(), more.replace("?s8", "https://attacker.example/?s8"))), /Unexpected URL/);
  assert.throws(() => fetchComplete(() => ({ status: 200, body: page(row() + row({ spots: "5" })) })), /Conflicting/);
});
test("rejects redirects, non-HTML, and an empty catalog instead of reporting sold out", () => {
  for (const response of [{ status: 302, body: "" }, { status: 200, body: page("" ) }, { status: 200, contentType: "application/json", body: "{}" }]) {
    assert.throws(() => fetchComplete(() => response));
  }
});

const oldOctoberOffer = { exam: "TCF Canada - October 7", schedule: "Written Wednesday 07 Oct 2026 - 9:20am to 12:20pm",
  dates: "Sep 8 2026 4:17pm - Sep 8 2026 5:17pm", spots: "SOLD OUT!", bookings: "Closed" };
const newOctoberOffer = { ...oldOctoberOffer, dates: "Sep 9 2026 2:40pm - Sep 9 2026 3:40pm", spots: "10",
  bookings: '<a href="/af/exam-selector/order/?exam_id=155">Book Now</a>' };
const octoberWall = Date.parse("2026-09-09T14:55:00Z");
const fetchOffers = offers => fetchComplete(() => ({ status: 200, body: page(offers.map(row).join("")) }));

test("reposted registration and expired sold-out entry are resolved independently of row order", () => {
  for (const offers of [[oldOctoberOffer, newOctoberOffer], [newOctoberOffer, oldOctoberOffer],
    [oldOctoberOffer, newOctoberOffer, oldOctoberOffer]]) {
    const fetched = fetchOffers(offers);
    assert.equal(fetched.rows.length, 1);
    const result = evaluate(fetched.rows, {}, at, octoberWall);
    assert.equal(result.events.length, 1);
    assert.match(result.events[0].links[0], /exam_id=155/);
    assert.equal(result.events[0].key, parseRow(oldOctoberOffer).key);
    assert.equal(result.snapshot[0].registrationOffers.length, 2);
    assert.equal(result.snapshot[0].registrationOffers[0].reason, "sold_out");
    assert.match(fetched.detail, /non-overlapping/);
  }
});

test("duplicate offers do not bypass closed, sold out, unsupported action, or registration-window guards", () => {
  for (const changes of [{ spots: "SOLD OUT!" }, { bookings: "Closed" }, { bookings: "On hold" }, { bookings: "" }]) {
    const fetched = fetchOffers([oldOctoberOffer, { ...newOctoberOffer, ...changes }]);
    assert.equal(evaluate(fetched.rows, {}, at, octoberWall).events.length, 0);
  }
  const fetched = fetchOffers([oldOctoberOffer, newOctoberOffer]);
  for (const wall of ["2026-09-09T14:39:59Z", "2026-09-09T15:40:00Z", "2026-09-10T14:55:00Z"]) {
    assert.equal(evaluate(fetched.rows, {}, at, Date.parse(wall)).events.length, 0);
  }
  const unsupported = fetchOffers([oldOctoberOffer, { ...newOctoberOffer, bookings: '<a href="https://untrusted.example">Book Now</a>' }]);
  assert.throws(() => evaluate(unsupported.rows, {}, at, octoberWall), /Unsupported/);
});

test("same-window and overlapping or unknown-window contradictions still fail with identifying details", () => {
  for (const dates of [oldOctoberOffer.dates, "Sep 8 2026 4:30pm - Sep 8 2026 5:30pm", "Unknown"]) {
    assert.throws(() => fetchOffers([oldOctoberOffer, { ...newOctoberOffer, dates }]), /Conflicting.*October 7.*Registration windows/);
  }
});

test("new registration offers can appear on later pages without being mistaken for repeated pagination", () => {
  let count = 0;
  const more = '<a class="dataShowMore" href="?s8-datatable1_start=1">Show More</a>';
  const fetched = fetchComplete(() => ({ status: 200, body: count++ ? page(row(newOctoberOffer)) : page(row(oldOctoberOffer), more) }));
  assert.equal(fetched.pages, 2);
  assert.equal(evaluate(fetched.rows, {}, at, octoberWall).events.length, 1);
});

test("reposted offers preserve deduplication when old rows appear or disappear, and reopenings still alert", () => {
  const single = evaluate([parseRow(newOctoberOffer)], {}, at, octoberWall); markSent(single.next, single.events);
  const fetched = fetchOffers([oldOctoberOffer, newOctoberOffer]);
  const duplicate = evaluate(fetched.rows, single.next, at, octoberWall);
  assert.equal(duplicate.events.length, 0);
  assert.equal(evaluate([parseRow(newOctoberOffer)], duplicate.next, at, octoberWall).events.length, 0);
  const closed = evaluate(fetchOffers([oldOctoberOffer, { ...newOctoberOffer, bookings: "Closed" }]).rows, duplicate.next, at, octoberWall);
  assert.equal(evaluate(fetched.rows, closed.next, at, octoberWall).events.length, 1);
});

test("a distinct reposted window alerts even if no closed observation occurred between offers", () => {
  const prior = evaluate([parseRow({ ...oldOctoberOffer, spots: "2", bookings: openLink })], {}, at, Date.parse("2026-09-08T16:30:00Z"));
  markSent(prior.next, prior.events);
  const result = evaluate(fetchOffers([oldOctoberOffer, newOctoberOffer]).rows, prior.next, at, octoberWall);
  assert.equal(result.events.length, 1);
  markSent(result.next, result.events);
  assert.equal(evaluate(fetchOffers([oldOctoberOffer, newOctoberOffer]).rows, result.next, at, octoberWall).events.length, 0);
});

test("a temporarily missing current offer cannot be marked closed by its older sold-out duplicate", () => {
  const fetched = fetchOffers([oldOctoberOffer, newOctoberOffer]);
  const opened = evaluate(fetched.rows, {}, at, octoberWall); markSent(opened.next, opened.events);
  const missing = evaluate([parseRow(oldOctoberOffer)], opened.next, at, octoberWall);
  assert.equal(missing.events.length, 0);
  assert.deepEqual(missing.next, opened.next);
  assert.equal(evaluate(fetched.rows, missing.next, at, octoberWall).events.length, 0);
});

test("September 9 live regression fixture retains 27 offers and detects only the valid October 7 reopening", () => {
  const html = readFileSync(new URL("./fixtures/edmonton-2026-09-09.html", import.meta.url), "utf8");
  assert.equal(parsePage(html).rows.length, 27);
  const fetched = fetchComplete(() => ({ status: 200, body: html }));
  assert.equal(fetched.rows.length, 26);
  const result = evaluate(fetched.rows, {}, "2026-09-09T20:55:00Z", octoberWall);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].exam, "TCF Canada - October 7");
  assert.equal(result.events[0].spotsLeft, "10");
  assert.equal(result.snapshot.reduce((n, row) => n + (row.registrationOffers?.length || 1), 0), 27);
});
test("registration windows are checked using Edmonton wall time, including noon/midnight", () => {
  const parsed = parseRow();
  assert.equal(classify(parsed, Date.parse("2026-09-08T11:59:59Z")).available, false);
  assert.equal(classify(parsed, Date.parse("2026-09-08T12:00:00Z")).available, true);
  assert.equal(classify(parsed, Date.parse("2026-09-08T14:00:00Z")).available, false);
  assert.equal(registrationWindow("Feb 30 2026 9:00am - Feb 30 2026 10:00am"), null);
  assert.equal(registrationWindow("Sep 8 2026 12:00am - Sep 8 2026 12:00pm")[1] - registrationWindow("Sep 8 2026 12:00am - Sep 8 2026 12:00pm")[0], 12 * 3600000);
  assert.throws(() => classify(parseRow({ dates: "Unknown" }), wallTime), /Cannot validate/);
});
test("first-run closed sessions never alert; open sessions do", () => {
  const result = evaluate([parseRow({ spots: "SOLD OUT!" }), parseRow({ exam: "TCF Canada - October 7" })], {}, at, wallTime);
  assert.equal(result.events.length, 1);
});
test("deduplicates successful delivery despite registration-window and seat-count edits", () => {
  const first = evaluate([parseRow()], {}, at, wallTime);
  markSent(first.next, first.events);
  const again = evaluate([parseRow({ spots: "1", dates: "Sep 8 2026 11:00am - Sep 8 2026 3:00pm" })], first.next, at, wallTime);
  assert.equal(again.events.length, 0);
});
test("failed email remains pending, but freshly closed sessions are not retried", () => {
  const first = evaluate([parseRow()], {}, at, wallTime);
  assert.equal(evaluate([parseRow()], first.next, at, wallTime).events.length, 1);
  assert.equal(evaluate([parseRow({ bookings: "Closed" })], first.next, at, wallTime).events.length, 0);
});
test("reopening alerts again; missing rows alone do not reset deduplication", () => {
  const first = evaluate([parseRow()], {}, at, wallTime);
  markSent(first.next, first.events);
  const missing = evaluate([], first.next, at, wallTime);
  assert.equal(evaluate([parseRow()], missing.next, at, wallTime).events.length, 0);
  const closed = evaluate([parseRow({ bookings: "Closed" })], first.next, at, wallTime);
  assert.equal(evaluate([parseRow()], closed.next, at, wallTime).events.length, 1);
});
test("atomic chunked state preserves Unicode and the active bank after partial write failure", () => {
  const p = new Properties();
  const state = { ...emptyState(), large: "Fran\u00e7aise".repeat(1500) };
  saveState(p, state);
  assert.deepEqual(loadState(p), state);
  assert.ok([...p.data.values()].every(value => Buffer.byteLength(value) < 9000));
  const original = p.setProperties.bind(p);
  p.setProperties = values => { p.setProperty(Object.keys(values)[0], "broken"); throw new Error("partial failure"); };
  assert.throws(() => saveState(p, emptyState()), /partial failure/);
  assert.deepEqual(loadState(p), state);
  p.setProperties = original;
  saveState(p, emptyState());
  assert.deepEqual(loadState(p), emptyState());
});
test("corrupt saved history is never silently replaced with an empty baseline", () => {
  const p = new Properties();
  p.setProperty("EDMONTON_STATE_ACTIVE", '{"bank":"A","count":2}');
  assert.throws(() => loadState(p), /Incomplete/);
});
test("oversized state cannot replace a valid active bank", () => {
  const p = new Properties(); saveState(p, emptyState());
  assert.throws(() => saveState(p, { ...emptyState(), oversized: "x".repeat(190000) }), /storage budget/);
  assert.deepEqual(loadState(p), emptyState());
});
test("pagination has both a page cap and a between-request time budget", () => {
  let count = 0;
  const request = () => ({ status: 200, body: page(row({ exam: `TCF Canada - Session ${count++}` }),
    `<a class="dataShowMore" href="?s8-datatable1_start=${count}">Show More</a>`) });
  assert.throws(() => fetchComplete(request, () => 0, 2), /budget/);
  let now = 0;
  assert.throws(() => fetchComplete(request, () => (now += 50000)), /budget/);
});
test("health report includes silent scheduler gaps and failure runtime", () => {
  const now = Date.parse(at);
  const stats = summarize({ ...emptyState(), lastSuccess: new Date(now - 20 * 60000).toISOString(), failures: 1,
    recent: [{ at: now - 20 * 60000, ok: true, durationMs: 1000, gapMs: 5 * 60000 }, { at: now - 10 * 60000, ok: false, durationMs: 10000 }] }, now);
  assert.equal(stats.longestGapMinutes24h, 20);
  assert.equal(stats.successfulChecks24h, 1);
  assert.equal(stats.failedChecks24h, 1);
  assert.equal(stats.averageRuntimeSeconds24h, 5.5);
});
test("email clearly distinguishes detected availability from a reservation", () => {
  assert.match(alertBody([parseRow()], at), /No seat has been reserved/);
});
test("captured public Edmonton table yields 24 sessions and zero false alerts", () => {
  const html = readFileSync(new URL("./fixtures/edmonton-2026-09-08.html", import.meta.url), "utf8");
  const parsed = parsePage(html);
  const result = evaluate(parsed.rows, {}, at, wallTime);
  assert.equal(parsed.rows.length, 24);
  assert.equal(result.events.length, 0);
  assert.equal(result.snapshot.filter(row => row.reason === "closed").length, 1);
});
