// Delivery is independent of seat-check success. Never turn an ignored ping into OK.
export function deliverHeartbeat(fetch, now, sanitize, url, payload, previous = {}) {
  if (!url) return { status: "NOT_CONFIGURED", attempts: 0, details: "External watchdog not configured." };
  if (previous.retryAfterAt > now()) {
    return { status: "FAILED", attempts: 0, retryAfterAt: previous.retryAfterAt,
      details: `Waiting until ${new Date(previous.retryAfterAt).toISOString()} before retrying the watchdog.` };
  }
  const started = now();
  const diagnostics = [];
  let permanent = false, retryAfterAt = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let retryable = false;
    try {
      const response = fetch(url, { method: "post", contentType: "text/plain", payload,
        followRedirects: false, muteHttpExceptions: true, validateHttpsCertificates: true });
      const status = response.getResponseCode();
      const body = response.getContentText().trim();
      if (status === 200 && body === "OK") {
        diagnostics.push(`Attempt ${attempt}: HTTP 200 OK.`);
        return { status: "OK", attempts: attempt, details: diagnostics.join(" ") };
      }
      // Only classify documented response bodies; never copy arbitrary server content.
      const ignored = status !== 200 ? null : ["OK (not found)", "not found"].includes(body) ? "not found"
        : ["OK (rate limited)", "rate limited"].includes(body) ? "rate limited" : null;
      diagnostics.push(`Attempt ${attempt}: HTTP ${status}${ignored ? ` (${ignored})` : status === 200 ? " (unexpected acknowledgement)" : ""}.`);
      const rateLimited = status === 429 || ignored === "rate limited";
      permanent = !rateLimited && ((status >= 400 && status < 500 && status !== 408) || ignored === "not found");
      retryable = [408, 500, 502, 503, 504].includes(status);
      const headers = response.getAllHeaders();
      const retryHeader = Object.keys(headers).find(key => key.toLowerCase() === "retry-after");
      const value = retryHeader ? String(headers[retryHeader]).trim() : "";
      const requested = /^\d+$/.test(value) ? now() + Number(value) * 1000 : Date.parse(value);
      if (rateLimited || requested > now()) retryAfterAt = Math.max(now() + 300000, requested || 0);
    } catch (error) {
      const detail = sanitize(error);
      diagnostics.push(`Attempt ${attempt}: ${detail}.`);
      permanent = /quota|too many times|permission|authorization|certificate|invalid argument/i.test(detail);
      retryable = !permanent;
    }
    // No sleeps. A slow request is not repeated; UrlFetchApp has no timeout option.
    if (!retryable || permanent || retryAfterAt || now() - started >= 5000 || attempt === 2) {
      return { status: "FAILED", attempts: attempt, permanent, retryAfterAt, details: diagnostics.join(" ") };
    }
  }
}

export function recordHeartbeat(previous, delivery, now) {
  const at = new Date(now).toISOString();
  const failed = delivery.status === "FAILED";
  const failures = failed ? (previous.failures || 0) + 1 : 0;
  const firstFailureAt = failed ? previous.firstFailureAt || at : null;
  const recovered = delivery.status === "OK" && previous.failures > 0;
  return { status: delivery.status, attempts: delivery.attempts, details: delivery.details, failures, firstFailureAt,
    lastSuccessAt: delivery.status === "OK" ? at : previous.lastSuccessAt || null,
    lastFailureAt: failed ? at : previous.lastFailureAt || null,
    lastFailureDetail: failed ? delivery.details : previous.lastFailureDetail || null,
    lastRecoveryAt: recovered ? at : previous.lastRecoveryAt || null,
    retryAfterAt: delivery.retryAfterAt || null,
    needsWarning: failed && (Boolean(delivery.permanent) || failures >= 3 || now - Date.parse(firstFailureAt) >= 600000),
  };
}
