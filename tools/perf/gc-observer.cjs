// gc-observer.cjs: a preload that measures how much of a Node process's time goes into garbage collection (PBE-076,
// ADR-0029 item 5). platform/docs/performance.md §6 records what it measured; tools/perf/README.md "Run it" starts the
// platform API and its worker with it:
//
//   node --require ./tools/perf/gc-observer.cjs --enable-source-maps dist/main.js
//
// It sums the `gc` entries of a PerformanceObserver (each one a pause of the process's main thread for a scavenge, a
// mark-sweep or another collection) and writes one JSON line to stderr per minute and one at exit, for example:
//
//   {"gcObserver":1,"at":"minute","pid":4242,"node":"v24.22.3","heapLimitMiB":688,"time":"2026-11-18T10:00:00.000Z",
//    "uptimeMs":60001.2,"gcMs":412.7,"gcCount":388,"intervalMs":60000.4,"intervalGcMs":401.3,"intervalCount":377,
//    "intervalMaxMs":6.1,"kinds":{"minor":{"count":380,"ms":350.2},"major":{"count":4,"ms":58.9},...}}
//
// - `uptimeMs` is the time since the process started (performance.now()); `gcMs`, `gcCount` and `kinds` are the sums
//   since then, so gcMs / uptimeMs is the process's share of time in garbage collection, and the difference of two
//   lines is the share between them. The `interval*` fields are the figures since the line before: its length, the
//   milliseconds and pauses in it, and its longest pause.
// - `at` is "minute" for the lines of the timer and "exit" for the last one. The exit line is written once: at the
//   process's `exit` event, or at the first SIGTERM or SIGINT, whichever comes first, because a NestJS application
//   ends on SIGTERM by sending the signal to itself again after its shutdown hooks, and then no `exit` event comes. The
//   signal's name is in `signal`. The signal itself is left alone: when no other listener of it is left, the observer
//   sends it to the process again, so the process ends as it would have without the observer; a process with its own
//   listener (NestJS's shutdown hooks) handles it as it always does.
// - `node` and `heapLimitMiB` (V8's heap limit, old + 3 × semi-space MiB with the units' two flags) show which runtime
//   and which flags the process ran with.
// - Only the main thread is measured: in a worker thread, which gets the same preload, the observer does nothing.
// - GC_OBSERVER_INTERVAL_MS sets another interval than 60 000 ms (at least 50), for the unit tests.
//
// It writes with fs.writeSync, so a line is never lost at exit, and its timer is unref'd, so it never keeps a process
// alive. Plain Node (the `.nvmrc` major), CommonJS for --require, no dependency. platform-smoke.mjs reads these lines
// from the processes' log files (--api-gc-log, --worker-gc-log); platform-smoke.test.mjs runs it in child processes.
"use strict";

const { writeSync } = require("node:fs");
const process = require("node:process");
const { PerformanceObserver, constants, performance } = require("node:perf_hooks");
const { clearInterval, setInterval } = require("node:timers");
const { getHeapStatistics } = require("node:v8");
const { isMainThread } = require("node:worker_threads");

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 50;
/** The `detail.kind` of a gc entry, by name (perf_hooks.constants). */
const KINDS = Object.freeze({
  [constants.NODE_PERFORMANCE_GC_MINOR]: "minor",
  [constants.NODE_PERFORMANCE_GC_MINOR_MARK_SWEEP ?? 2]: "minorMarkSweep",
  [constants.NODE_PERFORMANCE_GC_MAJOR]: "major",
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental",
  [constants.NODE_PERFORMANCE_GC_WEAKCB]: "weakcb",
});
const TERMINATING_SIGNALS = ["SIGTERM", "SIGINT"];

/** The interval of the lines: GC_OBSERVER_INTERVAL_MS when it is a whole number of at least 50, else a minute. */
function intervalMs(value) {
  return value !== undefined && /^\d+$/.test(value) && Number(value) >= MIN_INTERVAL_MS
    ? Number(value)
    : DEFAULT_INTERVAL_MS;
}

function round(value) {
  return Number(value.toFixed(1));
}

function start() {
  const totals = { ms: 0, count: 0, kinds: {} };
  const interval = { startedMs: performance.now(), ms: 0, count: 0, maxMs: 0 };
  const heapLimitMiB = Math.round(getHeapStatistics().heap_size_limit / 1024 / 1024);
  let ended = false;

  const add = (entries) => {
    for (const entry of entries) {
      const name = KINDS[entry.detail?.kind] ?? "other";
      const kind = (totals.kinds[name] ??= { count: 0, ms: 0 });
      kind.count++;
      kind.ms += entry.duration;
      totals.count++;
      totals.ms += entry.duration;
      interval.count++;
      interval.ms += entry.duration;
      interval.maxMs = Math.max(interval.maxMs, entry.duration);
    }
  };
  const observer = new PerformanceObserver((list) => add(list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });

  /** Writes one line with the figures up to now (entries not yet handed to the callback included). */
  const write = (at, signal) => {
    add(observer.takeRecords());
    const now = performance.now();
    const kinds = {};
    for (const [name, kind] of Object.entries(totals.kinds)) {
      kinds[name] = { count: kind.count, ms: round(kind.ms) };
    }
    const line = {
      gcObserver: 1,
      at,
      ...(signal === undefined ? {} : { signal }),
      pid: process.pid,
      node: process.version,
      heapLimitMiB,
      time: new Date().toISOString(),
      uptimeMs: round(now),
      gcMs: round(totals.ms),
      gcCount: totals.count,
      intervalMs: round(now - interval.startedMs),
      intervalGcMs: round(interval.ms),
      intervalCount: interval.count,
      intervalMaxMs: round(interval.maxMs),
      kinds,
    };
    interval.startedMs = now;
    interval.ms = 0;
    interval.count = 0;
    interval.maxMs = 0;
    try {
      writeSync(2, `${JSON.stringify(line)}\n`);
    } catch {
      // stderr is closed: nothing to report to.
    }
  };

  const timer = setInterval(() => write("minute"), intervalMs(process.env.GC_OBSERVER_INTERVAL_MS));
  timer.unref();

  const end = (signal) => {
    if (ended) {
      return;
    }
    ended = true;
    clearInterval(timer);
    write("exit", signal);
    observer.disconnect();
  };
  process.on("exit", () => end(undefined));
  for (const signal of TERMINATING_SIGNALS) {
    const onSignal = () => {
      process.removeListener(signal, onSignal);
      end(signal);
      if (process.listenerCount(signal) === 0) {
        // No one else handles it: end the process as the signal would have without this listener.
        process.kill(process.pid, signal);
      }
    };
    process.on(signal, onSignal);
  }
}

if (isMainThread) {
  start();
}
