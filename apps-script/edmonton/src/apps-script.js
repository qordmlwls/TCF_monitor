import { PAGE_URL, fetchComplete, evaluate, evaluateSnapshot, alertBody } from "./core.js";
import { NORTH_YORK_PAGE, MONTREAL_PAGE, fetchNorthYork, fetchMontreal, preferredAlertBody } from "./providers.js";
import { createMonitorRuntime } from "./runtime.js";

const edmonton = createMonitorRuntime({
  label: "Edmonton", pageUrl: PAGE_URL, propertyPrefix: "TCF_", statePrefix: "EDMONTON_STATE_",
  sheetName: "Checks", timezone: "America/Edmonton", maxChunks: 12,
  checkHandler: "checkEdmonton", reportHandler: "sendDailyReport",
  fetch: request => fetchComplete(request), evaluate, alertBody,
});
const northYork = createMonitorRuntime({
  label: "North York", pageUrl: NORTH_YORK_PAGE, propertyPrefix: "TCF_NORTH_YORK_", statePrefix: "NORTH_YORK_STATE_",
  sheetName: "North York", timezone: "America/Toronto", maxChunks: 10, checkHandler: "checkNorthYork", reportHandler: "sendNorthYorkReport",
  fetch: fetchNorthYork, evaluate: evaluateSnapshot, alertBody: preferredAlertBody,
});
const montreal = createMonitorRuntime({
  label: "Montreal", pageUrl: MONTREAL_PAGE, propertyPrefix: "TCF_MONTREAL_", statePrefix: "MONTREAL_STATE_",
  sheetName: "Montreal", timezone: "America/Toronto", checkHandler: "checkMontreal", reportHandler: "sendMontrealReport",
  fetch: fetchMontreal, evaluate: evaluateSnapshot, alertBody: preferredAlertBody,
});
const preference = [["North York", northYork], ["Edmonton", edmonton], ["Montreal", montreal]];
const allHandlers = ["checkAllCities", "sendAllDailyReport", "checkEdmonton", "sendDailyReport"];
const hasAllTrigger = () => ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === "checkAllCities");

export function checkEdmonton() { return edmonton.check(); }
export function dryRun() { return edmonton.dryRun(); }
export function testAlert() { return edmonton.testAlert(); }
export function showStatus() { return edmonton.showStatus(); }
export function sendDailyReport() { return edmonton.sendDailyReport(); }
export function testWatchdogFailure() { return edmonton.testWatchdogFailure(); }
export function installPilot() { return hasAllTrigger() ? installAllCities() : edmonton.installPilot(); }
export function stopPilot() { return hasAllTrigger() ? stopAllCities() : edmonton.stopPilot(); }
export function dryRunNorthYork() { return northYork.dryRun(); }
export function dryRunMontreal() { return montreal.dryRun(); }
export function testNorthYorkWatchdog() { return northYork.testWatchdogFailure(); }
export function testMontrealWatchdog() { return montreal.testWatchdogFailure(); }

export function dryRunAllCities() {
  edmonton.ensureLog();
  return preference.map(([city, monitor]) => ({ city, ...monitor.dryRun() }));
}

export function checkAllCities() {
  const results = [], errors = [];
  // Observe the existing home monitor first if an added provider later stalls.
  for (const [city, monitor] of [["Edmonton", edmonton], ["North York", northYork], ["Montreal", montreal]]) {
    try { results.push({ city, ...monitor.check() }); }
    catch (error) { errors.push(`${city}: ${error.message}`); }
  }
  console.log(JSON.stringify(results.map(({ city, checkedAt, outcome, heartbeat, alerted }) => ({ city, checkedAt, outcome, heartbeat, alerted }))));
  try {
    const totalMinutes = preference.reduce((sum, [, monitor]) => sum + monitor.summary().measuredRuntimeMinutes24h, 0);
    if (totalMinutes > 60) edmonton.healthWarning(`Combined measured runtime: ${totalMinutes.toFixed(1)} minutes in 24 hours. All scripts share Google's daily runtime quota; review frequency.`);
  } catch (error) { errors.push(`Combined health report: ${error.message}`); }
  if (errors.length) throw new Error(`Some cities could not be checked; other cities were still processed. ${errors.join(" | ")}`);
  return results;
}

function allStatusText() {
  return ["TCF Canada preferred-centre monitoring", "Preference: North York > Edmonton > Montreal",
    ...preference.map(([, monitor]) => monitor.statusText()),
    "All cities share the same Google account quotas. Check combined runtime, not only each city separately.",
  ].join("\n\n");
}
export function showAllStatus() { const text = allStatusText(); console.log(text); return text; }
export function sendAllDailyReport() { edmonton.send("[TCF health] North York, Edmonton, Montreal daily report", allStatusText(), 5); }

export function installAllCities() {
  const validation = dryRunAllCities();
  if (validation.some(result => result.outcome !== "SUCCESS")) throw new Error("All cities must pass validation before replacing the existing schedule. Try again when no check is running.");
  const old = ScriptApp.getProjectTriggers().filter(t => allHandlers.includes(t.getHandlerFunction()));
  const created = [];
  try {
    created.push(ScriptApp.newTrigger("checkAllCities").timeBased().everyMinutes(5).create());
    created.push(ScriptApp.newTrigger("sendAllDailyReport").timeBased().atHour(18).everyDays(1).inTimezone("America/Edmonton").create());
  } catch (error) { created.forEach(t => ScriptApp.deleteTrigger(t)); throw error; }
  old.forEach(t => ScriptApp.deleteTrigger(t));
  PropertiesService.getScriptProperties().setProperty("TCF_ALL_CITIES_INSTALLED_AT", new Date().toISOString());
  checkAllCities();
  edmonton.send("[TCF health] Three-centre five-minute monitor installed", allStatusText(), 5);
  return showAllStatus();
}

export function stopAllCities() {
  ScriptApp.getProjectTriggers().filter(t => allHandlers.includes(t.getHandlerFunction())).forEach(t => ScriptApp.deleteTrigger(t));
  console.log("Google-hosted monitoring stopped. History and GitHub monitoring were preserved. Independent watchdogs remain active.");
}
