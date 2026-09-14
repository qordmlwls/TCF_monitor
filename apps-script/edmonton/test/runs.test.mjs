import test from "node:test";
import assert from "node:assert/strict";
import { createRunJournal, RUN_STALE_MS } from "../src/runs.js";
import { Properties } from "./fixtures.mjs";

function fixture() {
  const p = new Properties();
  const env = { now: Date.parse("2026-09-14T00:00:00Z"), held: false, count: 0 };
  const options = { properties: () => p, now: () => env.now, uuid: () => `run-${++env.count}`,
    lock: () => ({ tryLock() { if (env.held) return false; env.held = true; return true; }, releaseLock() { env.held = false; } }) };
  return { p, env, journal: createRunJournal({ ...options, key: "city1" }), other: createRunJournal({ ...options, key: "city2" }) };
}

test("city leases exclude same-city overlap while releasing the shared lock immediately", () => {
  const { journal, other, env } = fixture();
  const first = journal.begin().run;
  assert.equal(env.held, false);
  assert.equal(journal.begin().busy, true);
  assert.ok(other.begin().run);
  journal.finish(first, "SUCCESS");
  assert.ok(journal.begin().run);
});

test("a lease is reclaimed only after seven minutes and the old owner cannot clear its replacement", () => {
  const { journal, env } = fixture();
  const old = journal.begin().run;
  journal.observed(old, 8, new Date(env.now).toISOString());
  env.now += RUN_STALE_MS;
  assert.equal(journal.begin().busy, true);
  env.now++;
  const replacement = journal.begin().run;
  assert.equal(journal.read().interruptions.length, 1);
  assert.equal(journal.read().interruptions[0].row, 8);
  assert.throws(() => journal.observed(old, 9, "later"), /owns/);
  journal.finish(old, "SUCCESS");
  assert.equal(journal.read().current.id, replacement.id);
  journal.finish(replacement, "SUCCESS");
  assert.equal(journal.read().current, null);
});

test("abandonment before any spreadsheet write remains visible", () => {
  const { journal, env } = fixture();
  journal.begin(); env.now += RUN_STALE_MS + 1;
  journal.begin("AUDIT");
  const item = journal.read().interruptions[0];
  assert.equal(item.phase, "fetching");
  assert.equal(item.row, undefined);
});

test("journal and legacy observations are deduplicated and reconciliation does not erase evidence", () => {
  const { journal, env } = fixture();
  const run = journal.begin().run;
  const observedAt = new Date(env.now).toISOString();
  journal.observed(run, 3, observedAt); journal.finish(run, "INCOMPLETE");
  journal.importLegacy([{ id: "legacy", started: env.now, observedAt, row: 3, phase: "legacy_observation" }]);
  assert.equal(journal.read().interruptions.length, 1);
  journal.acknowledge(run.id);
  assert.equal(journal.read().interruptions[0].reconciled, true);
  assert.equal(journal.read().legacyInspected, true);
});

test("interruption history is bounded well below the property size limit", () => {
  const { journal, p, env } = fixture();
  for (let i = 0; i < 50; i++) {
    const run = journal.begin().run;
    journal.observed(run, i + 2, new Date(env.now).toISOString());
    journal.finish(run, "INCOMPLETE"); env.now++;
  }
  assert.equal(journal.read().interruptions.length, 20);
  assert.ok(journal.read().truncatedAt);
  assert.ok(Buffer.byteLength(p.getProperty("city1")) < 9000);
  env.now += 8 * 86400000;
  journal.finish(journal.begin().run, "INCOMPLETE");
  assert.equal(journal.read().interruptions.length, 1);
});

test("corrupt journals and failed writes fail closed and always release the lock", () => {
  const { journal, p, env } = fixture();
  for (const value of ["null", "invalid", '{"version":2}', '{"version":1,"interruptions":[null]}']) {
    p.setProperty("city1", value);
    assert.throws(() => journal.begin());
    assert.equal(env.held, false);
    assert.equal(p.getProperty("city1"), value);
  }
  p.data.delete("city1"); p.failWrite = true;
  assert.throws(() => journal.begin(), /Storage unavailable/);
  assert.equal(env.held, false);
});

test("lock contention does not mutate a journal and a checkpoint failure is explicit", () => {
  const { journal, p, env } = fixture();
  const run = journal.begin().run, before = p.getProperty("city1");
  env.held = true;
  assert.equal(journal.begin().busy, true);
  assert.throws(() => journal.observed(run, 3, "now"), /checkpoint/);
  assert.equal(journal.finish(run, "SUCCESS").busy, true);
  assert.equal(p.getProperty("city1"), before);
});
