import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { page, row, at, Properties } from "./fixtures.mjs";
import { loadState } from "../src/storage.js";

const source = readFileSync(new URL("../dist/Code.gs", import.meta.url), "utf8");
const heartbeat = "https://hc-ping.com/00000000-0000-4000-8000-000000000001";
function runtime() {
  const p = new Properties();
  const rows = [];
  const sent = [];
  const calls = [];
  const messages = [];
  const triggers = [];
  const env = { html: page(row()), http: 200, locked: false, quota: 100, failEmail: false, failLog: false, failPing: false,
    released: 0, now: Date.parse(at), spreadsheetCreated: 0 };
  const sheet = {
    setName() {}, setFrozenRows() {},
    appendRow(values) { if (env.failLog) throw new Error("Log write failed"); rows.push([...values]); },
    getLastRow() { return rows.length; }, deleteRows(start, n) { rows.splice(start - 1, n); },
    getRange(r, c, nr = 1, nc = 1) { return {
      getValues() { return Array.from({ length: nr }, (_, i) => (rows[r - 1 + i] || []).slice(c - 1, c - 1 + nc)); },
      setValues(values) { values.forEach((value, i) => { rows[r - 1 + i] = [...value]; }); },
      setValue(value) { rows[r - 1][c - 1] = value; },
    }; },
  };
  const book = { getSheets: () => [sheet], getSheetByName: () => sheet, getId: () => "test-spreadsheet" };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [env.now])); }
    static now() { return env.now; }
  }
  const sandbox = {
    Date: Clock,
    console: { log: (...args) => messages.push(args.join(" ")), warn: (...args) => messages.push(args.join(" ")), error: (...args) => messages.push(args.join(" ")) },
    PropertiesService: { getScriptProperties: () => p },
    LockService: { getScriptLock: () => ({ tryLock: () => !env.locked, releaseLock: () => { env.released += 1; } }) },
    SpreadsheetApp: { create: () => { env.spreadsheetCreated += 1; return book; }, openById: () => book },
    UrlFetchApp: { fetch: (url, options) => {
      calls.push({ url, options });
      const ping = url.startsWith("https://hc-ping.com/");
      if (ping && env.failPing) throw new Error(`Transport failed ${url}`);
      return { getResponseCode: () => ping ? 200 : env.http, getContentText: () => env.html, getAllHeaders: () => ({ "Content-Type": "text/html; charset=utf-8" }) };
    } },
    Utilities: { formatDate: date => new Date(date.getTime() - 6 * 3600000).toISOString().slice(0, 19) },
    MailApp: { getRemainingDailyQuota: () => env.quota, sendEmail: email => {
      if (env.failEmail) throw new Error("Email transport failed");
      sent.push(email); env.quota -= 1;
    } },
    ScriptApp: {
      getProjectTriggers: () => [...triggers],
      deleteTrigger: trigger => { triggers.splice(triggers.indexOf(trigger), 1); },
      newTrigger: handler => {
        const trigger = { getHandlerFunction: () => handler, handler };
        const builder = { timeBased() { return this; }, everyMinutes(n) { trigger.minutes = n; return this; },
          atHour(n) { trigger.hour = n; return this; }, everyDays(n) { trigger.days = n; return this; },
          inTimezone(zone) { trigger.zone = zone; return this; }, create() { triggers.push(trigger); return trigger; } };
        return builder;
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { sandbox, p, rows, sent, calls, messages, env, triggers };
}

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
  assert.equal(r.env.released, before + 1);
});
test("health emails are separate from seat alerts and are throttled", () => {
  const r = runtime(); r.env.html = page(row({ bookings: "Closed" })); r.sandbox.dryRun(); r.sandbox.checkEdmonton();
  r.env.http = 500;
  for (let i = 0; i < 5; i += 1) { r.env.now += 300000; assert.throws(() => r.sandbox.checkEdmonton()); }
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0].subject, /health/);
  assert.equal(loadState(r.p).failures, 5);
});
test("private heartbeat URL is never written into logs or health emails", () => {
  const r = runtime(); r.p.setProperty("TCF_HEALTHCHECKS_URL", heartbeat); r.env.failPing = true;
  r.sandbox.dryRun(); r.sandbox.checkEdmonton();
  assert.equal(r.p.getProperty("TCF_LAST_HEARTBEAT_STATUS"), "FAILED");
  assert.ok(!JSON.stringify([r.messages, r.rows, r.sent]).includes(heartbeat));
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
