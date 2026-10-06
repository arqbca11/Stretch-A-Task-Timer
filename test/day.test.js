import { test } from "node:test";
import assert from "node:assert/strict";
import { dayKeyAt, dayBounds } from "../src/js/day.js";

const at = (h, m, date, month = 9) => new Date(2026, month - 1, date, h, m).getTime();

test("dayKeyAt: the day rolls over at 4:30 am", () => {
  assert.equal(dayKeyAt(at(4, 29, 26)), "2026-09-25");
  assert.equal(dayKeyAt(at(4, 30, 26)), "2026-09-26");
  assert.equal(dayKeyAt(at(4, 31, 26)), "2026-09-26");
  assert.equal(dayKeyAt(at(0, 5, 1, 10)), "2026-09-30");   // Oct 1, 0:05 -> Sep 30
});

test("dayBounds: 4:30 am to 4:30 am, across a month end", () => {
  const b = dayBounds("2026-09-30");
  assert.equal(b.start, at(4, 30, 30));
  assert.equal(b.end, at(4, 30, 1, 10));
  assert.equal(dayKeyAt(b.start), "2026-09-30");
  assert.equal(dayKeyAt(b.end - 1), "2026-09-30");
  assert.equal(dayKeyAt(b.end), "2026-10-01");
});
