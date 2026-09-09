import { parseDocument } from "htmlparser2";
import URLParse from "url-parse";

export const PAGE_URL = "https://www.afedmonton.com/en/exams/tcf/";
export const INTERVAL_MINUTES = 5;
export const HEADERS = ["exam", "schedules", "registration dates", "location", "spots left", "price", "bookings"];
const SOLD_OUT = /\b(sold\s*out|fully booked|full|no spots?|cancelled|canceled)\b/i;
const CLOSED = /\b(closed|not available|unavailable|not open|registration ended|opens? (?:in|on|soon)|wait\s*list|on hold)\b/i;
const ACTION = /^(book(?: now)?|register(?: now)?)$/i;

export function clean(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function descendants(node, predicate) {
  const result = [];
  function visit(current) {
    if (predicate(current)) result.push(current);
    for (const child of current.children || []) visit(child);
  }
  visit(node);
  return result;
}

function hidden(node) {
  const a = node.attribs || {};
  return "hidden" in a || "disabled" in a || a["aria-disabled"] === "true" ||
    a["aria-hidden"] === "true" || /(?:^|\s)(?:disabled|is-disabled|d-none)(?:\s|$)/i.test(a.class || "") ||
    /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(a.style || "");
}

function textContent(node) {
  if (["script", "style", "template"].includes(node.name)) return "";
  if (node.type === "text") return node.data;
  if (node.name === "br") return " ";
  const content = (node.children || []).map(textContent).join("");
  return ["div", "p", "li"].includes(node.name) ? ` ${content} ` : content;
}

function active(node, ancestor) {
  for (let current = node; current; current = current.parent) {
    if (hidden(current)) return false;
    if (current === ancestor) return true;
  }
  return false;
}

function officialUrl(href, base = PAGE_URL) {
  const url = new URLParse(href, base, true);
  if (url.protocol !== "https:" || url.host !== "www.afedmonton.com" || url.auth || url.hash) {
    throw new Error("Unexpected URL in the official schedule; refusing to follow it.");
  }
  return url;
}

export function scheduleUrl(start = 0) {
  const url = officialUrl(PAGE_URL);
  url.set("query", { "s8-datatable1_rows": "200", "s8-datatable1_start": String(start) });
  return url.toString();
}

function nextPage(href, base) {
  const url = officialUrl(href, base);
  if (url.pathname !== "/en/exams/tcf/") throw new Error("Unexpected schedule pagination path.");
  const start = url.query["s8-datatable1_start"];
  if (!/^\d+$/.test(start || "")) throw new Error("Pagination has no valid starting row.");
  return url.toString();
}

function bookingLink(node, cell) {
  if (!active(node, cell) || !ACTION.test(clean(textContent(node)))) return null;
  try {
    const url = officialUrl(node.attribs.href || "");
    if (url.pathname === "/af/exam-selector/order/" && /^\d+$/.test(url.query.exam_id || "")) {
      return url.toString();
    }
    if (/^\/products\/tcf-canada-[a-z0-9-]+\/?$/i.test(url.pathname)) return url.toString();
  } catch (_) {
    // An untrusted or unsupported link is not evidence of a bookable seat.
  }
  return null;
}

export function parsePage(html, pageUrl = scheduleUrl()) {
  const document = parseDocument(html, { decodeEntities: true });
  const tables = descendants(document, n => n.name === "table" && n.attribs.id === "s8-datatable1");
  if (tables.length !== 1) throw new Error("Expected exactly one Edmonton schedule table.");
  const table = tables[0];
  if (descendants(table, n => n.name === "table").length !== 1) throw new Error("Nested schedule table is unsupported.");
  const trs = descendants(table, n => n.name === "tr");
  const rows = [];
  let headerSeen = false;
  for (const tr of trs) {
    const cells = (tr.children || []).filter(n => ["td", "th"].includes(n.name));
    if (!cells.length) continue;
    const values = cells.map(n => clean(textContent(n)));
    if (values.map(v => v.toLowerCase()).join("|") === HEADERS.join("|")) {
      headerSeen = true;
      continue;
    }
    if (!headerSeen || cells.length !== 7) throw new Error("Schedule columns changed or a row is incomplete.");
    if (!values[0] || !values[1] || !values[2] || !values[3]) throw new Error("Schedule row is missing identifying data.");
    if (!/\btcf canada\b/i.test(values[0])) continue;
    const [exam, schedule, registrationDates, location, spotsLeft, price, bookings] = values;
    const links = descendants(cells[6], n => n.name === "a")
      .map(n => bookingLink(n, cells[6])).filter(Boolean);
    const row = { exam, schedule, registrationDates, location, spotsLeft, price, bookings, links: [...new Set(links)] };
    row.unsupportedAction = !row.links.length && descendants(cells[6], n =>
      ["a", "button", "input"].includes(n.name) && active(n, cells[6]) &&
      ACTION.test(clean(n.name === "input" ? n.attribs.value : textContent(n)))).length > 0;
    // Registration-window edits must not manufacture a new session identity.
    row.key = JSON.stringify([exam.toLowerCase(), schedule.toLowerCase(), location.toLowerCase()]);
    rows.push(row);
  }
  if (!headerSeen) throw new Error("Schedule headers could not be validated.");
  const more = descendants(document, n => n.name === "a" &&
    /(?:^|\s)datashowmore(?:\s|$)/i.test(n.attribs.class || "") && active(n, document));
  if (more.length > 1) throw new Error("Multiple Show More links; cannot prove complete coverage.");
  return { rows, rowCount: trs.filter(tr => (tr.children || []).some(n => n.name === "td")).length,
    next: more.length ? nextPage(more[0].attribs.href, pageUrl) : null };
}

export function fetchComplete(request, now = Date.now, maxPages = 5) {
  const started = now();
  const visited = new Set();
  const rows = new Map();
  let url = scheduleUrl();
  let pages = 0;
  let offset = 0;
  while (url) {
    if (pages >= maxPages || now() - started > 45000) throw new Error("Complete schedule exceeded the page/time budget.");
    if (visited.has(url)) throw new Error("Schedule pagination loop detected.");
    visited.add(url);
    const response = request(url);
    pages += 1;
    if (response.status !== 200) throw new Error(`Edmonton returned HTTP ${response.status}; availability is unknown.`);
    if (response.contentType && !/text\/html/i.test(response.contentType)) throw new Error("Edmonton returned non-HTML content.");
    if (response.body.length > 2000000) throw new Error("Schedule exceeds the response-size budget.");
    const page = parsePage(response.body, url);
    let added = 0;
    for (const row of page.rows) {
      const offers = rows.get(row.key) || [];
      if (offers.some(offer => JSON.stringify(offer) === JSON.stringify(row))) continue;
      offers.push(row);
      rows.set(row.key, offers);
      added += 1;
    }
    if (pages > 1 && page.rows.length && !added) throw new Error("Pagination repeated previously fetched sessions.");
    offset += page.rowCount;
    url = page.next || (page.rowCount >= 200 ? scheduleUrl(offset) : null);
  }
  if (!rows.size) throw new Error("No TCF Canada sessions found; availability is unknown, not sold out.");
  const sessions = [...rows.values()].map(offers => {
    if (offers.length === 1) return offers[0];
    const windows = offers.map(offer => registrationWindow(offer.registrationDates));
    if (windows.some(window => !window) || windows.some((window, i) =>
      windows.slice(i + 1).some(other => window[0] < other[1] && other[0] < window[1]))) {
      throw new Error(`Conflicting duplicate session in the schedule: ${offers[0].exam}; ${offers[0].schedule}. Registration windows overlap or cannot be validated: ${offers.map(offer => offer.registrationDates).join(" | ")}`);
    }
    // The site can retain an expired registration while posting a new one for the same exam.
    const ordered = offers.map((offer, i) => ({ offer, start: windows[i][0] })).sort((a, b) => a.start - b.start);
    return { ...ordered[0].offer, registrationOffers: ordered.map(item => item.offer) };
  });
  const repeated = sessions.filter(row => row.registrationOffers).length;
  return { rows: sessions, pages, detail: repeated ? `${repeated} repeated exam(s) resolved using distinct, non-overlapping registration windows; all offers retained in the snapshot.` : "" };
}

export function registrationWindow(text) {
  const matches = [...text.matchAll(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)\b/gi)];
  if (matches.length !== 2) return null;
  const months = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");
  const times = matches.map(m => {
    const month = months.indexOf(m[1].toLowerCase());
    const day = Number(m[2]), year = Number(m[3]), hour = Number(m[4]), minute = Number(m[5]);
    if (hour < 1 || hour > 12 || minute > 59 || day < 1 || day > 31) return NaN;
    const value = Date.UTC(year, month, day, hour % 12 + (m[6].toLowerCase() === "pm" ? 12 : 0), minute);
    return new Date(value).getUTCDate() === day ? value : NaN;
  });
  return times.every(Number.isFinite) && times[1] > times[0] ? times : null;
}

export function classify(row, edmontonWallTimeMs) {
  const status = `${row.spotsLeft} ${row.bookings}`;
  if (SOLD_OUT.test(status) || /^0(?:\s+spots?(?:\s+left)?)?[!.]?$/i.test(row.spotsLeft)) return { available: false, reason: "sold_out" };
  if (CLOSED.test(row.bookings)) return { available: false, reason: "closed" };
  if (row.unsupportedAction) throw new Error(`Unsupported booking action for ${row.exam}; inspect the official page.`);
  if (!row.links.length) return { available: false, reason: "no_active_booking_link" };
  const window = registrationWindow(row.registrationDates);
  if (!window) throw new Error(`Cannot validate the registration window for ${row.exam}.`);
  if (edmontonWallTimeMs < window[0] || edmontonWallTimeMs >= window[1]) return { available: false, reason: "outside_registration_window" };
  return { available: true, reason: "active_booking_link" };
}

export function evaluate(rows, previous, checkedAt, edmontonWallTimeMs) {
  return evaluateSnapshot(rows.map(row => {
    if (!row.registrationOffers) return { ...row, ...classify(row, edmontonWallTimeMs) };
    const offers = row.registrationOffers.map(offer => ({ ...offer, ...classify(offer, edmontonWallTimeMs) }));
    // Windows are ordered and non-overlapping. Prefer the most recently started offer,
    // or the earliest future offer; an old sold-out row cannot override a new valid offer.
    const started = offers.filter(offer => registrationWindow(offer.registrationDates)[0] <= edmontonWallTimeMs);
    return { ...(started.at(-1) || offers[0]), registrationOffers: offers };
  }), previous, checkedAt);
}

export function evaluateSnapshot(snapshot, previous, checkedAt) {
  const next = { ...previous };
  const events = [];
  const changes = [];
  const present = new Set();
  for (const row of snapshot) {
    present.add(row.key);
    const old = previous[row.key];
    const fingerprint = JSON.stringify([row.spotsLeft, row.bookings, row.links, row.registrationDates, row.available]);
    const priorWindow = row.registrationOffers && old?.fingerprint && registrationWindow(JSON.parse(old.fingerprint)[3]);
    const currentWindow = priorWindow && registrationWindow(row.registrationDates);
    const newOffer = priorWindow && currentWindow && (priorWindow[1] <= currentWindow[0] || currentWindow[1] <= priorWindow[0]);
    const notified = Boolean(old?.available && old?.notified && !newOffer);
    next[row.key] = { available: row.available, notified: row.available && notified, fingerprint, lastSeen: checkedAt };
    if (row.city === "North York") next[row.key].row = { city: row.city, sourceId: row.sourceId,
      examDate: row.examDate, exam: row.exam, location: row.location, price: row.price };
    if (row.available && !notified) events.push(row);
    if (!old || old.fingerprint !== fingerprint) changes.push({ ...row, previousAvailable: old?.available ?? null });
  }
  // Missing rows are unknown, not closed. Preserve notification state across disappearance.
  for (const [key, old] of Object.entries(next)) {
    if (!present.has(key) && Date.parse(checkedAt) - Date.parse(old.lastSeen) > 90 * 86400000) delete next[key];
  }
  return { next, events, changes, snapshot };
}

export function markSent(next, events) {
  for (const row of events) next[row.key].notified = true;
}

export function alertBody(events, checkedAt) {
  return ["TCF Canada Edmonton availability alert (Apps Script pilot)", "",
    `Checked at: ${checkedAt} (UTC)`, `Page: ${PAGE_URL}`, "",
    ...events.flatMap((row, i) => [`${i + 1}. ${row.exam}`, `Schedule: ${row.schedule}`,
      `Registration dates (Edmonton time): ${row.registrationDates}`, `Location: ${row.location}`,
      `Spots left: ${row.spotsLeft}`, `Bookings: ${row.bookings}`, `Price: ${row.price}`,
      `Booking link: ${row.links[0]}`, ""]),
    "The page exposed a booking link during the published registration window. Seats can disappear before you click.",
    "Review the official page before registration or payment. No seat has been reserved."
  ].join("\n");
}
