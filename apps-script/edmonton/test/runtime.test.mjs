import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { page, row, at, Properties } from "./fixtures.mjs";
import { loadState, saveState } from "../src/storage.js";
import { providerRoute, response, search, candidate, detail, button } from "./provider-fixtures.mjs";

const source = readFileSync(new URL("../dist/Code.gs", import.meta.url), "utf8");
const heartbeat = "https://hc-ping.com/00000000-0000-4000-8000-000000000001";
function runtime() {
  const p = new Properties();
  const rows = [];
  const sent = [];
  const calls = [];
  const messages = [];
  const triggers = [];
  const sheets = new Map();
  const env = { html: page(row()), http: 200, locked: false, lockHeld: false, quota: 100, failEmail: false, failLog: false, failPing: false,
    released: 0, now: Date.parse(at), spreadsheetCreated: 0, nextRun: 0 };
  const makeSheet = rows => ({
    rows, setName(name) { sheets.set(name, this); }, setFrozenRows() {},
    appendRow(values) { if (env.failLog) throw new Error("Log write failed"); rows.push([...values]); },
    getLastRow() { return rows.length; }, deleteRows(start, n) { rows.splice(start - 1, n); },
    getRange(r, c, nr = 1, nc = 1) { return {
      getValues() { return Array.from({ length: nr }, (_, i) => (rows[r - 1 + i] || []).slice(c - 1, c - 1 + nc)); },
      setValues(values) { if (env.failFinalize && c === 3) throw new Error("Diagnostics unavailable"); values.forEach((value, i) => {
        rows[r - 1 + i] ||= [];
        value.forEach((cell, j) => { rows[r - 1 + i][c - 1 + j] = cell; });
      }); },
      setValue(value) { rows[r - 1][c - 1] = value; },
    }; },
  });
  const sheet = makeSheet(rows);
  const book = { getSheets: () => [sheet], getSheetByName: name => sheets.get(name) || null,
    insertSheet: name => { const sheet = makeSheet([]); sheet.setName(name); return sheet; }, getId: () => "test-spreadsheet" };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [env.now])); }
    static now() { return env.now; }
  }
  const sandbox = {
    Date: Clock,
    console: { log: (...args) => messages.push(args.join(" ")), warn: (...args) => messages.push(args.join(" ")), error: (...args) => messages.push(args.join(" ")) },
    PropertiesService: { getScriptProperties: () => p },
    LockService: { getScriptLock: () => ({ tryLock: ms => {
      if (ms === 5000 && env.deniedCompletionLocks > 0) { env.deniedCompletionLocks--; return false; }
      if (env.locked || env.lockHeld) return false;
      env.lockHeld = true; return true;
    }, releaseLock: () => { env.lockHeld = false; env.released += 1; } }) },
    SpreadsheetApp: { create: () => { env.spreadsheetCreated += 1; return book; }, openById: () => book },
    UrlFetchApp: { fetch: (url, options) => {
      calls.push({ url, options });
      assert.equal(env.lockHeld, false, "Network calls must never hold the shared script lock");
      if (env.onFetch) env.onFetch(url);
      const ping = url.startsWith("https://hc-ping.com/");
      if (ping && env.failPing) throw new Error(`Transport failed ${url}`);
      if (ping) {
        const result = env.pingRoute ? env.pingRoute(url, options) : { status: 200, body: "OK" };
        env.now += result.durationMs || 0;
        if (result.error) throw new Error(result.error);
        return { getResponseCode: () => result.status, getContentText: () => result.body || "",
          getAllHeaders: () => result.headers || {} };
      }
      if (!ping && !url.includes("afedmonton.com")) {
        const result = (env.providerRoute || providerRoute)(url, options);
        return { getResponseCode: () => result.status, getContentText: () => result.body,
          getAllHeaders: () => ({ "Content-Type": result.contentType, ...result.headers }) };
      }
      return { getResponseCode: () => ping ? 200 : env.http, getContentText: () => env.html, getAllHeaders: () => ({ "Content-Type": "text/html; charset=utf-8" }) };
    } },
    Utilities: { getUuid: () => `test-run-${++env.nextRun}`,
      formatDate: (date, zone, pattern) => new Date(date.getTime() - (zone === "America/Toronto" ? 4 : 6) * 3600000).toISOString().slice(0, pattern === "yyyy-MM-dd" ? 10 : 19) },
    MailApp: { getRemainingDailyQuota: () => env.quota, sendEmail: email => {
      if (env.failEmail) throw new Error("Email transport failed");
      sent.push(email); env.quota -= 1;
    } },
    ScriptApp: {
      getProjectTriggers: () => [...triggers],
      deleteTrigger: trigger => {
        if (env.failDelete === trigger.getHandlerFunction()) throw new Error("Trigger deletion failed");
        triggers.splice(triggers.indexOf(trigger), 1);
      },
      newTrigger: handler => {
        const trigger = { getHandlerFunction: () => handler, handler };
        const builder = { timeBased() { return this; }, everyMinutes(n) { trigger.minutes = n; return this; },
          atHour(n) { trigger.hour = n; return this; }, everyDays(n) { trigger.days = n; return this; },
          inTimezone(zone) { trigger.zone = zone; return this; }, create() {
            if (env.failTrigger === handler) throw new Error("Trigger creation failed");
            triggers.push(trigger); return trigger;
          } };
        return builder;
      },
    },
  };
  sandbox.UrlFetchApp.fetchAll = specs => specs.map(({ url, ...options }) => sandbox.UrlFetchApp.fetch(url, options));
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { sandbox, p, rows, sheets, sent, calls, messages, env, triggers };
}

function multiRuntime() {
  const r = runtime(); r.env.now = Date.parse("2026-09-08T18:00:00Z");
  r.p.setProperty("TCF_HEALTHCHECKS_URL", heartbeat);
  r.p.setProperty("TCF_NORTH_YORK_HEALTHCHECKS_URL", heartbeat.replace(/1$/, "2"));
  r.p.setProperty("TCF_MONTREAL_HEALTHCHECKS_URL", heartbeat.replace(/1$/, "3"));
  return r;
}

function seedUnfinished(r, { age = 8 * 60000, withRow = true, legacy = false } = {}) {
  const started = r.env.now - age, observedAt = new Date(started).toISOString();
  const run = { id: "terminated-run", started, kind: "CHECK", phase: withRow ? "observation_saved" : "fetching" };
  if (withRow) {
    r.rows.push([observedAt, "CHECK", "OBSERVED", 2, 5, 1, 22, 0, 0, "Heartbeat pending.", "[]"]);
    Object.assign(run, { observedAt, row: r.rows.length });
  }
  if (!legacy) r.p.setProperty("TCF_RUN_JOURNAL", JSON.stringify({ version: 1, current: run, interruptions: [] }));
  return run;
}

test("failed city checks and audits finalize after temporary contention without false unfinished warnings", () => {
  const r = multiRuntime(); r.sandbox.dryRunAllCities();
  r.env.providerRoute = url => url.includes("/rest/activities/list")
    ? { status: 503, body: "unavailable" } : providerRoute(url);
  r.env.deniedCompletionLocks = 2;
  assert.throws(() => r.sandbox.checkNorthYork(), /503/);
  assert.equal(JSON.parse(r.p.getProperty("TCF_NORTH_YORK_RUN_JOURNAL")).current, null);
  r.env.deniedCompletionLocks = 2;
  r.sandbox.checkMonitorHealth();
  assert.equal(JSON.parse(r.p.getProperty("TCF_NORTH_YORK_RUN_JOURNAL")).current, null);
  r.env.now += 5 * 60000;
  r.env.providerRoute = providerRoute;
  assert.equal(r.sandbox.checkNorthYork().outcome, "SUCCESS");
  assert.equal(JSON.parse(r.p.getProperty("TCF_NORTH_YORK_RUN_JOURNAL")).interruptions.length, 0);
  assert.ok(!r.messages.some(message => /completion could not|Skipped overlapping/.test(message)));
});

test("exhausted completion retries remain visible without hiding the original provider error", () => {
  const r = multiRuntime(); r.sandbox.dryRunAllCities();
  r.env.providerRoute = url => url.includes("/rest/activities/list")
    ? { status: 503, body: "unavailable" } : providerRoute(url);
  r.env.deniedCompletionLocks = 3;
  assert.throws(() => r.sandbox.checkNorthYork(), /503/);
  assert.ok(r.messages.some(message => /completion could not be recorded after bounded retries/.test(message)));
  assert.ok(JSON.parse(r.p.getProperty("TCF_NORTH_YORK_RUN_JOURNAL")).current);
  assert.equal(r.sandbox.checkNorthYork().outcome, "SKIPPED_OVERLAP");
  r.env.now += 8 * 60000; r.env.providerRoute = providerRoute;
  assert.equal(r.sandbox.checkNorthYork().outcome, "SUCCESS");
  assert.equal(JSON.parse(r.p.getProperty("TCF_NORTH_YORK_RUN_JOURNAL")).interruptions.length, 1);
});

test("a fetching Edmonton check neither holds the shared lock nor prevents other cities from running", () => {
  const r = multiRuntime(); r.sandbox.dryRunAllCities();
  let nested = false;
  r.env.onFetch = url => {
    if (nested || !url.includes("afedmonton")) return;
    nested = true;
    assert.equal(r.sandbox.checkEdmonton().outcome, "SKIPPED_OVERLAP");
    assert.equal(r.sandbox.checkNorthYork({ triggerUid: "ny" }).outcome, "SUCCESS");
    assert.equal(r.sandbox.checkMontreal({ triggerUid: "mt" }).outcome, "SUCCESS");
  };
  r.sandbox.checkEdmonton({ triggerUid: "edm" });
  assert.equal(nested, true);
  assert.match(r.rows.at(-1)[9], /Independent timer: checkEdmonton/);
  assert.match(r.sheets.get("North York").rows.at(-1)[9], /Independent timer: checkNorthYork/);
  assert.match(r.sheets.get("Montreal").rows.at(-1)[9], /Independent timer: checkMontreal/);
  assert.equal(r.sent.filter(m => m.subject.includes("[TCF Montreal]")).length, 1);
});

test("health audit reconciles a killed run without fetches, heartbeat pings, or notification-state changes", () => {
  const r = multiRuntime(); r.sandbox.installAllCities();
  const run = seedUnfinished(r);
  const state = loadState(r.p), calls = r.calls.length, emails = r.sent.length;
  r.sandbox.checkMonitorHealth();
  assert.equal(r.calls.length, calls);
  assert.deepEqual(loadState(r.p), state);
  assert.equal(r.rows[run.row - 1][2], "INCOMPLETE");
  assert.equal(r.rows[run.row - 1][3], 2);
  assert.match(r.rows[run.row - 1][9], /No seat alert was replayed/);
  assert.equal(r.sent.length, emails + 1);
  assert.match(r.sent.at(-1).body, /Completion is unknown/);
  assert.equal(JSON.parse(r.p.getProperty("TCF_RUN_JOURNAL")).current, null);
  r.sandbox.checkMonitorHealth();
  assert.equal(r.sent.length, emails + 1);
});

test("a fresh city lease is protected from audit and does not block other city timers", () => {
  const r = multiRuntime(); r.sandbox.installAllCities();
  const run = seedUnfinished(r, { age: 60000 });
  const emails = r.sent.length;
  const results = r.sandbox.checkMonitorHealth();
  assert.equal(results.find(row => row.city === "Edmonton").outcome, "SKIPPED_OVERLAP");
  assert.equal(r.rows[run.row - 1][2], "OBSERVED");
  assert.equal(r.sent.length, emails);
  assert.equal(r.sandbox.checkNorthYork().outcome, "SUCCESS");
  assert.equal(r.sandbox.checkMontreal().outcome, "SUCCESS");
});

test("a killed check before its first observation is detected and the next real check recovers", () => {
  const r = multiRuntime(); r.sandbox.installAllCities();
  const state = loadState(r.p); seedUnfinished(r, { withRow: false });
  r.sandbox.checkEdmonton();
  assert.deepEqual(loadState(r.p).seen, state.seen);
  const journal = JSON.parse(r.p.getProperty("TCF_RUN_JOURNAL"));
  assert.equal(journal.interruptions[0].phase, "fetching");
  assert.equal(journal.lastFinished.outcome, "SUCCESS");
  r.sandbox.checkMonitorHealth();
  assert.match(r.sent.at(-1).body, /Last saved phase: fetching/);
});

test("old OBSERVED logs are reconciled once; a recent legacy observation is deferred then reconsidered", () => {
  const r = multiRuntime(); r.sandbox.installAllCities();
  const old = seedUnfinished(r, { legacy: true });
  const fresh = seedUnfinished(r, { legacy: true, age: 60000 });
  r.sandbox.checkMonitorHealth();
  assert.equal(r.rows[old.row - 1][2], "INCOMPLETE");
  assert.equal(r.rows[fresh.row - 1][2], "OBSERVED");
  assert.equal(JSON.parse(r.p.getProperty("TCF_RUN_JOURNAL")).legacyInspected, false);
  r.env.now += 7 * 60000;
  r.sandbox.checkMonitorHealth();
  assert.equal(r.rows[fresh.row - 1][2], "INCOMPLETE");
  assert.equal(JSON.parse(r.p.getProperty("TCF_RUN_JOURNAL")).interruptions.length, 2);
  assert.equal(JSON.parse(r.p.getProperty("TCF_RUN_JOURNAL")).legacyInspected, true);
});

test("audit verifies timestamps and finds rows shifted by retention without corrupting another row", () => {
  const r = multiRuntime(); r.sandbox.installAllCities();
  const run = seedUnfinished(r);
  const original = [...r.rows[run.row - 2]];
  r.rows.splice(run.row - 1, 0, [...original]);
  r.sandbox.checkMonitorHealth();
  assert.deepEqual(r.rows[run.row - 1], original);
  assert.equal(r.rows[run.row][2], "INCOMPLETE");
});

test("final log failure is recorded as incomplete and a health audit never repeats sent seats", () => {
  const r = multiRuntime(); r.sandbox.installAllCities();
  const seatMails = r.sent.filter(m => m.subject.includes("bookable")).length;
  r.env.now += 300000; r.env.failFinalize = true;
  r.sandbox.checkEdmonton();
  const index = r.rows.length - 1;
  assert.equal(r.rows[index][2], "OBSERVED");
  assert.equal(JSON.parse(r.p.getProperty("TCF_RUN_JOURNAL")).interruptions.length, 1);
  r.env.failFinalize = false;
  r.sandbox.checkMonitorHealth(); r.sandbox.checkEdmonton();
  assert.equal(r.rows[index][2], "INCOMPLETE");
  assert.equal(r.sent.filter(m => m.subject.includes("bookable")).length, seatMails);
  assert.equal(r.rows.at(-1)[2], "SUCCESS");
});

test("unfinished-run warnings retry failed email delivery without suppressing coverage warnings", () => {
  const r = multiRuntime(); r.sandbox.installAllCities(); seedUnfinished(r);
  r.env.failEmail = true; r.sandbox.checkMonitorHealth();
  assert.equal(r.p.getProperty("TCF_LAST_RUN_WARNING_MS"), null);
  r.env.failEmail = false; r.sandbox.checkMonitorHealth();
  assert.ok(r.p.getProperty("TCF_LAST_RUN_WARNING_MS"));
  const emails = r.sent.length;
  r.triggers.splice(r.triggers.findIndex(t => t.handler === "checkEdmonton"), 1);
  r.sandbox.checkMonitorHealth();
  assert.equal(r.sent.length, emails + 1);
  assert.match(r.sent.at(-1).body, /Expected one check trigger; found 0/);
});

test("legacy timer event migrates to five independent managed timers without resetting state", () => {
  const r = multiRuntime(); r.sandbox.dryRunAllCities(); r.sandbox.checkAllCities();
  const state = loadState(r.p), before = r.sent.length;
  const legacy = { getHandlerFunction: () => "checkAllCities" };
  const daily = { getHandlerFunction: () => "sendAllDailyReport" };
  const unrelated = { getHandlerFunction: () => "unrelated" };
  r.triggers.push(legacy, daily, unrelated);
  r.sandbox.checkAllCities({ triggerUid: "legacy-id" });
  assert.equal(r.triggers.length, 6);
  assert.ok(r.triggers.includes(daily)); assert.ok(r.triggers.includes(unrelated));
  assert.ok(!r.triggers.includes(legacy));
  assert.deepEqual(loadState(r.p).seen, state.seen);
  assert.equal(r.sent.length, before);
  r.sandbox.migrateToIsolatedChecks();
  assert.equal(r.triggers.length, 6);
  assert.ok(r.p.getProperty("TCF_ISOLATED_CHECKS_INSTALLED_AT"));
});

test("migration creation failure rolls back new timers and preserves the working combined timer", () => {
  const r = multiRuntime(); r.sandbox.dryRunAllCities();
  const legacy = { getHandlerFunction: () => "checkAllCities" }; r.triggers.push(legacy);
  r.env.failTrigger = "checkMontreal";
  r.sandbox.checkAllCities({ triggerUid: "legacy-id" });
  assert.deepEqual(r.triggers, [legacy]);
  assert.ok(loadState(r.p).lastSuccess); assert.ok(loadState(r.p, "MONTREAL_STATE_").lastSuccess);
  r.env.failTrigger = null; r.sandbox.checkAllCities({ triggerUid: "legacy-id" });
  assert.equal(r.triggers.length, 5);
});

test("partial legacy deletion failure retains replacement timers and supports idempotent retry", () => {
  const r = multiRuntime();
  r.triggers.push({ getHandlerFunction: () => "checkAllCities" }, { getHandlerFunction: () => "sendDailyReport" });
  r.env.failDelete = "sendDailyReport";
  assert.throws(() => r.sandbox.migrateToIsolatedChecks(), /deletion/);
  assert.equal(r.triggers.length, 6);
  for (const handler of ["checkEdmonton", "checkNorthYork", "checkMontreal", "checkMonitorHealth", "sendAllDailyReport"]) {
    assert.ok(r.triggers.some(t => t.getHandlerFunction() === handler));
  }
  r.env.failDelete = null; r.sandbox.migrateToIsolatedChecks();
  assert.equal(r.triggers.length, 5);
});

test("manual combined checks never install or migrate schedules", () => {
  const r = multiRuntime(); r.sandbox.dryRunAllCities(); r.sandbox.checkAllCities();
  assert.equal(r.triggers.length, 0);
  assert.equal(r.p.getProperty("TCF_ISOLATED_CHECKS_INSTALLED_AT"), null);
});

test("three-city installation upgrades in place, keeps Edmonton history and is idempotent", () => {
  const r = multiRuntime(); r.sandbox.installPilot();
  const history = loadState(r.p).recent.length;
  const unrelated = { getHandlerFunction: () => "unrelated" }; r.triggers.push(unrelated);
  r.sandbox.installAllCities(); r.sandbox.installAllCities();
  assert.equal(r.env.spreadsheetCreated, 1);
  assert.equal(r.sheets.size, 3);
  assert.equal(loadState(r.p).recent.length, history + 2);
  assert.equal(r.triggers.length, 6);
  assert.ok(r.triggers.includes(unrelated));
  for (const handler of ["checkEdmonton", "checkNorthYork", "checkMontreal"]) {
    assert.equal(r.triggers.find(t => t.handler === handler).minutes, 5);
  }
  assert.equal(r.triggers.find(t => t.handler === "checkMonitorHealth").minutes, 15);
  assert.equal(r.triggers.filter(t => t.handler === "checkAllCities").length, 0);
  assert.equal(r.sent.filter(m => m.subject.includes("[TCF Montreal]")).length, 1);
  assert.equal(r.p.getProperty("TCF_MONTREAL_LOG_SPREADSHEET_ID"), "test-spreadsheet");
  assert.match(r.sandbox.showAllStatus(), /Preference: North York > Edmonton > Montreal/);
  r.sandbox.stopPilot();
  assert.equal(r.triggers.length, 1);
  assert.ok(loadState(r.p, "MONTREAL_STATE_").lastSuccess);
});
test("dry-run all cities changes no alert history, email or heartbeat", () => {
  const r = multiRuntime();
  assert.equal(r.sandbox.dryRunAllCities().length, 3);
  assert.equal(r.sent.length, 0);
  assert.equal(r.calls.filter(c => c.url.includes("hc-ping")).length, 0);
  assert.equal(r.p.getProperty("MONTREAL_STATE_ACTIVE"), null);
  assert.equal(r.sheets.get("North York").rows.length, 2);
  assert.equal(r.sheets.get("Montreal").rows.length, 2);
});

test("settings are read once per check but refreshed on the next invocation", () => {
  const r = multiRuntime(); r.sandbox.dryRun();
  const original = r.p.getProperty.bind(r.p); let reads = 0;
  r.p.getProperty = key => { if (key === "TCF_HEALTHCHECKS_URL") reads++; return original(key); };
  r.sandbox.checkEdmonton();
  assert.equal(reads, 1);
  const updated = heartbeat.replace(/1$/, "4"); r.p.setProperty("TCF_HEALTHCHECKS_URL", updated);
  r.sandbox.checkEdmonton();
  assert.equal(reads, 2);
  assert.equal(r.calls.filter(c => c.url === updated).length, 1);
  assert.equal(r.rows.at(-1).length, 11);
  assert.equal(r.rows.at(-1)[1], "CHECK");
  assert.equal(r.rows.at(-1)[2], "SUCCESS");
  assert.match(r.rows.at(-1)[9], /Heartbeat: OK/);
  assert.equal(JSON.parse(r.rows.at(-1)[10]).length, 1);
});
test("a failing North York website cannot suppress Montreal or make its own watchdog healthy", () => {
  const r = multiRuntime(); r.sandbox.dryRunAllCities();
  r.env.providerRoute = url => url.includes("activecommunities") ? { status: 503, body: "down" } : providerRoute(url);
  assert.throws(() => r.sandbox.checkAllCities(), /North York.*503/);
  assert.ok(loadState(r.p).lastSuccess);
  assert.ok(loadState(r.p, "MONTREAL_STATE_").lastSuccess);
  assert.equal(loadState(r.p, "NORTH_YORK_STATE_").lastSuccess, null);
  assert.equal(loadState(r.p, "NORTH_YORK_STATE_").failures, 1);
  assert.equal(r.calls.filter(c => c.url === heartbeat.replace(/1$/, "2")).length, 0);
  assert.equal(r.calls.filter(c => c.url === heartbeat.replace(/1$/, "3")).length, 1);
  assert.equal(r.sent.filter(m => m.subject.includes("[TCF Montreal]")).length, 1);
  assert.equal(r.sheets.get("North York").rows.at(-1)[2], "FAILED");
  r.env.providerRoute = providerRoute; r.env.now += 300000; r.sandbox.checkAllCities();
  assert.equal(loadState(r.p, "NORTH_YORK_STATE_").failures, 0);
  assert.equal(r.sent.filter(m => m.subject.includes("[TCF Montreal]")).length, 1);
});
test("North York 202 gap preserves history, records diagnostics, isolates watchdogs and recovers", () => {
  const r = multiRuntime();
  const route = (url, options) => url.includes("activecommunities")
    ? response(url.endsWith("/list") ? search([candidate()]) : url.includes("buttonstatus") ? button() : detail())
    : providerRoute(url, options);
  r.env.providerRoute = route; r.sandbox.dryRunAllCities(); r.sandbox.checkAllCities();
  const before = loadState(r.p, "NORTH_YORK_STATE_");
  const nyPing = heartbeat.replace(/1$/, "2");
  r.env.providerRoute = (url, options) => url.includes("activecommunities") ? {
    status: 202, body: "SECRET_RESPONSE", contentType: "text/html",
    headers: { "X-Amzn-Waf-Action": "challenge", "Retry-After": "300", "Set-Cookie": "SECRET_COOKIE" },
  } : providerRoute(url, options);
  for (let i = 1; i <= 10; i++) {
    r.env.now += 300000;
    assert.throws(() => r.sandbox.checkAllCities(), /North York.*HTTP 202/);
    const state = loadState(r.p, "NORTH_YORK_STATE_");
    assert.equal(state.failures, i);
    assert.equal(state.lastSuccess, before.lastSuccess);
    assert.deepEqual(state.seen, before.seen);
    assert.match(state.lastCheckFailure.details, /AWS WAF challenge header.*retry-after=300 seconds/);
  }
  const failed = loadState(r.p, "NORTH_YORK_STATE_");
  assert.equal(r.calls.filter(c => c.url === nyPing).length, 1);
  for (const suffix of ["1", "3"]) assert.equal(r.calls.filter(c => c.url === heartbeat.replace(/1$/, suffix)).length, 11);
  assert.equal(r.sent.filter(m => m.subject.includes("[TCF North York health]")).length, 1);
  assert.match(r.sandbox.showAllStatus(), /Consecutive failed checks: 10/);
  assert.match(r.sandbox.showAllStatus(), /Last successful snapshot \(not a live count\)/);
  assert.match(r.sheets.get("North York").rows.at(-1)[9], /AWS WAF challenge header/);
  assert.doesNotMatch(JSON.stringify([r.messages, r.sent, failed, r.sheets.get("North York").rows]), /SECRET/);
  r.env.providerRoute = route; r.env.now += 300000; r.sandbox.checkAllCities();
  const recovered = loadState(r.p, "NORTH_YORK_STATE_");
  assert.equal(recovered.failures, 0);
  assert.equal(recovered.lastSuccess, new Date(r.env.now).toISOString());
  assert.deepEqual(recovered.lastCheckFailure, failed.lastCheckFailure);
  assert.equal(recovered.lastCheckRecovery.gapMinutes, 55);
  assert.equal(r.calls.filter(c => c.url === nyPing).length, 2);
  assert.equal(r.sent.filter(m => m.subject.includes("[TCF Montreal]")).length, 1);
  assert.equal(r.sent.filter(m => m.subject.includes("[TCF North York]")).length, 1);
  assert.match(r.sandbox.showAllStatus(), /observation gap: 55 minutes/);
});
test("a North York 202 does not erase an unsent alert; recovery revalidates before sending", () => {
  const r = multiRuntime();
  const route = (url, options) => url.includes("activecommunities")
    ? response(url.endsWith("/list") ? search([candidate()]) : url.includes("buttonstatus") ? button() : detail())
    : providerRoute(url, options);
  r.env.providerRoute = route; r.sandbox.dryRunAllCities(); r.env.failEmail = true;
  assert.throws(() => r.sandbox.checkAllCities(), /Email transport failed/);
  const before = loadState(r.p, "NORTH_YORK_STATE_").seen;
  assert.equal(Object.keys(before).length, 1);
  r.env.failEmail = false; r.env.now += 300000;
  r.env.providerRoute = (url, options) => url.includes("activecommunities") ? { status: 202, body: "" } : providerRoute(url, options);
  assert.throws(() => r.sandbox.checkAllCities(), /HTTP 202/);
  assert.deepEqual(loadState(r.p, "NORTH_YORK_STATE_").seen, before);
  assert.equal(r.sent.filter(m => m.subject.includes("[TCF North York]")).length, 0);
  r.env.providerRoute = route; r.env.now += 300000; r.sandbox.checkAllCities();
  r.env.now += 300000; r.sandbox.checkAllCities();
  assert.equal(r.sent.filter(m => m.subject.includes("[TCF North York]")).length, 1);
});
test("failed North York dry-run logs diagnostics without changing saved health or watchdog", () => {
  const r = multiRuntime(); r.sandbox.dryRunAllCities(); r.sandbox.checkAllCities();
  const before = loadState(r.p, "NORTH_YORK_STATE_");
  const pings = r.calls.filter(c => c.url.includes("hc-ping")).length;
  const mails = r.sent.length;
  r.env.providerRoute = () => ({ status: 202, body: "", contentType: "text/html", headers: { "X-Amzn-Waf-Action": "challenge" } });
  assert.throws(() => r.sandbox.dryRunNorthYork(), /HTTP 202/);
  assert.deepEqual(loadState(r.p, "NORTH_YORK_STATE_"), before);
  assert.match(r.sheets.get("North York").rows.at(-1)[9], /AWS WAF challenge header/);
  assert.equal(r.calls.filter(c => c.url.includes("hc-ping")).length, pings);
  assert.equal(r.sent.length, mails);
});
test("installation leaves the working schedule untouched on validation failure or overlap", () => {
  const r = multiRuntime(); r.sandbox.installPilot();
  const old = [...r.triggers];
  r.env.locked = true;
  assert.throws(() => r.sandbox.installAllCities(), /validation/);
  assert.deepEqual(r.triggers, old);
  r.env.locked = false;
  r.env.providerRoute = () => ({ status: 503, body: "down" });
  assert.throws(() => r.sandbox.installAllCities(), /503/);
  assert.deepEqual(r.triggers, old);
});
test("installation rolls back new triggers if the daily trigger cannot be created", () => {
  const r = multiRuntime(); r.sandbox.installPilot(); const old = [...r.triggers];
  r.env.failTrigger = "sendAllDailyReport";
  assert.throws(() => r.sandbox.installAllCities(), /Trigger creation failed/);
  assert.deepEqual(r.triggers, old);
});
test("a corrupt city history stays an explicit failure while other cities continue", () => {
  const r = multiRuntime(); r.sandbox.dryRunAllCities();
  r.p.setProperty("NORTH_YORK_STATE_ACTIVE", "broken");
  assert.throws(() => r.sandbox.checkAllCities(), /North York/);
  assert.ok(loadState(r.p, "MONTREAL_STATE_").lastSuccess);
  assert.equal(r.p.getProperty("NORTH_YORK_STATE_ACTIVE"), "broken");
});

test("multiple simulated days retain bounded 24-hour runtime history without repeated seat emails", () => {
  const r = multiRuntime(); r.sandbox.dryRunAllCities(); r.env.quota = 1000;
  for (let i = 0; i < 600; i++) { r.sandbox.checkAllCities(); r.env.now += 300000; }
  for (const prefix of ["EDMONTON_STATE_", "NORTH_YORK_STATE_", "MONTREAL_STATE_"]) {
    const state = loadState(r.p, prefix);
    assert.equal(state.recent.length, 289);
    assert.equal(state.failures, 0);
  }
  assert.equal(r.sent.filter(m => m.subject.includes("[TCF Montreal]")).length, 1);
});

test("generated bundle runs without Node/browser APIs in the Apps Script V8 environment", () => {
  const r = runtime();
  assert.equal(typeof r.sandbox.installPilot, "function");
  r.sandbox.dryRun();
  assert.equal(r.rows.length, 2);
  assert.equal(r.sent.length, 0);
  assert.equal(r.p.getProperty("EDMONTON_STATE_ACTIVE"), null);
  assert.equal(r.calls.filter(call => call.url.startsWith("https://hc-ping.com/")).length, 0);
});
test("installation is idempotent, uses five minutes, and leaves other triggers intact", () => {
  const r = runtime();
  const unrelated = { getHandlerFunction: () => "unrelated" };
  r.triggers.push(unrelated);
  r.sandbox.installPilot();
  r.sandbox.installPilot();
  assert.equal(r.triggers.length, 3);
  assert.ok(r.triggers.includes(unrelated));
  assert.equal(r.triggers.filter(t => t.handler === "checkEdmonton")[0].minutes, 5);
  assert.equal(r.env.spreadsheetCreated, 1);
  assert.equal(r.sent.filter(m => m.subject.includes("bookable")).length, 1);
  assert.ok(loadState(r.p).lastSuccess);
});
test("normal checks send one email and suppress unchanged repeats", () => {
  const r = runtime();
  r.sandbox.dryRun();
  r.sandbox.checkEdmonton();
  r.env.now += 300000;
  r.sandbox.checkEdmonton();
  assert.equal(r.sent.length, 1);
  assert.equal(loadState(r.p).recent.length, 2);
  assert.equal(loadState(r.p).recent[1].gapMs, 300000);
  assert.match(r.sent[0].body, /No seat has been reserved/);
});

test("Edmonton recovers from the live duplicate-offer failure, emails the opening once and resumes its watchdog", () => {
  const r = multiRuntime(); r.sandbox.dryRunAllCities();
  r.env.now = Date.parse("2026-09-09T20:55:00Z");
  r.env.html = readFileSync(new URL("./fixtures/edmonton-2026-09-09.html", import.meta.url), "utf8");
  const results = r.sandbox.checkAllCities();
  assert.equal(results[0].outcome, "SUCCESS");
  assert.equal(results[0].heartbeat, "OK");
  const emails = r.sent.filter(m => m.subject.includes("[TCF Edmonton]"));
  assert.equal(emails.length, 1); assert.match(emails[0].body, /October 7/); assert.match(emails[0].body, /exam_id=155/);
  assert.match(r.rows.at(-1)[9], /non-overlapping registration windows/);
  assert.equal(loadState(r.p).lastRowCount, 26);
  assert.equal(loadState(r.p).lastAvailableCount, 1);
  r.env.now += 300000; r.sandbox.checkAllCities();
  assert.equal(r.sent.filter(m => m.subject.includes("[TCF Edmonton]")).length, 1);
  assert.equal(r.calls.filter(c => c.url === heartbeat).length, 2);
});
test("closed seats do not send mail and retain the full observed snapshot", () => {
  const r = runtime();
  r.env.html = page(row({ bookings: "Closed", spots: "1" }));
  r.sandbox.dryRun(); r.sandbox.checkEdmonton();
  assert.equal(r.sent.length, 0);
  assert.equal(JSON.parse(r.rows.at(-1)[10])[0].reason, "closed");
});
test("email failure leaves pending events for a fresh retry and never pings success", () => {
  const r = runtime();
  r.p.setProperty("TCF_HEALTHCHECKS_URL", heartbeat);
  r.sandbox.dryRun();
  r.env.failEmail = true;
  assert.throws(() => r.sandbox.checkEdmonton(), /Email transport failed/);
  assert.equal(loadState(r.p).lastSuccess, null);
  assert.equal(Object.values(loadState(r.p).seen)[0].notified, false);
  assert.equal(r.calls.filter(c => c.url === heartbeat).length, 0);
  r.env.failEmail = false;
  r.sandbox.checkEdmonton();
  assert.equal(r.sent.filter(m => m.subject.includes("bookable")).length, 1);
  assert.equal(r.calls.filter(c => c.url === heartbeat).length, 1);
});
test("mail quota exhaustion does not lose pending seat alerts", () => {
  const r = runtime(); r.sandbox.dryRun(); r.env.quota = 0;
  assert.throws(() => r.sandbox.checkEdmonton(), /quota/);
  assert.equal(Object.values(loadState(r.p).seen)[0].notified, false);
  r.env.quota = 10;
  r.sandbox.checkEdmonton();
  assert.equal(r.sent.filter(m => m.subject.includes("bookable")).length, 1);
});
test("retries validate current availability rather than mailing obsolete pending events", () => {
  const r = runtime(); r.sandbox.dryRun(); r.env.failEmail = true;
  assert.throws(() => r.sandbox.checkEdmonton());
  r.env.failEmail = false; r.env.html = page(row({ spots: "SOLD OUT!", bookings: "Closed" }));
  r.sandbox.checkEdmonton();
  assert.equal(r.sent.filter(m => m.subject.includes("bookable")).length, 0);
});
test("network failure preserves the last successful observation and does not signal health", () => {
  const r = runtime(); r.p.setProperty("TCF_HEALTHCHECKS_URL", heartbeat);
  r.sandbox.dryRun(); r.sandbox.checkEdmonton();
  const previous = loadState(r.p);
  r.env.now += 300000; r.env.http = 503;
  assert.throws(() => r.sandbox.checkEdmonton(), /503/);
  assert.equal(loadState(r.p).lastSuccess, previous.lastSuccess);
  assert.deepEqual(loadState(r.p).seen, previous.seen);
  assert.equal(r.calls.filter(c => c.url === heartbeat).length, 1);
  assert.equal(r.rows.at(-1)[2], "FAILED");
});
test("failed logging is not reported as a successful monitored check", () => {
  const r = runtime(); r.p.setProperty("TCF_HEALTHCHECKS_URL", heartbeat);
  r.env.html = page(row({ bookings: "Closed" })); r.sandbox.dryRun(); r.env.failLog = true;
  assert.throws(() => r.sandbox.checkEdmonton(), /Log write failed/);
  assert.equal(loadState(r.p).lastSuccess, null);
  assert.equal(r.calls.filter(c => c.url === heartbeat).length, 0);
});
test("failed state write cannot claim successful monitoring", () => {
  const r = runtime(); r.p.setProperty("TCF_HEALTHCHECKS_URL", heartbeat);
  r.sandbox.dryRun(); r.p.failWrite = true;
  assert.throws(() => r.sandbox.checkEdmonton(), /Storage unavailable/);
  assert.equal(r.calls.filter(c => c.url === heartbeat).length, 0);
});
test("overlapping runs do not read the website, send email, or ping the watchdog", () => {
  const r = runtime(); r.env.locked = true;
  assert.equal(r.sandbox.checkEdmonton().outcome, "SKIPPED_OVERLAP");
  assert.equal(r.calls.length, 0);
  assert.equal(r.sent.length, 0);
});
test("a failed success-state commit cannot advance lastSuccess through error recovery", () => {
  const r = runtime(); r.p.setProperty("TCF_HEALTHCHECKS_URL", heartbeat);
  r.env.html = page(row({ bookings: "Closed" })); r.sandbox.dryRun();
  const original = r.p.setProperty.bind(r.p);
  let failOnce = true;
  r.p.setProperty = (key, value) => {
    if (failOnce && key === "EDMONTON_STATE_ACTIVE") { failOnce = false; throw new Error("Commit failed"); }
    return original(key, value);
  };
  assert.throws(() => r.sandbox.checkEdmonton(), /Commit failed/);
  assert.equal(loadState(r.p).lastSuccess, null);
  assert.equal(loadState(r.p).recent.filter(check => check.ok).length, 0);
  assert.equal(r.calls.filter(call => call.url === heartbeat).length, 0);
});
test("all failure paths release the execution lock", () => {
  const r = runtime(); r.sandbox.dryRun(); const before = r.env.released; r.env.http = 500;
  assert.throws(() => r.sandbox.checkEdmonton());
  assert.equal(r.env.released, before + 2);
});
test("health emails are separate from seat alerts and are throttled", () => {
  const r = runtime(); r.env.html = page(row({ bookings: "Closed" })); r.sandbox.dryRun(); r.sandbox.checkEdmonton();
  r.env.http = 500;
  for (let i = 0; i < 5; i += 1) { r.env.now += 300000; assert.throws(() => r.sandbox.checkEdmonton()); }
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0].subject, /health/);
  assert.equal(loadState(r.p).failures, 5);
});
function seedRuntime(r, minutes, prefix = "EDMONTON_STATE_") {
  const state = loadState(r.p, prefix);
  state.recent = Array.from({ length: 12 }, (_, i) => ({
    at: r.env.now - (12 - i) * 300000, ok: true, durationMs: minutes * 60000 / 12, gapMs: 300000,
  }));
  saveState(r.p, state, prefix);
}
test("healthy high-runtime checks explain the advisory without claiming a monitoring failure", () => {
  const r = multiRuntime(); r.sandbox.dryRun(); r.sandbox.checkEdmonton();
  seedRuntime(r, 20.1); r.env.now += 300000;
  const result = r.sandbox.checkEdmonton();
  assert.equal(result.outcome, "SUCCESS"); assert.equal(result.heartbeat, "OK");
  const advisory = r.sent.find(m => m.subject.includes("runtime"));
  assert.equal(advisory.subject, "[TCF Edmonton runtime] Runtime budget advisory");
  assert.match(advisory.body, /20\.1 measured minutes.*threshold: over 20 minutes/);
  assert.match(advisory.body, /Latest check and alert processing succeeded/);
  assert.match(advisory.body, /not a seat alert or a report that a check failed/);
  assert.match(advisory.body, /Measured check runtime in last 24 hours: 20\.1 minutes/);
  assert.doesNotMatch(advisory.body, /after a monitoring interruption/);
  assert.equal(r.sent.filter(m => m.subject.includes("health")).length, 0);
  assert.equal(r.p.getProperty("TCF_LAST_HEALTH_WARNING_MS"), null);
  r.env.now += 300000; r.sandbox.checkEdmonton();
  assert.equal(r.sent.filter(m => m.subject.includes("runtime")).length, 1);
  r.env.now += 6 * 3600000; r.sandbox.checkEdmonton();
  assert.equal(r.sent.filter(m => m.subject.includes("runtime")).length, 2);
});
test("runtime advisory preserves its threshold snapshot when a 24-hour entry expires while sending", () => {
  const r = multiRuntime(); r.sandbox.dryRun(); r.sandbox.checkEdmonton();
  r.env.now += 300000; seedRuntime(r, 20);
  const state = loadState(r.p);
  state.recent.unshift({ at: r.env.now - 86400000, ok: true, durationMs: 6000, gapMs: 300000 });
  saveState(r.p, state);
  const get = r.p.getProperty.bind(r.p);
  r.p.getProperty = name => { if (name === "TCF_LAST_RUNTIME_WARNING_MS") r.env.now++; return get(name); };
  r.sandbox.checkEdmonton();
  const advisory = r.sent.find(m => m.subject.includes("runtime"));
  assert.match(advisory.body, /threshold crossed: 20\.1/);
  assert.match(advisory.body, /Measured check runtime in last 24 hours: 20\.1 minutes/);
  assert.match(r.sandbox.showStatus(), /Measured check runtime in last 24 hours: 20 minutes/);
});
test("runtime advisory cannot suppress a later real check or heartbeat warning", () => {
  const r = multiRuntime(); r.sandbox.dryRun(); r.sandbox.checkEdmonton();
  seedRuntime(r, 21); r.env.now += 300000; r.sandbox.checkEdmonton();
  assert.equal(r.sent.filter(m => m.subject.includes("runtime")).length, 1);
  r.env.pingRoute = () => ({ status: 403 }); r.env.now += 300000; r.sandbox.checkEdmonton();
  r.env.http = 503;
  for (let i = 0; i < 3; i++) { r.env.now += 300000; assert.throws(() => r.sandbox.checkEdmonton()); }
  assert.equal(r.sent.filter(m => m.subject.includes("health")).length, 2);
  assert.equal(loadState(r.p).failures, 3);
});
test("city and combined runtime advisories keep independent thresholds and cooldowns", () => {
  const r = multiRuntime(); r.sandbox.dryRunAllCities(); r.sandbox.checkAllCities();
  for (const prefix of ["EDMONTON_STATE_", "NORTH_YORK_STATE_", "MONTREAL_STATE_"]) seedRuntime(r, 20, prefix);
  r.env.now += 300000; r.sandbox.checkAllCities();
  assert.equal(r.sent.filter(m => m.subject.includes("runtime")).length, 0);
  seedRuntime(r, 20.1); r.env.now += 300000; r.sandbox.checkAllCities();
  const advisories = r.sent.filter(m => m.subject.includes("runtime"));
  assert.equal(advisories.length, 2);
  const combined = advisories.find(m => m.subject.includes("Combined"));
  assert.match(combined.body, /60\.1 measured minutes.*threshold: over 60 minutes/);
  assert.match(combined.body, /North York: 20\.0 minutes/);
  assert.match(combined.body, /Edmonton: 20\.1 minutes/);
  assert.match(combined.body, /Montreal: 20\.0 minutes/);
  assert.ok(r.p.getProperty("TCF_LAST_RUNTIME_WARNING_MS"));
  assert.ok(r.p.getProperty("TCF_LAST_COMBINED_RUNTIME_WARNING_MS"));
  assert.equal(r.p.getProperty("TCF_LAST_HEALTH_WARNING_MS"), null);
  r.env.now += 300000; r.sandbox.checkAllCities();
  assert.equal(r.sent.filter(m => m.subject.includes("runtime")).length, 2);
});
test("private heartbeat URL is never written into logs or health emails", () => {
  const r = runtime(); r.p.setProperty("TCF_HEALTHCHECKS_URL", heartbeat); r.env.failPing = true;
  r.sandbox.dryRun(); r.sandbox.checkEdmonton();
  assert.equal(r.p.getProperty("TCF_LAST_HEARTBEAT_STATUS"), "FAILED");
  assert.ok(!JSON.stringify([r.messages, r.rows, r.sent]).includes(heartbeat));
});

test("a fast transient heartbeat failure retries once and records recovery without warning", () => {
  const r = multiRuntime(); r.sandbox.dryRun(); let attempts = 0;
  r.env.pingRoute = () => ++attempts === 1 ? { error: `Transport failed ${heartbeat}` } : { status: 200, body: "OK" };
  const result = r.sandbox.checkEdmonton();
  assert.equal(result.heartbeat, "OK");
  assert.equal(attempts, 2);
  assert.match(result.details, /Attempt 1: Transport failed.*Attempt 2: HTTP 200 OK/);
  assert.equal(r.sent.filter(m => m.subject.includes("health")).length, 0);
  assert.ok(!JSON.stringify([r.messages, r.rows, r.sent]).includes(heartbeat));
  assert.equal(JSON.parse(r.p.getProperty("TCF_HEARTBEAT_DELIVERY")).failures, 0);
});

test("exhausted retries escalate on the third failed check, reset on recovery and do not repeat seat mail", () => {
  const r = runtime(); r.p.setProperty("TCF_HEALTHCHECKS_URL", heartbeat); r.sandbox.dryRun();
  r.sandbox.checkEdmonton(); const accepted = JSON.parse(r.p.getProperty("TCF_HEARTBEAT_DELIVERY")).lastSuccessAt;
  r.env.failPing = true;
  for (let i = 1; i <= 4; i++) {
    r.env.now += 300000;
    assert.equal(r.sandbox.checkEdmonton().heartbeat, "FAILED");
    const history = JSON.parse(r.p.getProperty("TCF_HEARTBEAT_DELIVERY"));
    assert.equal(history.failures, i); assert.equal(history.lastSuccessAt, accepted);
    assert.equal(r.sent.filter(m => m.subject.includes("health")).length, i < 3 ? 0 : 1);
  }
  assert.equal(r.calls.filter(c => c.url === heartbeat).length, 9);
  assert.equal(loadState(r.p).failures, 0);
  assert.equal(r.rows.at(-1)[2], "SUCCESS");
  assert.match(r.sent.at(-1).body, /Seat check and alert processing succeeded/);
  assert.ok(!JSON.stringify([r.messages, r.rows, r.sent]).includes(heartbeat));
  r.env.failPing = false; r.env.now += 300000; r.sandbox.checkEdmonton();
  const history = JSON.parse(r.p.getProperty("TCF_HEARTBEAT_DELIVERY"));
  assert.equal(history.failures, 0); assert.ok(history.lastRecoveryAt); assert.ok(history.lastFailureAt);
  assert.match(r.sandbox.showStatus(), /Last recovery.*2026/);
  r.env.failPing = true; r.env.now += 300000; r.sandbox.checkEdmonton();
  assert.equal(JSON.parse(r.p.getProperty("TCF_HEARTBEAT_DELIVERY")).failures, 1);
  assert.equal(r.sent.filter(m => m.subject.includes("bookable")).length, 1);
});

test("slow failed heartbeat requests do not add another request", () => {
  const r = multiRuntime(); r.sandbox.dryRun();
  r.env.pingRoute = () => ({ status: 503, durationMs: 5000 });
  assert.equal(r.sandbox.checkEdmonton().heartbeat, "FAILED");
  assert.equal(r.calls.filter(c => c.url === heartbeat).length, 1);
});

test("a fast server error can recover on its single retry", () => {
  const r = multiRuntime(); r.sandbox.dryRun(); let n = 0;
  r.env.pingRoute = () => ++n === 1 ? { status: 503 } : { status: 200, body: "OK" };
  assert.equal(r.sandbox.checkEdmonton().heartbeat, "OK");
  assert.equal(n, 2);
});

test("permanent watchdog rejection warns immediately without retries or response-body leaks", () => {
  for (const response of [{ status: 403, body: heartbeat }, { status: 200, body: "OK (not found)" },
    { status: 200, body: "not found" }, { error: `Service invoked too many times for one day: ${heartbeat}` }]) {
    const r = multiRuntime(); r.sandbox.dryRun(); r.env.pingRoute = () => response;
    assert.equal(r.sandbox.checkEdmonton().heartbeat, "FAILED");
    assert.equal(r.calls.filter(c => c.url === heartbeat).length, 1);
    assert.equal(r.sent.filter(m => m.subject.includes("health")).length, 1);
    assert.ok(!JSON.stringify([r.messages, r.rows, r.sent]).includes(heartbeat));
  }
});

test("rate limiting is not accepted as success and Retry-After survives later scheduled checks", () => {
  for (const response of [{ status: 200, body: "OK (rate limited)" }, { status: 429, headers: { "Retry-After": "900" } },
    { status: 503, headers: { "Retry-After": "Tue, 08 Sep 2026 18:15:00 GMT" } }]) {
    const r = multiRuntime(); r.sandbox.dryRun(); r.env.pingRoute = () => response;
    assert.equal(r.sandbox.checkEdmonton().heartbeat, "FAILED");
    const until = JSON.parse(r.p.getProperty("TCF_HEARTBEAT_DELIVERY")).retryAfterAt;
    assert.ok(until >= r.env.now + 300000);
    r.env.now += 60000; r.sandbox.checkEdmonton();
    assert.equal(r.calls.filter(c => c.url === heartbeat).length, 1);
    assert.match(r.rows.at(-1)[9], /Waiting until/);
    r.env.now = until; r.env.pingRoute = () => ({ status: 200, body: "OK" });
    assert.equal(r.sandbox.checkEdmonton().heartbeat, "OK");
    assert.equal(r.calls.filter(c => c.url === heartbeat).length, 2);
  }
});

test("unexpected HTTP 200 content cannot claim healthy or leak arbitrary content", () => {
  const r = multiRuntime(); r.sandbox.dryRun(); r.env.pingRoute = () => ({ status: 200, body: `<html>${heartbeat}</html>` });
  assert.equal(r.sandbox.checkEdmonton().heartbeat, "FAILED");
  assert.match(r.rows.at(-1)[9], /unexpected acknowledgement/);
  assert.ok(!JSON.stringify(r.messages).includes(heartbeat));
});

test("North York watchdog failure remains isolated and reports include its diagnostics", () => {
  const r = multiRuntime(); r.sandbox.dryRunAllCities();
  r.env.pingRoute = url => url.endsWith("2") ? { status: 502 } : { status: 200, body: "OK" };
  for (let i = 0; i < 3; i++) { r.sandbox.checkAllCities(); r.env.now += 300000; }
  assert.equal(r.p.getProperty("TCF_LAST_HEARTBEAT_STATUS"), "OK");
  assert.equal(r.p.getProperty("TCF_NORTH_YORK_LAST_HEARTBEAT_STATUS"), "FAILED");
  assert.equal(r.p.getProperty("TCF_MONTREAL_LAST_HEARTBEAT_STATUS"), "OK");
  assert.equal(r.sent.filter(m => m.subject.includes("North York health")).length, 1);
  const before = r.calls.length; r.sandbox.sendAllDailyReport();
  assert.equal(r.calls.length, before);
  assert.match(r.sent.at(-1).body, /Consecutive delivery failures: 3; latest attempts: 2/);
  assert.match(r.sent.at(-1).body, /HTTP 502/);
  assert.equal(r.sent.filter(m => m.subject.includes("[TCF Montreal]")).length, 1);
});

test("heartbeat and website warnings have independent throttles", () => {
  const r = multiRuntime(); r.sandbox.dryRun(); r.env.pingRoute = () => ({ status: 403 });
  r.sandbox.checkEdmonton(); r.env.http = 503;
  for (let i = 0; i < 3; i++) { r.env.now += 300000; assert.throws(() => r.sandbox.checkEdmonton()); }
  assert.equal(r.sent.filter(m => m.subject.includes("health")).length, 2);
});

test("unreadable heartbeat history cannot silently restart the warning threshold", () => {
  const r = multiRuntime(); r.sandbox.dryRun(); r.p.setProperty("TCF_HEARTBEAT_DELIVERY", "broken");
  r.env.failPing = true; r.sandbox.checkEdmonton();
  assert.equal(r.sent.filter(m => m.subject.includes("health")).length, 1);
  assert.match(r.sent.at(-1).body, /history could not be read or saved/);
});

test("ten minutes of unresolved delivery failure warns even with fewer than three checks", () => {
  const r = multiRuntime(); r.sandbox.dryRun(); r.env.failPing = true;
  r.sandbox.checkEdmonton(); r.env.now += 600000; r.sandbox.checkEdmonton();
  assert.equal(r.sent.filter(m => m.subject.includes("health")).length, 1);
  assert.equal(JSON.parse(r.p.getProperty("TCF_HEARTBEAT_DELIVERY")).failures, 2);
});

test("failed heartbeat-history storage is visible without invalidating a committed seat check", () => {
  const r = multiRuntime(); r.sandbox.dryRun();
  const original = r.p.setProperty.bind(r.p);
  r.p.setProperty = (key, value) => {
    if (key === "TCF_HEARTBEAT_DELIVERY") throw new Error("Storage unavailable");
    return original(key, value);
  };
  assert.equal(r.sandbox.checkEdmonton().outcome, "SUCCESS");
  assert.ok(loadState(r.p).lastSuccess);
  assert.equal(r.sent.filter(m => m.subject.includes("health")).length, 1);
  assert.match(r.rows.at(-1)[9], /Storage unavailable/);
});
test("stopping the pilot removes only its triggers and retains history", () => {
  const r = runtime(); r.sandbox.installPilot(); const previous = loadState(r.p);
  r.sandbox.stopPilot();
  assert.equal(r.triggers.length, 0);
  assert.deepEqual(loadState(r.p), previous);
});
test("manual email and watchdog tests do not create a false successful observation", () => {
  const r = runtime(); r.sandbox.testAlert();
  assert.equal(loadState(r.p).lastSuccess, null);
  r.p.setProperty("TCF_HEALTHCHECKS_URL", heartbeat); r.sandbox.testWatchdogFailure();
  assert.equal(r.calls.at(-1).url, `${heartbeat}/fail`);
  assert.equal(loadState(r.p).lastSuccess, null);
});
test("status inspection and daily report do not refresh the success heartbeat", () => {
  const r = runtime(); r.sandbox.installPilot(); const before = r.calls.length;
  const status = r.sandbox.showStatus(); r.sandbox.sendDailyReport();
  assert.match(status, /NOT CONFIGURED/);
  assert.equal(r.calls.length, before);
});
