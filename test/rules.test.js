import { test } from "node:test";
import assert from "node:assert/strict";
import { rewardFor, dayKeyAt, idleBefore, carveIdle } from "../src/js/rules.js";

// Local wall-clock times, like the page uses.
function at(h, m, day = 25){ return new Date(2026, 8, day, h, m).getTime(); }
function block(worked, planned, start){ return { worked, planned, startedAt: start }; }

test("rewardFor table", () => {
  const rows = [
    ["180/120 at 6:30 am", block(180, 120, at(6, 30)), 20],
    ["75/75 at 9 am", block(75, 75, at(9, 0)), 10],
    ["75/75 at 3 pm", block(75, 75, at(15, 0)), 8],
    ["119/90 at 6:02 pm", block(119, 90, at(18, 2)), 11],
    ["10/90 at 11 pm", block(10, 90, at(23, 0)), 1],
    ["manual 120 at 1 pm", { type: "manual", worked: 120, planned: null, startedAt: at(13, 0) }, 12],
  ];
  for (const [name, e, n] of rows) assert.equal(rewardFor(e).n, n, name);
});

test("rewardFor clamps and handles unfinished blocks", () => {
  assert.equal(rewardFor(block(null, 60, at(9, 0))).n, 1);
  assert.equal(rewardFor(block(600, 60, at(6, 0))).n, 20);  // raw 31, clamped to MAX
  assert.equal(rewardFor(block(180, 120, at(2, 0, 26))).n, 14);  // late night: no early-start bonus
});

test("dayKeyAt: the day rolls over at 4:30 am", () => {
  assert.equal(dayKeyAt(at(4, 29, 26)), "2026-09-25");
  assert.equal(dayKeyAt(at(4, 30, 26)), "2026-09-26");
  assert.equal(dayKeyAt(at(4, 31, 26)), "2026-09-26");
  assert.equal(dayKeyAt(at(0, 5, 1 + 30)), "2026-09-30");  // Oct 1, 0:05 -> Sep 30
});

test("idleBefore: first block of the day counts idle from 8:30", () => {
  const gap = idleBefore(undefined, "2026-09-25", at(9, 10));
  assert.equal(gap.type, "idle");
  assert.equal(gap.startedAt, at(8, 30));
  assert.equal(gap.endedAt, at(9, 10));
  assert.equal(gap.worked, 40);
  assert.equal(idleBefore(undefined, "2026-09-25", at(8, 0)), null);
  assert.equal(idleBefore({ entries: [] }, "2026-09-25", at(8, 30)), null);
});

test("idleBefore: later blocks count from the day's last end", () => {
  const day = { entries: [
    { startedAt: at(9, 0), worked: 60 },                         // ends 10:00 (no endedAt)
    { startedAt: at(10, 30), endedAt: at(11, 15), worked: 45 },
  ] };
  const gap = idleBefore(day, "2026-09-25", at(11, 45));
  assert.equal(gap.startedAt, at(11, 15));
  assert.equal(gap.worked, 30);
  assert.equal(idleBefore(day, "2026-09-25", at(11, 15, 25) + 30000), null);   // under a minute
});

test("carveIdle trims, splits and drops idle rows", () => {
  const idle = (id, s, e) => ({ id, type: "idle", task: "idle", planned: null, startedAt: s, endedAt: e, worked: (e - s) / 60000 });
  const work = { id: "w", task: "Leetcode", startedAt: at(12, 0), endedAt: at(13, 0), worked: 60 };
  const day = { entries: [idle("a", at(9, 0), at(10, 0)), idle("b", at(10, 30), at(11, 0)), work, idle("c", at(13, 0), at(14, 0))] };

  carveIdle(day, at(9, 20), at(9, 40));   // split a
  carveIdle(day, at(10, 20), at(11, 30)); // drop b entirely
  carveIdle(day, at(13, 45), at(15, 0));  // trim c's tail

  assert.deepEqual(day.entries.map(e => [e.id, e.worked]), [["a", 20], ["ab", 20], ["w", 60], ["c", 45]]);
  assert.equal(day.entries[1].startedAt, at(9, 40));
  assert.equal(day.entries[3].endedAt, at(13, 45));
});
