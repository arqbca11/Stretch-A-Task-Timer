// Pure logic for "switching" groups: 2–3 running blocks whose owner is context-switching
// between them rather than running them in parallel, like processes time-sliced on one CPU core
// instead of spread over several. A group is { id, blocks: [block ids], from, to }, with `to`
// null while it's still on. Groups touching the same block never overlap in time: joining or
// leaving closes the old group and opens a new one. Shared with the tests.

import type { SwitchGroup } from "./types.ts";

// Focused time in ms over [start, upto]: wall time minus the share given to the other members
// while switching — n switching tasks each get about 1/n of the core. The same split as CPU
// time against elapsed time.
export function focusedMs(id: number, start: number, upto: number, groups: SwitchGroup[]): number {
  var f = Math.max(0, upto - start);
  groups.forEach(function(g){
    if (g.blocks.indexOf(id) < 0) return;
    var a = Math.max(start, g.from);
    var z = Math.min(upto, g.to == null ? upto : g.to);
    if (z > a) f -= (z - a) * (1 - 1 / g.blocks.length);
  });
  return Math.max(0, f);
}
