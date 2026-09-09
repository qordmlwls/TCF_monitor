import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fetchNorthYork, fetchMontreal } from "./src/providers.js";

// Public read-only endpoints only; do not follow returned cart/enrollment URLs.
const request = (url, options = {}) => {
  const args = ["--silent", "--show-error", "--max-time", "35", "--write-out", "\n%{http_code}",
    "--request", (options.method || "get").toUpperCase()];
  for (const [name, value] of Object.entries(options.headers || {})) args.push("--header", `${name}: ${value}`);
  if (options.contentType) args.push("--header", `Content-Type: ${options.contentType}`);
  if (options.payload) args.push("--data-raw", options.payload);
  const output = execFileSync("curl", [...args, url], { encoding: "utf8", maxBuffer: 3000000 });
  const split = output.lastIndexOf("\n");
  return { status: Number(output.slice(split + 1)), body: output.slice(0, split) };
};
const now = new Date();
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
for (const [city, provider] of [["North York", fetchNorthYork], ["Montreal", fetchMontreal]]) {
  const start = performance.now();
  const result = provider(request, { today });
  console.log(JSON.stringify({ city, checkedAt: now.toISOString(), rows: result.rows.length,
    available: result.rows.filter(row => row.available).length, requests: result.pages,
    localRuntimeSeconds: (performance.now() - start) / 1000,
    note: "Read-only local verification, not a Google-hosted timing test. No email or state changes.",
    sessions: result.rows.map(({ examDate, location, spotsLeft, available, reason }) => ({ examDate, location, spotsLeft, available, reason })),
  }, null, 2));
}
