import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fetchComplete, evaluate } from "./src/core.js";

const started = performance.now();
const fixture = process.argv[2];
const html = fixture ? await readFile(fixture, "utf8") : null;
const request = url => ({ status: 200, contentType: "text/html", body: html ?? execFileSync("curl",
  ["--fail", "--silent", "--show-error", "--max-time", "35", url], { encoding: "utf8", maxBuffer: 2000000 }) });
const fetched = fetchComplete(request);
const now = new Date();
const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Edmonton", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(now).map(p => [p.type, p.value]));
const wallTime = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
const assessment = evaluate(fetched.rows, {}, now.toISOString(), wallTime);
console.log(JSON.stringify({ checkedAt: now.toISOString(), source: fixture || "live website", pages: fetched.pages,
  rows: fetched.rows.length, available: assessment.events.length, localRuntimeSeconds: (performance.now() - started) / 1000,
  note: "Read-only local verification. No email, no state writes. This is not a Google-hosted cadence test.",
  sessions: assessment.snapshot.map(({ exam, schedule, spotsLeft, bookings, available, reason }) => ({ exam, schedule, spotsLeft, bookings, available, reason }))
}, null, 2));
