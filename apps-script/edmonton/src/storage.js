export function emptyState() {
  return { version: 1, seen: {}, recent: [], lastSuccess: null, failures: 0 };
}

export function loadState(properties, PREFIX = "EDMONTON_STATE_") {
  const pointer = properties.getProperty(`${PREFIX}ACTIVE`);
  if (!pointer) return emptyState();
  const { bank, count } = JSON.parse(pointer);
  if (!["A", "B"].includes(bank) || !Number.isInteger(count) || count < 1 || count > 24) {
    throw new Error("Invalid state manifest; refusing to reset notification history.");
  }
  const parts = [];
  for (let i = 0; i < count; i += 1) {
    const value = properties.getProperty(`${PREFIX}${bank}_${i}`);
    if (value === null) throw new Error("Incomplete state; refusing to reset notification history.");
    parts.push(value);
  }
  const state = JSON.parse(parts.join(""));
  if (state.version !== 1 || !state.seen || !Array.isArray(state.recent)) throw new Error("Unsupported state format.");
  return state;
}

export function saveState(properties, state, PREFIX = "EDMONTON_STATE_", maxChunks = 24) {
  // ASCII chunks stay below Apps Script's 9 KB per-value limit, even for French text.
  const json = JSON.stringify(state).replace(/[\u007f-\uffff]/g, c =>
    `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const chunks = json.match(/[\s\S]{1,7500}/g);
  if (chunks.length > maxChunks) throw new Error("State exceeds its storage budget; preserving the previous state.");
  const pointer = properties.getProperty(`${PREFIX}ACTIVE`);
  const bank = pointer && JSON.parse(pointer).bank === "A" ? "B" : "A";
  const values = {};
  chunks.forEach((chunk, i) => { values[`${PREFIX}${bank}_${i}`] = chunk; });
  // Write the inactive bank first. A failed write must not corrupt the active state.
  properties.setProperties(values, false);
  properties.setProperty(`${PREFIX}ACTIVE`, JSON.stringify({ bank, count: chunks.length }));
}

export function summarize(state, now = Date.now()) {
  const cutoff = now - 86400000;
  const recent = state.recent.filter(check => check.at >= cutoff);
  const successes = recent.filter(check => check.ok);
  const gaps = successes.map(check => check.gapMs || 0);
  const currentGap = state.lastSuccess ? now - Date.parse(state.lastSuccess) : null;
  const runtimes = recent.map(check => check.durationMs);
  return {
    lastSuccess: state.lastSuccess,
    minutesSinceSuccess: currentGap === null ? null : Math.round(currentGap / 60000),
    successfulChecks24h: successes.length,
    failedChecks24h: recent.length - successes.length,
    longestGapMinutes24h: Math.round(Math.max(0, currentGap || 0, ...gaps) / 60000),
    measuredRuntimeMinutes24h: Math.round(runtimes.reduce((a, b) => a + b, 0) / 6000) / 10,
    averageRuntimeSeconds24h: runtimes.length ? Math.round(runtimes.reduce((a, b) => a + b, 0) / runtimes.length / 100) / 10 : null,
    consecutiveFailures: state.failures,
  };
}
