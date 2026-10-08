import { test } from "node:test";
import assert from "node:assert/strict";
import { arrange } from "../src/js/columns.js";

const W = 400, PAD = 12, GUTTER = 4;

// Every pair of blocks that overlap in time must not overlap on screen.
function assertNoOverlap(items){
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j];
    if (!(a.s < b.e && b.s < a.e)) continue;
    const apart = a.col.left + a.col.width <= b.col.left + 1e-9 || b.col.left + b.col.width <= a.col.left + 1e-9;
    assert.ok(apart, `overlap: ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
  }
}

test("two blocks can't both widen into the free column between them", () => {
  const tracks = [1, 2, 3, 4].map(id => ({ id, w: 1 }));
  const items = [
    { track: 1, s: 0, e: 10 },
    { track: 3, s: 0, e: 10 },
    { track: 2, s: 20, e: 30 },
    { track: 4, s: 0, e: 30 },   // chains them all into one cluster
  ];
  arrange(items, tracks, W, PAD, GUTTER);
  assertNoOverlap(items);
  assert.deepEqual([items[0].lo, items[0].hi], [0, 1]);   // the earlier/left one gets it
  assert.deepEqual([items[1].lo, items[1].hi], [2, 2]);
});

test("a block alone takes the full width; two side by side split it", () => {
  const tracks = [{ id: 1, w: 1 }, { id: 2, w: 1 }];
  const items = [{ track: 1, s: 0, e: 10 }, { track: 2, s: 20, e: 30 }, { track: 1, s: 20, e: 30 }];
  arrange(items, tracks, W, PAD, GUTTER);
  assert.equal(items[0].col.width, W);
  assert.ok(items[1].col.width < W / 2 + 1);
});

test("stress: random days never overlap", () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let run = 0; run < 5000; run++) {
    const n = 1 + Math.floor(rnd() * 8);
    const tracks = Array.from({ length: n }, (_, i) => ({ id: i + 1, w: 0.3 + rnd() * 2 }));
    const items = [];
    tracks.forEach(t => {
      // blocks in one track never overlap each other
      let at = Math.floor(rnd() * 20);
      const k = Math.floor(rnd() * 6);
      for (let i = 0; i < k; i++) {
        const len = 1 + Math.floor(rnd() * 12);
        items.push({ track: t.id, s: at, e: at + len });
        at += len + Math.floor(rnd() * 8);
      }
    });
    arrange(items, tracks, W, PAD, GUTTER);
    assertNoOverlap(items);
    items.forEach(it => assert.ok(it.col.width > 0 && it.lo <= it.hi));
  }
});
