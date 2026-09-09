import test from "node:test";
import assert from "node:assert/strict";
import { northYorkLocation, parseActiveSearch, parseActiveChildren, parseNorthYorkCourse, fetchNorthYork,
  parseMontreal, fetchMontreal, extractMontrealSettings, preferredAlertBody } from "../src/providers.js";
import { evaluateSnapshot, markSent } from "../src/core.js";
import { Properties } from "./fixtures.mjs";
import { loadState, saveState, emptyState } from "../src/storage.js";
import { today, active, candidate, search, detail, button, examination, montreal, response, providerRoute } from "./provider-fixtures.mjs";

test("North York campus is explicit and distinguishes all other Toronto campuses", () => {
  for (const name of ["North York", "North-York", "Jim Doak", "47 Sheppard Avenue E. 5th floor"]) assert.equal(northYorkLocation(name), true);
  for (const name of ["Oakville", "Mississauga", "Spadina", "Markham"]) assert.equal(northYorkLocation(name), false);
  assert.equal(northYorkLocation("Toronto"), null);
  assert.throws(() => northYorkLocation("North York / Oakville"), /Conflicting/);
});
test("North York accepts only a future four-module leaf and final matching Enroll Now action", () => {
  const row = parseNorthYorkCourse(candidate(), detail(), button(), today);
  assert.equal(row.available, true);
  assert.equal(row.priority, 1);
  assert.equal(row.key, "north-york:course:123");
  assert.equal(parseNorthYorkCourse(candidate(), detail({ location_description: "Oakville" }), button(), today), null);
  assert.throws(() => parseNorthYorkCourse(candidate(), detail({ location_description: "Toronto" }), button(), today), /campus/);
  for (const edit of [{ activity_id: 124 }, { activity_name: "TCF preparation" }, { is_parent_activity: true }, { first_date: "2026-02-30" }]) {
    assert.throws(() => parseNorthYorkCourse(candidate(), detail(edit), button(), today));
  }
});
for (const value of ["SOLD OUT!", "Full", "Closed", "Waitlist", "On hold", "Opens in 2 hours", "Not available"]) {
  test(`North York blocks ${value} despite positive seats and a link`, () => {
    assert.equal(parseNorthYorkCourse(candidate(), detail(), button({ notification: value }), today).available, false);
    assert.equal(parseNorthYorkCourse(candidate(), detail({ space_status: value }), button(), today).available, false);
  });
}
test("North York rejects inactive or unsafe registration actions", () => {
  for (const action of [{ disabled: true }, { enabled: false }, { label: "Join Waitlist" }, { href: "" }]) {
    assert.equal(parseNorthYorkCourse(candidate(), detail(), button({}, action), today).available, false);
  }
  assert.equal(parseNorthYorkCourse(candidate(), detail(), button({ time_remaining: 60 }), today).available, false);
  assert.equal(parseNorthYorkCourse(candidate(), detail({ space_status: "0 openings" }), button(), today).available, false);
  assert.equal(parseNorthYorkCourse(candidate(), detail(), button(), "2026-10-06").available, false);
  for (const href of ["https://evil.example/enroll/123", "https://anc.ca.apm.activecommunities.com/aftoronto/activity/search/enroll/999", "javascript:alert(1)"]) {
    assert.throws(() => parseNorthYorkCourse(candidate(), detail(), button({}, { href }), today), /URL/);
  }
});
test("North York verifies pagination shape, exact count, page identity, duplicate IDs and response success", () => {
  assert.equal(parseActiveSearch(search(), 1).total, 0);
  assert.throws(() => parseActiveSearch(search([candidate()], 1, 2), 1), /incomplete/);
  assert.throws(() => parseActiveSearch(search([candidate()]), 2), /pagination/);
  assert.throws(() => parseActiveSearch(search([candidate(), candidate()]), 1), /repeated/);
  const bad = search(); bad.headers.response_code = "ERROR";
  assert.throws(() => parseActiveSearch(bad, 1), /success/);
  assert.equal(parseActiveSearch(search([candidate({ name: "TCF preparation" })]), 1).candidates.length, 0);
});
test("North York pagination lives in HTTP headers and repeated pages fail", () => {
  let count = 0;
  const request = (url, options) => {
    count++;
    assert.ok(options.headers.page_info);
    assert.equal(JSON.parse(options.payload).page_info, undefined);
    return response(search([candidate({ location: { label: "Oakville" } })], count, 2, 1));
  };
  assert.throws(() => fetchNorthYork(request, { today }), /same activity/);
});
test("North York expands cross-campus parents, verifies leaves and rejects partial responses", () => {
  const parent = candidate({ id: 1, num_of_sub_activities: 1, parent_activity: true, location: { label: "Oakville" } });
  assert.throws(() => parseActiveChildren(active({ sub_activities: [] }), parent), /incomplete/);
  const paths = [];
  const request = url => {
    paths.push(url);
    if (url.endsWith("/list")) return response(search([parent]));
    if (url.includes("/subs/")) return response(active({ sub_activities: [candidate()] }));
    return response(url.includes("buttonstatus") ? button() : detail());
  };
  const result = fetchNorthYork(request, { today });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].available, true);
  assert.equal(paths.length, 4);
  assert.throws(() => fetchNorthYork(url => url.includes("buttonstatus") ? { status: 503, body: "down" } : request(url), { today }), /503/);
});
test("North York valid empty catalog is healthy but previously open missing leaves are rechecked", () => {
  assert.equal(fetchNorthYork(providerRoute, { today }).rows.length, 0);
  const row = parseNorthYorkCourse(candidate(), detail(), button(), today);
  let assessment = evaluateSnapshot([row], {}, `${today}T12:00:00Z`);
  markSent(assessment.next, assessment.events);
  const previous = assessment.next;
  let requests = 0;
  const closed = fetchNorthYork(url => {
    requests++;
    if (url.endsWith("/list")) return response(search());
    return response(url.includes("buttonstatus") ? button({ notification: "Full" }) : detail());
  }, { today, seen: previous });
  assert.equal(requests, 3);
  assert.equal(closed.rows[0].available, false);
  assessment = evaluateSnapshot(closed.rows, previous, `${today}T12:05:00Z`);
  assert.equal(assessment.events.length, 0);
  assert.equal(evaluateSnapshot([row], assessment.next, `${today}T12:10:00Z`).events.length, 1);
});
test("Montreal needs the correct exam type, dates, remaining capacity and exact booking action", () => {
  const rows = parseMontreal(montreal(), today);
  assert.equal(rows[0].available, true);
  assert.equal(rows[0].spotsLeft, "16");
  assert.equal(rows[0].priority, 3);
  assert.equal(parseMontreal(montreal([]), today).length, 0);
  for (const edit of [{ IDEXAMINATION_TYPE: 11 }, { examination_date: "2026-02-30" }, { formattedEnrollmentDate: "bad" }, { qty_student: -1 }, { isFull: "false" }]) {
    assert.throws(() => parseMontreal(montreal([examination(edit)]), today));
  }
  assert.throws(() => parseMontreal(montreal([examination(), examination()]), today), /Duplicate/);
  assert.throws(() => parseMontreal([], today), /catalog/);
});
for (const edit of [{ isFull: true }, { qty_student: 31 }, { max_student: 0 }, { inscriptionIsInFuture: true },
  { inscriptions_are_over: true }, { inscriptions_started: false }, { formattedEnrollmentDate: "10/09/2026" },
  { examination_enroll_end_date_formatted: "07/09/2026" }, { examination_date: "2026-09-07" },
  { mainRegisterLink: { link: "", label: "", cantRegisterReason: "sold out" } }]) {
  test(`Montreal suppresses unavailable session ${JSON.stringify(edit)}`, () => {
    assert.equal(parseMontreal(montreal([examination(edit)]), today)[0].available, false);
  });
}
test("Montreal never follows cart links and rejects mismatched or foreign booking links", () => {
  const calls = [];
  assert.equal(fetchMontreal(url => { calls.push(url); return providerRoute(url); }, { today }).rows.length, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(url => !url.includes("panier")));
  for (const link of ["https://evil.example/panier/#/addExamination/2771", "https://www.afmontreal.ca/panier/#/addExamination/999"]) {
    assert.throws(() => parseMontreal(montreal([examination({ mainRegisterLink: { link, label: "add_to_cart" } })]), today), /booking action/);
  }
  assert.throws(() => extractMontrealSettings('aec_app_url="https://evil.example"; aecExtranetWebAppsAPIKey="key"'), /settings/);
  assert.throws(() => fetchMontreal(() => ({ status: 503, body: "" }), { today }), /503/);
});
test("city notification histories are isolated and preserve deduplication and pending alerts", () => {
  const p = new Properties();
  const rows = parseMontreal(montreal(), today);
  const assessment = evaluateSnapshot(rows, {}, `${today}T12:00:00Z`);
  const state = { ...emptyState(), seen: assessment.next };
  saveState(p, state, "MONTREAL_STATE_", 8);
  assert.equal(Object.keys(loadState(p).seen).length, 0);
  assert.equal(evaluateSnapshot(rows, loadState(p, "MONTREAL_STATE_").seen, `${today}T12:05:00Z`).events.length, 1);
  markSent(state.seen, assessment.events);
  assert.equal(evaluateSnapshot(rows, state.seen, `${today}T12:05:00Z`).events.length, 0);
  const body = preferredAlertBody([...rows, parseNorthYorkCourse(candidate(), detail(), button(), today)], "now");
  assert.match(body, /1\. North York/);
  assert.match(body, /2\. Montreal/);
  assert.match(body, /No seat has been reserved/);
});
