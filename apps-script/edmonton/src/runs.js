// Apps Script executions are limited to six minutes. Never reclaim a live owner.
export const RUN_STALE_MS = 7 * 60000;
const RETAIN_INTERRUPTION_MS = 7 * 86400000;
const MAX_INTERRUPTION_RECORDS = 20;

export function createRunJournal({ properties, key, lock, now = Date.now, uuid }) {
  function read() {
    const value = properties().getProperty(key);
    if (!value) return { version: 1, current: null, interruptions: [] };
    const journal = JSON.parse(value);
    if (!journal || journal.version !== 1 || !Array.isArray(journal.interruptions) ||
        journal.interruptions.some(item => !item || !item.id || !Number.isFinite(item.started) || !Number.isFinite(item.detected)) ||
        (journal.current && (!journal.current.id || !Number.isFinite(journal.current.started)))) {
      throw new Error("Invalid run journal; refusing concurrent checks.");
    }
    return journal;
  }
  function change(fn, waitMs = 1000) {
    const guard = lock();
    if (!guard.tryLock(waitMs)) return { busy: true };
    try {
      const journal = read();
      const result = fn(journal);
      if (result?.write !== false) properties().setProperty(key, JSON.stringify(journal));
      return result;
    } finally { guard.releaseLock(); }
  }
  function interrupt(journal, run) {
    if (!journal.interruptions.some(item => item.id === run.id || (run.observedAt && item.observedAt === run.observedAt))) {
      journal.interruptions.push({ id: run.id, started: run.started, observedAt: run.observedAt,
        row: run.row, phase: run.phase, detected: now() });
      journal.interruptions = journal.interruptions.filter(item => item.detected >= now() - RETAIN_INTERRUPTION_MS);
      if (journal.interruptions.length > MAX_INTERRUPTION_RECORDS) {
        journal.truncatedAt = now();
        journal.interruptions = journal.interruptions.slice(-MAX_INTERRUPTION_RECORDS);
      }
    }
  }
  function expire(journal) {
    if (journal.current && now() - journal.current.started > RUN_STALE_MS) {
      interrupt(journal, journal.current);
      journal.current = null;
    }
  }
  return {
    read,
    begin(kind = "CHECK") {
      return change(journal => {
        expire(journal);
        if (journal.current) return { busy: true, write: false };
        const run = { id: uuid(), started: now(), phase: kind === "CHECK" ? "fetching" : kind.toLowerCase(), kind };
        journal.current = run;
        return { run };
      });
    },
    observed(run, row, observedAt) {
      const result = change(journal => {
        if (journal.current?.id !== run.id) throw new Error("Check no longer owns its run lease.");
        Object.assign(journal.current, { row, observedAt, phase: "observation_saved" });
        return { updated: true };
      });
      if (result.busy) throw new Error("Could not save the run observation checkpoint.");
    },
    finish(run, outcome) {
      // A short collision must not leave a finished run blocking the next timer.
      // Retry acquisition only; storage failures stay explicit, and ownership is rechecked.
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = change(journal => {
          if (journal.current?.id !== run.id) return { write: false };
          if (outcome === "INCOMPLETE") interrupt(journal, journal.current);
          journal.lastFinished = { at: now(), outcome, started: run.started, kind: run.kind };
          journal.current = null;
          return { finished: true };
        }, 5000);
        if (!result.busy) return result;
      }
      return { busy: true };
    },
    importLegacy(runs, complete = true) {
      return change(journal => {
        for (const run of runs) interrupt(journal, run);
        journal.legacyInspected = complete;
        return { imported: true };
      });
    },
    acknowledge(id) {
      return change(journal => {
        const item = journal.interruptions.find(item => item.id === id);
        if (item) item.reconciled = true;
        return { acknowledged: true };
      });
    },
  };
}
