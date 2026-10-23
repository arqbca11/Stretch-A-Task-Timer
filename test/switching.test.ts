// Switching groups: the focused-time split (src/ts/switching.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { focusedMs } from "../src/ts/switching.ts";

const MIN = 60000;
const T0 = Date.parse("2026-10-18T09:00:00");
const at = (m: number) => T0 + m * MIN;

test("no groups: focused time is wall time", () => {
  assert.equal(focusedMs(1, at(0), at(40), []), 40 * MIN);
});

test("a ×2 group over half the span costs a quarter of it", () => {
  const groups = [{ id: 9, blocks: [1, 2], from: at(20), to: at(40) }];
  // 40 min wall, 20 of them shared two ways -> 30 focused
  assert.equal(focusedMs(1, at(0), at(40), groups), 30 * MIN);
});

test("an open group (to == null) is clipped at upto", () => {
  const groups = [{ id: 9, blocks: [1, 2, 3], from: at(10), to: null }];
  // 30 min wall, 20 shared three ways -> 30 - 20*(2/3); the UI floors to minutes, so ms-level
  // floating point is fine
  const f = focusedMs(1, at(0), at(30), groups);
  assert.ok(Math.abs(f - (30 * MIN - 20 * MIN * (2 / 3))) < 1, String(f));
});

test("groups of other blocks don't count", () => {
  const groups = [{ id: 9, blocks: [2, 3], from: at(0), to: at(40) }];
  assert.equal(focusedMs(1, at(0), at(40), groups), 40 * MIN);
});

test("sequential groups both subtract: ×3 then ×2 after one member left", () => {
  const groups = [
    { id: 8, blocks: [1, 2, 3], from: at(0), to: at(30) },
    { id: 9, blocks: [1, 2], from: at(30), to: at(60) }
  ];
  // 30 min at 1/3 + 30 min at 1/2
  assert.equal(focusedMs(1, at(0), at(60), groups), 10 * MIN + 15 * MIN);
});

test("a group that starts before the block clips to its start", () => {
  const groups = [{ id: 9, blocks: [1, 2], from: at(-10), to: at(10) }];
  assert.equal(focusedMs(1, at(0), at(20), groups), 20 * MIN - 10 * MIN / 2);
});
