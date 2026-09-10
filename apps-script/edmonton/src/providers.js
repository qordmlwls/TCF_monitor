import URLParse from "url-parse";
import { clean } from "./core.js";

export const NORTH_YORK_PAGE = "https://www.alliance-francaise.ca/en/exams/tests/informations-about-tcf-canada/tcf-canada";
export const ACTIVE_BASE = "https://anc.ca.apm.activecommunities.com/aftoronto";
export const MONTREAL_PAGE = "https://www.afmontreal.ca/en/tcf-2/";
export const MONTREAL_SETTINGS = "https://afmontreal.extranet-aec.com/examinations/examination_type_detail?examinationTypeId=10";
export const MONTREAL_API = "https://afmontreal.aec.app";
const EXAM = /^(?:[ep]-)?tcf canada(?:\s*-\s*4 modules)?$/i;
const BLOCKED = /\b(sold\s*out|full(?:y booked)?|closed|cancelled|canceled|unavailable|not available|wait\s*list|on hold|not (?:yet )?open|opens? (?:in|on|soon))\b/i;
const MAX_PAGES = 10;
const MAX_COURSES = 120;

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: expected an object.`);
  return value;
}

function integer(value, label, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${label}: invalid integer.`);
  return value;
}

function responseDiagnostics(response) {
  // Record only bounded, recognized metadata; never log response bodies, cookies or tokens.
  const headers = response.headers || {};
  const header = name => String(headers[Object.keys(headers).find(key => key.toLowerCase() === name)] || "").trim();
  const mediaType = String(response.contentType || "").split(";", 1)[0].trim().toLowerCase();
  const type = ["application/json", "text/html", "text/plain", "application/problem+json"].includes(mediaType)
    ? mediaType : mediaType ? "other" : "missing";
  const body = typeof response.body === "string" ? response.body : "";
  const sample = body.slice(0, 65536);
  const signals = [];
  const waf = header("x-amzn-waf-action").toLowerCase();
  if (["challenge", "captcha"].includes(waf)) signals.push(`AWS WAF ${waf} header`);
  if (header("cf-mitigated").toLowerCase() === "challenge") signals.push("Cloudflare challenge header");
  if (/\b(?:awsWaf|gokuProps)\b|challenge-platform|\bverify (?:that )?you are (?:a )?human\b/i.test(sample)) signals.push("browser-challenge marker in body");
  if (/\b(?:scheduled|undergoing|under) maintenance\b|\bmaintenance (?:window|in progress)\b/i.test(sample)) signals.push("maintenance wording in body");
  const retry = header("retry-after");
  let retryDetail = "";
  if (retry) {
    const date = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry);
    retryDetail = `; retry-after=${/^\d{1,8}$/.test(retry) ? `${Number(retry)} seconds` : date ? retry : "present but unrecognized"}`;
  }
  return `Response diagnostics: content-type=${type}; body-characters=${body.length}; signals=${signals.join(", ") || "none recognized; cause unknown"}${retryDetail}.`;
}

function json(response, label) {
  if (response.status !== 200) throw new Error(`${label}: HTTP ${response.status}; availability unknown. ${responseDiagnostics(response)}`);
  if (response.body.length > 3000000) throw new Error(`${label}: response too large.`);
  try { return JSON.parse(response.body); } catch (_) { throw new Error(`${label}: invalid JSON response; availability unknown. ${responseDiagnostics(response)}`); }
}

function activeBody(data, label) {
  object(data, label);
  if (object(data.headers, label).response_code !== "0000") throw new Error(`${label}: provider did not report success.`);
  return object(data.body, label);
}

export function isoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function dayMonthYear(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(clean(value));
  return match ? isoDate(`${match[3]}-${match[2]}-${match[1]}`) : null;
}

export function northYorkLocation(value) {
  const text = clean(value);
  const northYork = /\bnorth[\s-]*york\b|\bjim doak\b|\b47\s+sheppard\s+(?:avenue|ave\.?)\s+(?:east|e\b)/i.test(text);
  const other = /\boakville\b|\bmississauga\b|\bspadina\b|\bmarkham\b/i.test(text);
  if (northYork && other) throw new Error("Conflicting North York campus identity.");
  if (northYork) return true;
  if (other) return false;
  return null;
}

export function parseActiveSearch(data, expectedPage) {
  const body = activeBody(data, "North York search");
  const info = object(data.headers.page_info, "North York pagination");
  const page = integer(info.page_number, "page number", 1);
  const pages = integer(info.total_page, "page count", 1);
  const total = integer(info.total_records, "record count");
  const size = integer(info.total_records_per_page, "page size", 1);
  if (page !== expectedPage || pages > MAX_PAGES || page > pages || pages !== Math.max(1, Math.ceil(total / size))) {
    throw new Error("North York returned inconsistent pagination.");
  }
  if (!Array.isArray(body.activity_items) || body.activity_items.length !== Math.min(size, Math.max(0, total - (page - 1) * size))) {
    throw new Error("North York returned an incomplete search page.");
  }
  const ids = new Set();
  const candidates = [];
  for (const item of body.activity_items) {
    object(item, "North York activity");
    integer(item.id, "activity id", 1);
    if (ids.has(item.id)) throw new Error("North York search repeated an activity.");
    ids.add(item.id);
    if (!EXAM.test(clean(item.name))) continue;
    integer(item.num_of_sub_activities, "sub-activity count");
    candidates.push(item);
  }
  return { candidates, pages, total, size, ids: [...ids] };
}

export function parseActiveChildren(data, parent) {
  const body = activeBody(data, "North York sub-courses");
  if (!Array.isArray(body.sub_activities) || body.sub_activities.length !== parent.num_of_sub_activities) {
    throw new Error(`North York parent ${parent.id} returned incomplete sub-courses.`);
  }
  const ids = new Set();
  return body.sub_activities.map(item => {
    object(item, "North York sub-course");
    integer(item.id, "sub-course id", 1);
    if (ids.has(item.id) || !EXAM.test(clean(item.name)) || item.num_of_sub_activities !== 0 || item.parent_activity === true) {
      throw new Error("Unsupported or conflicting North York sub-course.");
    }
    ids.add(item.id);
    return item;
  });
}

function enrollmentUrl(href, id) {
  const url = new URLParse(clean(href), ACTIVE_BASE + "/", true);
  if (url.protocol !== "https:" || url.host !== "anc.ca.apm.activecommunities.com" || url.auth || url.hash ||
      !new RegExp(`^/aftoronto/activity/(?:search/)?enroll/${id}/?$`).test(url.pathname)) return null;
  return url.toString();
}

export function parseNorthYorkCourse(candidate, detailData, statusData, today) {
  const detail = object(activeBody(detailData, "North York course detail").detail, "North York course detail");
  const status = object(activeBody(statusData, "North York final enrollment status").button_status, "North York final enrollment status");
  if (detail.activity_id !== candidate.id || !EXAM.test(clean(detail.activity_name)) || detail.is_parent_activity !== false) {
    throw new Error("North York course detail has a conflicting identity or is not a leaf course.");
  }
  const location = clean(detail.location_description);
  const campus = northYorkLocation(location);
  if (campus === false) return null;
  if (campus === null) throw new Error(`Cannot identify the campus of TCF course ${candidate.id}.`);
  if (northYorkLocation(candidate.location?.label) === false) throw new Error("North York campus changed between search and detail.");
  const date = isoDate(detail.first_date);
  if (!date || (detail.last_date && detail.last_date !== date)) throw new Error("North York TCF exam date is missing or ambiguous.");
  const action = object(status.action_link || {}, "North York enrollment action");
  const href = enrollmentUrl(action.href, candidate.id);
  const bookings = clean(status.notification || action.label || "No enrollment action");
  const spots = clean(detail.space_status || candidate.urgent_message?.status_description || "Not published");
  const closed = BLOCKED.test([bookings, spots, detail.space_message, candidate.urgent_message?.status_description].join(" ")) || /^0\b/.test(spots);
  let available = false, reason = "no_final_enrollment_action";
  if (closed) reason = "closed_or_full";
  else if (date < today) reason = "past_exam";
  else if (href && /^enroll now$/i.test(clean(action.label)) && action.disabled !== true && action.enabled !== false && status.time_remaining === 0) {
    available = true; reason = "verified_enrollment_action";
  } else if (action.href && /enroll/i.test(`${action.label} ${action.href}`) && !href) {
    throw new Error("North York exposed an unrecognized or mismatched enrollment URL.");
  }
  return { city: "North York", priority: 1, sourceId: candidate.id, key: `north-york:course:${candidate.id}`,
    exam: clean(detail.activity_name), examDate: date, schedule: date, location,
    registrationDates: "Final registration status checked live", spotsLeft: spots,
    price: clean(candidate.fee?.label), bookings, links: available ? [href] : [],
    pageUrl: NORTH_YORK_PAGE, available, reason };
}

function client(request, batch, now) {
  const started = now();
  let count = 0;
  const guard = amount => {
    count += amount;
    if (count > 300 || now() - started > 45000) throw new Error("Provider request/time budget exceeded; result is incomplete.");
  };
  return {
    get count() { return count; },
    one(url, options = {}) { guard(1); return request(url, options); },
    many(specs) {
      const responses = [];
      for (let i = 0; i < specs.length; i += 8) {
        const group = specs.slice(i, i + 8);
        guard(group.length);
        const result = batch ? batch(group) : group.map(s => request(s.url, s.options));
        if (!Array.isArray(result) || result.length !== group.length) throw new Error("Provider batch returned incomplete responses.");
        responses.push(...result);
      }
      return responses;
    },
  };
}

export function fetchNorthYork(request, { seen = {}, today, now = Date.now } = {}, batch) {
  if (!isoDate(today)) throw new Error("North York requires a valid local date.");
  const http = client(request, batch, now);
  const referer = `${ACTIVE_BASE}/activity/search?onlineSiteId=0&activity_select_param=2&activity_keyword=TCF&viewMode=list`;
  const headers = { Referer: referer, Origin: "https://anc.ca.apm.activecommunities.com" };
  const parents = [], searchIds = new Set();
  let catalog;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const data = json(http.one(`${ACTIVE_BASE}/rest/activities/list`, { method: "post", contentType: "application/json",
      headers: { ...headers, page_info: JSON.stringify({ page_number: page, total_records_per_page: 20, order_by: "Name" }) },
      payload: JSON.stringify({ activity_search_pattern: { activity_keyword: "TCF", activity_select_param: "2" }, activity_transfer_pattern: {} }) }), "North York search");
    const parsed = parseActiveSearch(data, page);
    if (catalog && (parsed.pages !== catalog.pages || parsed.total !== catalog.total || parsed.size !== catalog.size)) throw new Error("North York catalog changed during pagination.");
    catalog = parsed;
    for (const id of parsed.ids) {
      if (searchIds.has(id)) throw new Error("North York returned the same activity on multiple pages.");
      searchIds.add(id);
    }
    parents.push(...parsed.candidates);
    if (page === parsed.pages) break;
  }
  // Parent location alone is not authoritative; children may use another campus.
  const expandable = parents.filter(p => p.num_of_sub_activities > 0);
  const children = http.many(expandable.map(p => ({ url: `${ACTIVE_BASE}/rest/activities/subs/${p.id}`,
    options: { method: "post", contentType: "application/json", payload: "{}", headers } })));
  const leaves = parents.filter(p => !p.num_of_sub_activities);
  children.forEach((response, i) => leaves.push(...parseActiveChildren(json(response, "North York sub-courses"), expandable[i])));
  const byId = new Map();
  for (const candidate of leaves) {
    const old = byId.get(candidate.id);
    if (old && (old.name !== candidate.name || old.number !== candidate.number || old.location?.label !== candidate.location?.label)) {
      throw new Error("Conflicting duplicate North York course.");
    }
    byId.set(candidate.id, candidate);
  }
  // Recheck previously open courses even when the search hides them after selling out.
  for (const old of Object.values(seen)) {
    const row = old.row;
    if (old.available && row?.city === "North York" && isoDate(row.examDate) >= today && !byId.has(row.sourceId)) {
      byId.set(row.sourceId, { id: row.sourceId, name: row.exam, location: { label: row.location }, fee: { label: row.price } });
    }
  }
  const candidates = [...byId.values()].filter(c => northYorkLocation(c.location?.label) !== false);
  if (candidates.length > MAX_COURSES) throw new Error("North York catalog exceeds the verified-course budget.");
  const specs = candidates.flatMap(c => ["detail", "detail/buttonstatus"].map(path => ({
    url: `${ACTIVE_BASE}/rest/activity/${path}/${c.id}?`, options: { headers: { Referer: `${ACTIVE_BASE}/activity/search/detail/${c.id}?onlineSiteId=0&from_original_cui=true` } },
  })));
  const verified = http.many(specs);
  const rows = candidates.map((c, i) => parseNorthYorkCourse(c, json(verified[2 * i], "North York detail"),
    json(verified[2 * i + 1], "North York enrollment status"), today)).filter(Boolean);
  return { rows, pages: http.count, detail: `Complete Toronto catalog: ${catalog.total} activities; ${rows.length} North York exams verified.` };
}

export function extractMontrealSettings(html) {
  const base = /aec_app_url\s*=\s*["']([^"']+)/.exec(html)?.[1];
  const key = /aecExtranetWebAppsAPIKey\s*=\s*["']([^"']+)/.exec(html)?.[1];
  if ((base && base.replace(/\/$/, "") !== MONTREAL_API) || !key || key.length > 300) {
    throw new Error("Montreal public registration settings changed.");
  }
  return key;
}

function montrealBooking(href, id) {
  const url = new URLParse(clean(href), MONTREAL_PAGE, true);
  return url.protocol === "https:" && url.host === "www.afmontreal.ca" && !url.auth &&
    url.pathname === "/panier/" && url.hash === `#/addExamination/${id}` && !Object.keys(url.query).length ? url.toString() : null;
}

export function parseMontreal(data, today) {
  if (!isoDate(today) || !Array.isArray(data) || data.length !== 1) throw new Error("Montreal returned an unexpected examination-type catalog.");
  const type = object(data[0], "Montreal examination type");
  if (type.IDEXAMINATION_TYPE !== 10 || clean(type.name).toLowerCase() !== "tcf canada" || !Array.isArray(type.examinations)) {
    throw new Error("Montreal returned a different exam product or malformed catalog.");
  }
  if (type.examinations.length > 120) throw new Error("Montreal catalog exceeds the snapshot budget.");
  const ids = new Set();
  return type.examinations.map(exam => {
    object(exam, "Montreal examination");
    const id = integer(exam.IDEXAMINATION, "Montreal examination id", 1);
    if (ids.has(id) || exam.IDEXAMINATION_TYPE !== 10 || clean(exam.product_name).toLowerCase() !== "tcf canada") {
      throw new Error("Duplicate or mismatched Montreal examination identity.");
    }
    ids.add(id);
    const date = isoDate(exam.examination_date);
    const start = dayMonthYear(exam.formattedEnrollmentDate);
    const end = dayMonthYear(exam.examination_enroll_end_date_formatted);
    if (!date || !start || !end || start > end) throw new Error("Montreal examination or registration dates could not be validated.");
    if (typeof exam.isFull !== "boolean" || typeof exam.inscriptionIsInFuture !== "boolean") throw new Error("Montreal registration flags changed.");
    const qty = integer(exam.qty_student, "Montreal enrolled count");
    const maximum = integer(exam.max_student, "Montreal capacity");
    const register = object(exam.mainRegisterLink, "Montreal registration action");
    const href = register.link ? montrealBooking(register.link, id) : null;
    const blocked = clean(register.cantRegisterReason);
    let available = false, reason = "no_active_booking_link";
    if (exam.isFull || qty >= maximum) reason = "sold_out";
    else if (blocked || exam.inscriptions_are_over === true || exam.inscriptions_started === false) reason = "registration_blocked";
    else if (exam.inscriptionIsInFuture || today < start || today > end) reason = "outside_registration_window";
    else if (date < today) reason = "past_exam";
    else if (href && register.label === "add_to_cart") { available = true; reason = "verified_registration_action"; }
    else if (register.link) throw new Error("Montreal exposed an unrecognized or mismatched booking action.");
    const time = clean(exam.examination_start_time_formatted);
    return { city: "Montreal", priority: 3, sourceId: id, key: `montreal:examination:${id}`,
      exam: "TCF Canada", examDate: date, schedule: `${date}${time && time !== "00:00" ? ` ${time}` : " (time to be confirmed)"}`,
      registrationDates: `${start} to ${end} (Montreal local dates)`, location: clean(exam.examination_location) || "Alliance Francaise Montreal",
      spotsLeft: String(Math.max(0, maximum - qty)), price: clean(exam.price_formatted || exam.price),
      bookings: available ? "Active registration action" : blocked || reason, links: available ? [href] : [],
      pageUrl: MONTREAL_PAGE, available, reason };
  });
}

export function fetchMontreal(request, { today, now = Date.now } = {}) {
  const http = client(request, null, now);
  const settings = http.one(MONTREAL_SETTINGS);
  if (settings.status !== 200 || settings.body.length > 2000000) throw new Error(`Montreal settings: HTTP ${settings.status} or oversized response.`);
  const key = extractMontrealSettings(settings.body);
  const data = json(http.one(`${MONTREAL_API}/api/v1/public/examinations/list/0/10?API_KEY=${encodeURIComponent(key)}`), "Montreal examinations");
  return { rows: parseMontreal(data, today), pages: http.count };
}

export function preferredAlertBody(events, checkedAt) {
  const ordered = [...events].sort((a, b) => a.priority - b.priority || a.examDate.localeCompare(b.examDate));
  return ["TCF Canada availability alert (Google-hosted monitor)", "",
    "Your centre preference: North York > Edmonton > Montreal", `Checked at: ${checkedAt} (UTC)`, "",
    ...ordered.flatMap((row, index) => [`${index + 1}. ${row.city}: ${row.exam}`, `Exam date: ${row.schedule}`,
      `Location: ${row.location}`, `Registration: ${row.registrationDates}`, `Spots: ${row.spotsLeft}`, `Price: ${row.price}`,
      `Official page: ${row.pageUrl}`, `Booking link: ${row.links[0]}`, ""]),
    "The official registration system exposed an active booking action at check time. Seats may disappear before you click.",
    "Check repeat-test eligibility and confirm the date and venue yourself. No seat has been reserved or paid for."
  ].join("\n");
}
