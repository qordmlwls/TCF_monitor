import { markSent } from "./core.js";
import { loadState, saveState, summarize } from "./storage.js";
import { deliverHeartbeat, recordHeartbeat } from "./heartbeat.js";

export function createMonitorRuntime(profile) {
const PAGE_URL = profile.pageUrl;
const INTERVAL_MINUTES = 5;
const CHECK_HEADERS = ["Checked at (UTC)", "Mode", "Outcome", "Runtime seconds", "Gap since success (minutes)",
  "Pages", "TCF Canada rows", "Available rows", "Alerted rows", "Details", "Full schedule snapshot (JSON)"];
const MANAGED_HANDLERS = [profile.checkHandler, profile.reportHandler];
const key = suffix => `${profile.propertyPrefix}${suffix}`;
const readState = () => loadState(properties(), profile.statePrefix);
const writeState = state => saveState(properties(), state, profile.statePrefix, profile.maxChunks || 8);
let activeConfig = null;

function properties() { return PropertiesService.getScriptProperties(); }
function recentChecks(checks) { return checks.filter(check => check.at >= Date.now() - 86400000).slice(-650); }

function config() {
  if (activeConfig) return activeConfig;
  const p = properties();
  const recipient = p.getProperty("TCF_ALERT_EMAIL_TO") || "qordmlwls@gmail.com";
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(recipient)) throw new Error("Configure one valid TCF_ALERT_EMAIL_TO address.");
  const heartbeat = p.getProperty(key("HEALTHCHECKS_URL")) || "";
  if (heartbeat && !/^https:\/\/hc-ping\.com\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(heartbeat)) {
    throw new Error(`${key("HEALTHCHECKS_URL")} must be the private https://hc-ping.com/<uuid> URL.`);
  }
  return { recipient, heartbeat, spreadsheetId: p.getProperty(key("LOG_SPREADSHEET_ID")) };
}

function logSheet() {
  const id = config().spreadsheetId;
  if (!id) throw new Error("Run installPilot first to create the monitoring log.");
  const sheet = SpreadsheetApp.openById(id).getSheetByName(profile.sheetName);
  if (!sheet || sheet.getRange(1, 1, 1, CHECK_HEADERS.length).getValues()[0].join("|") !== CHECK_HEADERS.join("|")) {
    throw new Error("Monitoring log headers changed; restore the Checks sheet headers.");
  }
  return sheet;
}

function ensureLog() {
  if (config().spreadsheetId) return logSheet();
  const sharedId = properties().getProperty("TCF_LOG_SPREADSHEET_ID");
  const book = sharedId ? SpreadsheetApp.openById(sharedId) : SpreadsheetApp.create("TCF Canada Monitor - Check History");
  const existing = sharedId ? book.getSheetByName(profile.sheetName) : null;
  if (existing) {
    properties().setProperty(key("LOG_SPREADSHEET_ID"), book.getId());
    return logSheet();
  }
  const sheet = sharedId ? book.insertSheet(profile.sheetName) : book.getSheets()[0];
  sheet.setName(profile.sheetName);
  sheet.getRange(1, 1, 1, CHECK_HEADERS.length).setValues([CHECK_HEADERS]);
  sheet.setFrozenRows(1);
  properties().setProperty(key("LOG_SPREADSHEET_ID"), book.getId());
  return sheet;
}

function appendCheck(sheet, result) {
  const snapshot = JSON.stringify(result.snapshot || []);
  if (snapshot.length > 45000) throw new Error("Full snapshot exceeds the log-cell size budget.");
  const row = [result.checkedAt, result.mode, result.outcome, Math.round(result.durationMs / 100) / 10,
    result.gapMs === null ? "" : Math.round(result.gapMs / 6000) / 10, result.pages || 0,
    result.snapshot?.length || 0, result.snapshot?.filter(r => r.available).length || 0,
    result.alerted || 0, result.details || "", snapshot];
  // External page text belongs in plain cells, never spreadsheet formulas.
  sheet.appendRow(row.map(value => typeof value === "string" && /^[=+@-]/.test(value) ? `'${value}` : value));
  const lastRow = sheet.getLastRow();
  if (lastRow > 10001) sheet.deleteRows(2, lastRow - 10001);
  return Math.min(lastRow, 10001);
}

function requestOptions(options = {}) {
  return {
    method: "get", followRedirects: false, muteHttpExceptions: true, validateHttpsCertificates: true,
    ...options,
    headers: { "Cache-Control": "no-cache", "User-Agent": "TCF-Availability-Monitor/3.0 (public schedule checker; no automated registration)", ...options.headers },
  };
}

function responseData(response) {
  const headers = response.getAllHeaders();
  const typeKey = Object.keys(headers).find(key => key.toLowerCase() === "content-type");
  const diagnosticHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (["retry-after", "x-amzn-waf-action", "cf-mitigated"].includes(name.toLowerCase())) diagnosticHeaders[name.toLowerCase()] = String(value);
  }
  return { status: response.getResponseCode(), contentType: typeKey ? String(headers[typeKey]) : "",
    headers: diagnosticHeaders, body: response.getContentText() };
}

function requestPage(url, options) { return responseData(UrlFetchApp.fetch(url, requestOptions(options))); }
function requestBatch(specs) {
  return UrlFetchApp.fetchAll(specs.map(spec => ({ url: spec.url, ...requestOptions(spec.options) }))).map(responseData);
}

function edmontonWallTime(date) {
  return Date.parse(`${Utilities.formatDate(date, profile.timezone, "yyyy-MM-dd'T'HH:mm:ss")}Z`);
}

function send(subject, body, reserve = 0) {
  if (MailApp.getRemainingDailyQuota() <= reserve) throw new Error("Google email quota is too low; pending seat alerts have not been marked sent.");
  MailApp.sendEmail({ to: config().recipient, subject, body, name: `TCF ${profile.label} Monitor` });
}

function safeError(error) {
  return String(error.message || error).replace(/https:\/\/hc-ping\.com\/[^\s)]+/g, "[private heartbeat URL]")
    .replace(/([?&]API_KEY=)[^\s&]+/gi, "$1[public key omitted]").slice(0, 1500);
}

function pingHeartbeat() {
  const p = properties();
  let previous = {}, diagnosticError = "";
  try {
    previous = JSON.parse(p.getProperty(key("HEARTBEAT_DELIVERY")) || "{}");
    if (!previous || typeof previous !== "object" || Array.isArray(previous)) throw new Error("Invalid heartbeat history");
  } catch (error) { previous = {}; diagnosticError = safeError(error); }
  const delivery = deliverHeartbeat((url, options) => UrlFetchApp.fetch(url, options), () => Date.now(), safeError,
    config().heartbeat, `${profile.label} complete check and alert processing succeeded.`, previous);
  const history = recordHeartbeat(previous, delivery, Date.now());
  try {
    p.setProperties({ [key("LAST_HEARTBEAT_STATUS")]: delivery.status, [key("HEARTBEAT_DELIVERY")]: JSON.stringify(history) });
  } catch (error) { diagnosticError = safeError(error); }
  if (diagnosticError) {
    history.needsWarning = true;
    history.details += ` Heartbeat history could not be read or saved: ${diagnosticError}.`;
  }
  console.log(JSON.stringify({ city: profile.label, heartbeatDelivery: history }));
  return history;
}

function healthWarning(body, channel = "HEALTH") {
  const p = properties();
  const warningKey = key(`LAST_${channel}_WARNING_MS`);
  const last = Number(p.getProperty(warningKey) || 0);
  if (Date.now() - last < 6 * 3600000) return;
  try {
    send(`[TCF ${profile.label} health] Monitoring needs attention`, `${body}\n\nThis is a monitoring warning, not a seat-availability alert.\n${statusText()}`, 5);
    p.setProperty(warningKey, String(Date.now()));
  } catch (error) { console.error(`Health email could not be sent: ${safeError(error)}`); }
}

function runCheck(dryRun) {
  const started = Date.now();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    console.warn("Skipped overlapping check; this is not a successful observation.");
    return { outcome: "SKIPPED_OVERLAP" };
  }
  let state, sheet, result;
  let recorded = false;
  try {
    activeConfig = config();
    sheet = logSheet();
    state = readState();
    const fetched = profile.fetch(requestPage, { seen: state.seen, today: Utilities.formatDate(new Date(), profile.timezone, "yyyy-MM-dd") }, requestBatch);
    const checkedAt = new Date().toISOString();
    const assessment = profile.evaluate(fetched.rows, state.seen, checkedAt, edmontonWallTime(new Date(checkedAt)));
    result = { checkedAt, mode: dryRun ? "DRY_RUN" : "CHECK", outcome: "SUCCESS", pages: fetched.pages,
      snapshot: assessment.snapshot, alerted: 0, durationMs: Date.now() - started,
      gapMs: state.lastSuccess ? Date.parse(checkedAt) - Date.parse(state.lastSuccess) : null };
    if (dryRun) {
      result.details = `${assessment.events.length} potential alerts. No email, state change, or heartbeat.`;
      appendCheck(sheet, result);
      console.log(JSON.stringify({ ...result, snapshot: undefined, rows: result.snapshot.length,
        available: result.snapshot.filter(row => row.available).length, note: "Full snapshot saved in the check-history sheet." }));
      return result;
    }
    state.seen = assessment.next;
    if (assessment.events.length) {
      // Persist pending alerts before sending. A failed email is retried after fresh revalidation.
      writeState(state);
      send(`[TCF ${profile.label}] ${assessment.events.length} bookable session(s) - Apps Script`, profile.alertBody(assessment.events, checkedAt));
      markSent(state.seen, assessment.events);
      writeState(state);
      result.alerted = assessment.events.length;
    }
    result.details = config().heartbeat ? "Heartbeat pending." : "External watchdog NOT CONFIGURED.";
    result.durationMs = Date.now() - started;
    const loggedRow = appendCheck(sheet, { ...result, outcome: "OBSERVED" });
    const previousFailures = state.failures;
    const completed = { ...state, lastSuccess: checkedAt, failures: 0, lastRowCount: fetched.rows.length,
      lastAvailableCount: assessment.snapshot.filter(row => row.available).length,
      recent: recentChecks([...state.recent, { at: Date.parse(checkedAt), ok: true, durationMs: Date.now() - started, gapMs: result.gapMs }]) };
    if (previousFailures > 0) completed.lastCheckRecovery = { at: checkedAt,
      gapMinutes: result.gapMs === null ? null : Math.round(result.gapMs / 60000) };
    writeState(completed);
    state = completed;
    recorded = true;
    const heartbeatDelivery = pingHeartbeat();
    const heartbeat = heartbeatDelivery.status;
    try {
      result.details = `Heartbeat: ${heartbeat}. ${heartbeatDelivery.details} Consecutive delivery failures: ${heartbeatDelivery.failures}. Changed rows: ${assessment.changes.length}. ${fetched.detail || ""}`;
      // Finalize the diagnostic columns together to avoid repeated remote sheet calls.
      sheet.getRange(loggedRow, 3, 1, 8).setValues([["SUCCESS", Math.round((Date.now() - started) / 100) / 10,
        result.gapMs === null ? "" : Math.round(result.gapMs / 6000) / 10, result.pages || 0,
        result.snapshot.length, result.snapshot.filter(row => row.available).length, result.alerted, result.details]]);
    } catch (error) { console.warn(`Post-check diagnostics could not be updated: ${safeError(error)}`); }
    console.log(JSON.stringify({ ...result, snapshot: undefined, heartbeat, durationMs: Date.now() - started }));
    if (heartbeatDelivery.needsWarning) {
      healthWarning(`Seat check and alert processing succeeded. The independent watchdog delivery needs attention.\nConsecutive delivery failures: ${heartbeatDelivery.failures}. ${heartbeatDelivery.details}`, "HEARTBEAT");
    }
    if ((result.gapMs || 0) > 15 * 60000 || previousFailures >= 3 || summarize(state).measuredRuntimeMinutes24h > 20) {
      healthWarning(`Latest check succeeded. Previous gap: ${Math.round((result.gapMs || 0) / 60000)} minutes. Heartbeat: ${heartbeat}.`);
    }
    return { ...result, heartbeat };
  } catch (error) {
    const message = safeError(error);
    console.error(message);
    if (!dryRun && state && !recorded) {
      state.failures += 1;
      state.lastCheckFailure = { at: new Date().toISOString(), details: message };
      state.recent.push({ at: Date.now(), ok: false, durationMs: Date.now() - started });
      state.recent = recentChecks(state.recent);
      try { writeState(state); } catch (saveError) { console.error(safeError(saveError)); }
    }
    try {
      if (sheet) appendCheck(sheet, { ...result, checkedAt: new Date().toISOString(), mode: dryRun ? "DRY_RUN" : "CHECK",
        outcome: "FAILED", durationMs: Date.now() - started, gapMs: null, details: message });
    } catch (logError) { console.error(`Failed to record check: ${safeError(logError)}`); }
    if (!dryRun && (!state || state.failures >= 3 || !state.lastSuccess || Date.now() - Date.parse(state.lastSuccess) > 15 * 60000)) healthWarning(message);
    throw new Error(message);
  } finally {
    activeConfig = null;
    lock.releaseLock();
  }
}

function check() { return runCheck(false); }
function dryRun() { ensureLog(); return runCheck(true); }

function testAlert() {
  send(`[TCF ${profile.label} TEST] Apps Script email delivery`, `This is a test of the Google-hosted ${profile.label} monitor.\nNo available seat has been detected or reserved.\n\nRunning this test does not start scheduled monitoring.`);
  console.log("Google accepted the test email. Confirm it arrived in your inbox.");
}

function statusText() {
  const state = readState();
  const stats = summarize(state);
  const c = config();
  let heartbeatDetail = "Heartbeat delivery diagnostics: not recorded yet.";
  try {
    const h = JSON.parse(properties().getProperty(key("HEARTBEAT_DELIVERY")) || "null");
    if (h) heartbeatDetail = [`Watchdog last accepted delivery (UTC): ${h.lastSuccessAt || "NONE RECORDED"}`,
      `Consecutive delivery failures: ${h.failures}; latest attempts: ${h.attempts}`,
      `Latest delivery details: ${h.details}`,
      `Last failed delivery (UTC): ${h.lastFailureAt || "NONE RECORDED"}${h.lastFailureDetail ? `; ${h.lastFailureDetail}` : ""}`,
      `Last recovery (UTC): ${h.lastRecoveryAt || "NONE RECORDED"}`].join("\n");
  } catch (_) { heartbeatDetail = "Heartbeat delivery diagnostics could not be read; inspect execution logs."; }
  const enabled = ScriptApp.getProjectTriggers().filter(t => [profile.checkHandler, "checkAllCities"].includes(t.getHandlerFunction())).length;
  return [`TCF ${profile.label} monitor health (not a seat alert)`, "",
    `Five-minute check triggers: ${enabled} (expected 1)`,
    `Last successful check (UTC): ${stats.lastSuccess || "NONE"}`,
    `Minutes since success: ${stats.minutesSinceSuccess ?? "UNKNOWN"}`,
    `Successful checks in last 24 hours: ${stats.successfulChecks24h} (288 expected after a full day)`,
    `Failed checks in last 24 hours: ${stats.failedChecks24h}`,
    `Consecutive failed checks: ${state.failures}`,
    `Last recorded check failure (UTC): ${state.lastCheckFailure ? `${state.lastCheckFailure.at}; ${state.lastCheckFailure.details}` : "NONE RECORDED"}`,
    `Last check recovery (UTC): ${state.lastCheckRecovery ? `${state.lastCheckRecovery.at}; observation gap: ${state.lastCheckRecovery.gapMinutes ?? "UNKNOWN"} minutes` : "NONE RECORDED"}`,
    `Longest observed gap in last 24 hours: ${stats.longestGapMinutes24h} minutes`,
    `Measured check runtime in last 24 hours: ${stats.measuredRuntimeMinutes24h} minutes`,
    `Average check runtime: ${stats.averageRuntimeSeconds24h ?? "UNKNOWN"} seconds`,
    "Runtime is an estimate, not Google's account-wide quota counter; other scripts and reporting use additional time.",
    `Last successful snapshot (not a live count): sessions ${state.lastRowCount ?? "UNKNOWN"}; available ${state.lastAvailableCount ?? "UNKNOWN"}`,
    `External watchdog: ${c.heartbeat ? `configured; last delivery ${properties().getProperty(key("LAST_HEARTBEAT_STATUS")) || "NOT YET TESTED"}` : "NOT CONFIGURED - a stopped script cannot warn you"}`,
    heartbeatDetail,
    `Check history: ${c.spreadsheetId ? `https://docs.google.com/spreadsheets/d/${c.spreadsheetId}/edit` : "NOT CREATED"}`,
    "", "A successful check describes one observation, not guaranteed continuous coverage.", PAGE_URL].join("\n");
}

function showStatus() { const status = statusText(); console.log(status); return status; }

function sendDailyReport() {
  send(`[TCF ${profile.label} health] Daily monitoring report`, statusText(), 5);
}

function installPilot() {
  config();
  ensureLog();
  dryRun();
  const existing = ScriptApp.getProjectTriggers().filter(t => MANAGED_HANDLERS.includes(t.getHandlerFunction()));
  const created = [];
  try {
    created.push(ScriptApp.newTrigger(profile.checkHandler).timeBased().everyMinutes(INTERVAL_MINUTES).create());
    created.push(ScriptApp.newTrigger(profile.reportHandler).timeBased().atHour(18).everyDays(1).inTimezone("America/Edmonton").create());
  } catch (error) {
    created.forEach(trigger => ScriptApp.deleteTrigger(trigger));
    throw error;
  }
  existing.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  properties().setProperty(key("PILOT_INSTALLED_AT"), new Date().toISOString());
  check();
  send(`[TCF ${profile.label} health] Five-minute pilot installed`, statusText(), 5);
  return showStatus();
}

function stopPilot() {
  ScriptApp.getProjectTriggers().filter(t => MANAGED_HANDLERS.includes(t.getHandlerFunction()))
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
  console.log("Apps Script pilot stopped. History and notification state were preserved. GitHub Actions was not changed. The external watchdog will alert unless paused separately.");
}

function testWatchdogFailure() {
  const url = config().heartbeat;
  if (!url) throw new Error(`Configure ${key("HEALTHCHECKS_URL")} before testing the independent warning.`);
  const response = UrlFetchApp.fetch(`${url}/fail`, { method: "post", payload: "Intentional watchdog notification test.", muteHttpExceptions: true, followRedirects: false });
  if (response.getResponseCode() !== 200) throw new Error("Watchdog test could not be delivered.");
  console.log("Intentional DOWN signal sent. Verify the external warning email; the next successful scheduled check restores UP.");
}

return { check, dryRun, testAlert, showStatus, statusText, sendDailyReport, installPilot, stopPilot, testWatchdogFailure,
  ensureLog, summary: () => summarize(readState()), send, config, healthWarning };
}
