// Unit tests of booking-load.mjs's memory report (ota/backend/test/load/booking-load.mjs; OBE-104 and lead decision
// (30b) of 2026-11-19): the JS heap's floor after collections, the least heap used of each --floor-minutes, its
// least-squares slope over the windows of the RSS slopes, and the verdict that a process's memory settles when its RSS
// slope over minutes 90-180 is below 0.02 MiB a minute and its heap floor's slope is not above it. They live here, next
// to the other tested tools of tools/perf, because booking-load.mjs is plain Node like them and has no test of its own;
// CI's build-test job runs them with `node --test tools/perf/*.test.mjs` (plain Node, no install, no service). Importing
// the script starts nothing: it runs only when Node runs the file itself.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  FLOOR_WINDOW_MINUTES,
  SETTLE_SLOPE_MIB_PER_MINUTE,
  floorsOf,
  leastSquares,
  memoryOverTime,
  memorySettles,
  memoryText,
} from "../../ota/backend/test/load/booking-load.mjs";

const SCRIPT = fileURLToPath(new URL("../../ota/backend/test/load/booking-load.mjs", import.meta.url));
const MIB = 1_048_576;
const SAMPLE_MS = 5_000;
/** The saw-tooth of the synthetic heap: a collection every 20 s, so every fourth 5-second sample is a floor. */
const CYCLE_MS = 20_000;

/**
 * Samples as booking-load.mjs takes them, every 5 s from the phase's start to `minutes` and one more 3 s later (the
 * run's last sample, after the phase), for both processes: an RSS of 300 MiB rising `rssSlope` MiB a minute, and a
 * heap used that climbs from its floor (80 MiB rising `floorSlope` a minute) by an amplitude of 20 MiB rising
 * `amplitudeSlope` a minute over each 20-second cycle, so that its own slope is about `floorSlope + 0.375 x
 * amplitudeSlope` while its floor's is `floorSlope`. `lastHeapMiB` is the heap of that last sample.
 */
function syntheticSamples({ minutes, rssSlope, floorSlope, amplitudeSlope, lastHeapMiB = 70 }) {
  const samples = [];
  const sample = (at, heapMiB) => {
    const minute = at / 60_000;
    const rss = (300 + rssSlope * minute) * MIB;
    const heap = heapMiB * MIB;
    return {
      at,
      apiRssBytes: rss,
      workerRssBytes: rss,
      apiHeapBytes: heap,
      workerHeapBytes: heap,
      apiHeapTotalBytes: 200 * MIB,
      workerHeapTotalBytes: 200 * MIB,
      apiExternalBytes: 7 * MIB,
      workerExternalBytes: 7 * MIB,
      apiArrayBuffersBytes: 3 * MIB,
      workerArrayBuffersBytes: 3 * MIB,
    };
  };
  for (let at = 0; at <= minutes * 60_000; at += SAMPLE_MS) {
    const minute = at / 60_000;
    const phase = (at % CYCLE_MS) / CYCLE_MS;
    samples.push(sample(at, 80 + floorSlope * minute + (20 + amplitudeSlope * minute) * phase));
  }
  samples.push(sample(minutes * 60_000 + 3_000, lastHeapMiB));
  return samples;
}

const options = (minutes, floorMinutes) => ({ minutes, tableMinutes: 30, floorMinutes });
const NO_GC = { api: undefined, worker: undefined };

describe("floorsOf: the least point of each window", () => {
  // Minutes 0 to 15 in windows of 5: the least point of each, at its own minute.
  const points = [
    [0, 50],
    [1, 40],
    [2, 45],
    [4.9, 60],
    [5, 41],
    [6, 30],
    [9.99, 55],
    [10, 70],
    [12, 35],
    [14.5, 36],
  ];

  it("[FIX-W61-MEMORY AC1] takes each window's least point, not its mean or its most", () => {
    assert.deepEqual(floorsOf(points, 0, 15, 5), [
      [1, 40],
      [6, 30],
      [12, 35],
    ]);
  });

  it("[FIX-W61-MEMORY AC1] puts a point on the edge of two windows in the later one", () => {
    // 20 at minute 5 is the floor of 5-10, never of 0-5; a point at minute 10, the end of 5-10, is in 10-15 only.
    const edge = [
      [1, 40],
      [5, 20],
      [6, 30],
      [10, 10],
      [12, 35],
    ];
    assert.deepEqual(floorsOf(edge, 0, 15, 5), [
      [1, 40],
      [5, 20],
      [10, 10],
    ]);
  });

  it("[FIX-W61-MEMORY AC1] keeps every whole window up to `to`, the last one included, and leaves out a remainder", () => {
    assert.equal(floorsOf(points, 0, 15, 5).length, 3);
    // 0-12: the windows 0-5 and 5-10; 10-12 is shorter than a window, so 35 at minute 12 is no floor.
    assert.deepEqual(floorsOf(points, 0, 12, 5), [
      [1, 40],
      [6, 30],
    ]);
  });

  it("[FIX-W61-MEMORY AC1] starts the windows at `from` and skips a window without points", () => {
    assert.deepEqual(floorsOf(points, 5, 15, 5), [
      [6, 30],
      [12, 35],
    ]);
    assert.deepEqual(
      floorsOf(
        [
          [1, 40],
          [12, 35],
        ],
        0,
        15,
        5,
      ),
      [
        [1, 40],
        [12, 35],
      ],
    );
    assert.deepEqual(floorsOf(points, 20, 30, 5), []);
  });
});

describe("memorySettles: the rule of lead decision (30b)", () => {
  it("[FIX-W61-MEMORY AC1] settles with a heap floor slope at the bound, which is not above it", () => {
    assert.deepEqual(memorySettles(0.01, SETTLE_SLOPE_MIB_PER_MINUTE), {
      rssBelow: true,
      floorNotAbove: true,
      settles: true,
    });
  });

  it("[FIX-W61-MEMORY AC1] does not settle with an RSS slope at the bound, which is not below it", () => {
    assert.deepEqual(memorySettles(SETTLE_SLOPE_MIB_PER_MINUTE, 0), {
      rssBelow: false,
      floorNotAbove: true,
      settles: false,
    });
  });

  it("[FIX-W61-MEMORY AC1] does not settle with a heap floor slope above the bound, and judges nothing without a slope", () => {
    assert.equal(memorySettles(0.0166, 0.0351).settles, false);
    assert.equal(memorySettles(0.0166, 0.0351).floorNotAbove, false);
    assert.equal(memorySettles(undefined, 0).settles, undefined);
    assert.equal(memorySettles(0, undefined).settles, undefined);
  });

  it("[FIX-W61-MEMORY AC1] bounds at 0.02 MiB a minute with floors of 5 minutes by default", () => {
    assert.equal(SETTLE_SLOPE_MIB_PER_MINUTE, 0.02);
    assert.equal(FLOOR_WINDOW_MINUTES, 5);
  });
});

describe("memoryOverTime: the heap floor in a three-hour run", () => {
  // A saw-tooth whose peaks rise while its floor stays: the heap used's own slope is above the bound, its floor's is 0.
  const flatFloor = memoryOverTime(
    options(180, 5),
    syntheticSamples({ minutes: 180, rssSlope: 0.01, floorSlope: 0, amplitudeSlope: 0.2 }),
    180 * 60_000 + 3_000,
    NO_GC,
  );
  // The same with a floor rising 0.03 MiB a minute.
  const risingFloor = memoryOverTime(
    options(180, 5),
    syntheticSamples({ minutes: 180, rssSlope: 0.01, floorSlope: 0.03, amplitudeSlope: 0 }),
    180 * 60_000 + 3_000,
    NO_GC,
  );

  it("[FIX-W61-MEMORY AC1] takes 18 floors of 5 minutes over minutes 90-180, 12 over 30-90 and the last 60", () => {
    const window = flatFloor.api.slopes["90-180"];
    assert.deepEqual(
      window.floors.map((floor) => floor.minute),
      Array.from({ length: 18 }, (_, index) => 90 + 5 * index),
    );
    assert.ok(window.floors.every((floor) => floor.heapUsedMiB === 80));
    assert.equal(flatFloor.api.slopes["30-90"].floors.length, 12);
    assert.equal(flatFloor.api.slopes["last 60"].floors.length, 12);
    assert.equal(flatFloor.floorMinutes, 5);
  });

  it("[FIX-W61-MEMORY AC1] settles on a flat floor although the heap used's own slope is above the bound", () => {
    for (const name of ["api", "worker"]) {
      const process = flatFloor[name];
      const window = process.slopes["90-180"];
      assert.equal(window.heapFloor.slopeMiBPerMinute, 0);
      assert.ok(
        window.heapUsed.slopeMiBPerMinute > SETTLE_SLOPE_MIB_PER_MINUTE,
        "the raw slope stays reported",
      );
      assert.equal(window.rss.slopeMiBPerMinute, 0.01);
      assert.equal(process.rssBelowBound, true);
      assert.equal(process.heapFloorNotAboveBound, true);
      assert.equal(process.settles, true);
    }
  });

  it("[FIX-W61-MEMORY AC1] does not settle on a floor rising 0.03 MiB a minute", () => {
    for (const name of ["api", "worker"]) {
      const process = risingFloor[name];
      assert.equal(process.slopes["90-180"].heapFloor.slopeMiBPerMinute, 0.03);
      assert.equal(process.slopes["90-180"].heapFloor.r2, 1);
      assert.equal(process.heapFloorNotAboveBound, false);
      assert.equal(process.settles, false);
    }
  });

  it("[FIX-W61-MEMORY AC1] leaves the samples after the last minute out of every floor", () => {
    // The run's last sample, 3 s after minute 180, is the lowest of all (70 MiB) and no floor.
    assert.ok(flatFloor.api.slopes["90-180"].floors.every((floor) => floor.minute < 180));
    assert.ok(flatFloor.api.slopes["last 60"].floors.every((floor) => floor.heapUsedMiB === 80));
  });

  it("[FIX-W61-MEMORY AC1] prints each window's heap floor and the verdict with the heap used for information", () => {
    const text = memoryText(flatFloor);
    assert.match(text, /heap floor 90-180 +18 floors of 5 min, 80 to 80 MiB: \+0\.0000 \(-\)\n/);
    assert.match(text, /heap floor last 60 \(120-180\) +12 floors of 5 min, 80 to 80 MiB: \+0\.0000 \(-\)\n/);
    assert.match(
      text,
      /API memory settles over minutes 90-180: RSS \+0\.0100 \(1\.00\), below 0\.02: yes; heap floor per 5 min \+0\.0000 \(-\), not above 0\.02: yes; heap used \+0\.\d{4} \(\d\.\d\d\), for information\n/,
    );
    const rising = memoryText(risingFloor);
    // The floors' range is their least and their most: 80 + 0.03 x minute from minute 90 to minute 175.
    assert.match(rising, /heap floor 90-180 +18 floors of 5 min, 82\.7 to 85\.25 MiB: \+0\.0300 \(1\.00\)\n/);
    assert.match(rising, /Worker memory does NOT settle over minutes 90-180: .*not above 0\.02: no;/);
  });
});

describe("memoryOverTime: a run shorter than 180 minutes", () => {
  const short = memoryOverTime(
    options(10, 2),
    syntheticSamples({ minutes: 10, rssSlope: 0.5, floorSlope: 0.1, amplitudeSlope: 0 }),
    10 * 60_000 + 3_000,
    NO_GC,
  );

  it("[FIX-W61-MEMORY AC1] fits the floors of --floor-minutes it has and judges nothing", () => {
    const last = short.api.slopes["last 60"];
    assert.deepEqual(
      last.floors.map((floor) => floor.minute),
      [0, 2, 4, 6, 8],
    );
    assert.equal(last.covered, false);
    assert.equal(last.heapFloor.slopeMiBPerMinute, 0.1);
    assert.deepEqual(short.api.slopes["90-180"].floors, []);
    assert.equal(short.api.slopes["90-180"].heapFloor, undefined);
    assert.equal(short.api.settles, undefined);
    assert.match(memoryText(short), /heap floor 90-180 +0 floors of 2 min \(not covered\): -\n/);
    assert.match(memoryText(short), /API memory not judged \(the run does not reach minute 180\)\n/);
  });

  it("[FIX-W61-MEMORY AC1] ends the floors of a window the run reaches in part at its last minute", () => {
    // 120 minutes: minutes 90-180 hold the floors of 90-95 to 115-120, not one of the run's last sample after minute
    // 120 (the lowest of all), and the run is not judged although that window has an RSS slope and six floors.
    const partial = memoryOverTime(
      options(120, 5),
      syntheticSamples({ minutes: 120, rssSlope: 0, floorSlope: 0, amplitudeSlope: 0 }),
      120 * 60_000 + 3_000,
      NO_GC,
    );
    const window = partial.worker.slopes["90-180"];
    assert.deepEqual(
      window.floors.map((floor) => [floor.minute, floor.heapUsedMiB]),
      [90, 95, 100, 105, 110, 115].map((minute) => [minute, 80]),
    );
    assert.equal(window.covered, false);
    assert.notEqual(window.rss, undefined);
    assert.equal(partial.worker.settles, undefined);
    assert.equal(partial.worker.rssBelowBound, undefined);
  });

  it("[FIX-W61-MEMORY AC1] takes floors of 5 minutes when the options name none", () => {
    const fallback = memoryOverTime(
      { minutes: 10, tableMinutes: 30 },
      syntheticSamples({ minutes: 10, rssSlope: 0, floorSlope: 0, amplitudeSlope: 0 }),
      10 * 60_000,
      NO_GC,
    );
    assert.equal(fallback.floorMinutes, 5);
    assert.equal(fallback.api.slopes["last 60"].floors.length, 2);
    assert.equal(fallback.api.slopes["last 60"].heapFloor, undefined, "two floors are too few for a slope");
  });
});

describe("leastSquares", () => {
  it("[FIX-W61-MEMORY AC1] fits a line with its r², and nothing with fewer than three points", () => {
    const fit = leastSquares([
      [0, 1],
      [1, 3],
      [2, 5],
    ]);
    assert.equal(fit.slope, 2);
    assert.equal(fit.r2, 1);
    assert.equal(
      leastSquares([
        [0, 1],
        [1, 3],
      ]),
      undefined,
    );
  });
});

describe("booking-load.mjs --floor-minutes", () => {
  let help;
  let refused;
  let zero;
  // Budget: three runs of plain Node that print the usage and exit, about 0.1 s each; 30 s covers three runs of at most
  // 9 s each (each is killed then) on a slow, busy machine.
  before(
    () => {
      const run = (args) =>
        spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 9_000 });
      help = run(["--help"]);
      refused = run(["--floor-minutes", "31"]);
      zero = run(["--floor-minutes", "0"]);
    },
    { timeout: 30_000 },
  );

  it("[FIX-W61-MEMORY AC1] names the option and its default in the usage, and refuses a window outside 1 to 30 minutes", () => {
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--floor-minutes <n> +minutes per window of the JS heap's floor/);
    assert.match(help.stdout, /\(default 5,/);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /--floor-minutes must be a whole number from 1 to 30/);
    // A window of 0 minutes would never end: floorsOf steps through the minutes by the window's length.
    assert.equal(zero.status, 2);
    assert.match(zero.stderr, /--floor-minutes must be a whole number from 1 to 30/);
  });
});
