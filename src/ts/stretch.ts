// Stretch. A whole-day timeline that runs upwards: the morning is at the bottom
// and later is higher up. Press and hold to place a block: a die is thrown at the press point,
// bounces on the start line, and the block sprouts up by the rolled number of minutes (30–100)
// — then pull its top edge to shrink or stretch it. A block starts where it was pressed: behind
// now it's already going, ahead of now it begins by itself when the time comes. Its spent part
// turns solid as time passes.
//
// Blocks aren't named by typing. They're labeled: right-click one and pick a task type (or add
// a new one — every label ever added is kept to pick from, in the "labels" record). A labeled
// block wears a small speech bubble; clicking it opens the bubble with the label and a small
// note to scribble in.
//
// Multitasking: a block is thin (about a tenth of the panel), or a whole multiple of that wide —
// wider for the task taking the most attention — and sits where it was put —
// the x axis is free, and the distances between blocks are the owner's to mean something with
// (how related two tasks are). Blocks that overlap in x are one queue, like processes pinned to
// one core: a block runs until the next one over it begins. Blocks apart in x run in parallel.
// Drag a block sideways to move it. Two or three running blocks can be marked as "switching":
// not parallel but time-sliced on one core, the way a single CPU multitasks by context-switching
// — while the group is on, a little ball bounces between the members around the now line, like
// an atom hitting each block at an angle, and each member gets about 1/n of the wall clock as
// focused time (shown on hover).
//
// Other days: the calendar at the top right opens any day. A past day shows what was done and
// can still be touched up; a future day starts blank and takes blocks ahead of time, which are
// simply there when the day comes. The view follows the clock only while it's on today.
//
// Getting up and going to bed: right-click a blank spot for "Got out of bed!" or "Going to bed!",
// a small bubble pointing at the axis at that time. Drag it up or down to the exact minute.
//
// TODOs: right-click a blank spot ahead of now for "Add TODO", a small bubble in a loud colour
// whose tail points at that spot, and type what to finish. A block can be linked to one TODO of
// its day from its right-click menu, whatever its label; a line in the TODO's colour joins them.
//
// Storage: each change writes the whole day, blocks and switching groups, as one record through
// the bridge to an append-only log in Rust (`stretch.log`; see docs/storage.md). The page keeps
// no other copy.
import { dayKeyAt, dayBounds, monthCells } from "./day.ts";
import { focusedMs } from "./switching.ts";
import { rollDie, cancelRoll, dieBusy } from "./dice.js";   // hand-kept JS; types in dice.d.ts
import type { BlockRecord, DayRecord, Label, LabelsRecord, StoredDay, StoredLabels, SwitchGroup, TodoRecord } from "./types.ts";

type State = "ahead" | "running" | "done";
type MarkKind = "wake" | "sleep";
// A block on show: its stored record plus what's drawn for it, which is never written.
interface Block extends BlockRecord {
  el?: BlockEls;          // set by mount
  state?: State;          // the state it was mounted in
  anim?: object | null;   // the token of the spring animation running on it
  inset?: number;         // px: how far it's squeezed in on each side while pulled
}
interface BlockEls {
  root: HTMLDivElement;
  fill: HTMLDivElement;
  handle: HTMLDivElement | null;
  badge: HTMLButtonElement | null;
  shade: HTMLDivElement;
}
// The dashed line between two aligned blocks.
interface Tie { key: string; el: HTMLDivElement; lo: Block; hi: Block; }
// A switching ball in the gap between members a and b, which it crosses from lo to hi (px).
interface Ball {
  key: string; el: HTMLDivElement; a: Block; b: Block; lo: number; hi: number;
  x: number; dy: number; sx: number; vy: number;
  leg: HTMLDivElement | null; tx: number; ty: number;   // the trace leg on show, from (tx, ty)
}
// Where blocks are being put by a change, for pushAside; and what it decided.
type Fixed = Map<Block, { x: number; span: number }>;
interface Push { pos: Map<Block, number>; hits: Map<Block, { depth: number; dir: number }>; }
interface Hit { by: Block; o: Block; dir: number; d: number; }   // `by` knocks `o` d px in dir
interface Press {
  pointer: number; x0: number; y0: number; x: number; y: number;
  over: Block | null | undefined; ring: HTMLDivElement; timer: ReturnType<typeof setTimeout>;
}
interface Pull {
  b: Block; pointer: number; x: number; y: number; plan0: number; end0: number | null;
  base: number; anchor: number; max: number; edge: number; v: number; want: number; last: number;
  created: boolean; tag: HTMLDivElement; band: HTMLDivElement;
}
interface Move {
  b: Block; pointer: number; y0: number; s0: number; start0: number; end: number;
  lo: number; hi: number; tag: HTMLDivElement;
}
interface Drag { b: Block; pointer: number; x0: number; at: number; dx: number; }
interface Bubble { el: HTMLDivElement; b: Block; save: () => void; }
interface Todo extends TodoRecord { el?: HTMLDivElement; }   // el: set by mountTodo

(function(){
  "use strict";

  /* ---------- tunables (minutes; the timeline is drawn at PX px per minute) ---------- */
  var PX = 1.6;                     // 24 h is about 2,300 px
  var SNAP = 5;                     // starts and ends land on 5-minute steps
  var ROLL_MIN = 30, ROLL_MAX = 100;   // a new block's length is rolled, 30–100 min on 5-min steps
  var MIN_PLAN = 10, MAX_PLAN = 180;
  var HOLD_MS = 400;                // press and hold this long to make a block; a click makes nothing
  var HOLD_SLOP = 6;                // px: moving further than this before then cancels the press
  var TAIL_MIN = 10;                // a press this close to a block's end follows it instead of going beside it
  // The pull is elastic. The edge is a weight on a spring tied to the pointer: it trails behind
  // while you pull and bounces when you stop or let go. Each extra minute takes more pull than the
  // last (logarithmic, so the band between edge and pointer grows), and past a limit the edge
  // barely gives at all.
  var TENSION = 200;                // px: larger is looser, closer to 1:1
  var RUBBER = 36;                  // px: the most the edge gives past a limit
  var FOLLOW_K = 110, FOLLOW_C = 11;   // spring while pulling: soft, so it trails and wobbles
  var SPRING_K = 380, SPRING_C = 14;   // spring after release: settles onto the 5-minute step
  var SQUEEZE = 18;                 // px: how much the block narrows on each side at full tension
  var BLOCK_W = 34;                 // px: the narrowest block, about a tenth of the panel; the unit of width
  var SPAN_MAX = 4;                 // the widest a block can be, in BLOCK_Ws
  var KNOCK = [17, 12, 8, 4, 0];    // px: how far clear a pushed block lands, roomiest that fits first
  var PAD_L = 12, PAD_R = 8;        // px: lane padding
  var INK = 2;                      // px: a block's outline, matching the CSS border
  var BADGE_INK = 2;                // px: the badge's outline, matching .st-bub-icon's border
  var SHADE_X = 5, SHADE_Y = 4;     // px: how far the halftone shadow peeks out bottom-right
  var SWITCH_MAX = 3;               // the most blocks that can switch together

  // Each new block takes the next colour in this ring, so no two blocks in a row match. Bright
  // enough that black text reads on all of them. Stored as "r,g,b" for rgb()/rgba() in the CSS.
  var PALETTE = [
    "0,194,206",    // teal
    "255,61,139",   // hot pink
    "255,138,0",    // orange
    "61,123,255",   // electric blue
    "255,214,10",   // lemon
    "163,91,255",   // violet
    "46,229,157",   // mint
    "255,90,78",    // coral
    "126,211,33"    // lime
  ];

  var MIN_MS = 60000;
  // Blocks: { id, task, x, span, start, plan (min), created, end, color, label, note }, times in
  // ms; `end` is set only by Done; `x` is the block's left edge in the lane, px, and `span` its
  // width in BLOCK_Ws (1, 2, 3…; how much attention it takes); `color` indexes
  // PALETTE; `label` is a label id (or null) and `note` a small free note, both shown in the
  // block's speech bubble. `task` is a typed name from before labels; old blocks still show it.
  // Switching groups: { id, blocks: [block ids], from, to }, `to` null while on (switching.js).
  // Labels are global, not per day: [{ id, name }], kept in their own "labels" record.
  // Marks: when she got out of bed and went to bed that day, ms or null.
  var blocks: Block[] = [], switches: SwitchGroup[] = [];
  var marks: Record<MarkKind, number | null> = { wake: null, sleep: null };
  var todos: Todo[] = [];
  var labels: Label[] = [], nextLabelId = 1;
  var dayKey = "", dayStart = 0, dayEnd = 0;   // set by buildDay
  var following = true;   // showing today, so the view moves on when the day rolls over
  var pull: Pull | null = null;     // the end edge (on top) being pulled
  var press: Press | null = null;   // a press that becomes a block if it's held
  var move: Move | null = null;     // the start edge (at the bottom) being moved
  var drag: Drag | null = null;     // a block being dragged sideways to a new place
  var nextId = 1;
  var msgTimer: ReturnType<typeof setTimeout> | undefined;
  // The days as loaded and since written, by date. The labels record is loaded into `labels`.
  var saved: Partial<Record<string, StoredDay>> = {};
  var storageDown: string | null = null;   // why the stretch log couldn't load; nothing is written then

  function $(id: string){ return document.getElementById(id)!; }
  var scroller = $("st-scroll"), day = $("st-day"), lane = $("st-lane"), axis = $("st-axis");
  var nowLine = $("st-now");
  // The part of the day already gone (below now, since time runs up) has a grey background.
  var past = document.createElement("div");
  past.className = "st-past";
  lane.prepend(past);
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* ---------- time <-> position: time runs upwards, so y counts down from the day's end ---------- */
  function yOf(ts: number){ return (dayEnd - ts) / MIN_MS * PX; }
  function tsAt(y: number){ return dayEnd - y / PX * MIN_MS; }
  function snapDown(ts: number){ var m = SNAP * MIN_MS; return dayStart + Math.floor((ts - dayStart) / m) * m; }
  function snapUp(ts: number){ var m = SNAP * MIN_MS; return dayStart + Math.ceil((ts - dayStart) / m) * m; }
  function clock(ts: number){ return new Date(ts).toLocaleTimeString(undefined, { hour:"numeric", minute:"2-digit" }); }
  function shortClock(ts: number){ var d = new Date(ts); return (d.getHours() % 12 || 12) + ":" + String(d.getMinutes()).padStart(2, "0"); }
  function hourLabel(h: number){ return (h % 12 || 12) + (h < 12 ? " am" : " pm"); }
  function minsBetween(a: number, b: number){ return Math.floor((b - a) / MIN_MS); }

  /* ---------- queues: blocks that overlap in x share a core and run in sequence ---------- */
  // A block is `span` BLOCK_Ws wide. Its centre line is what alignment, ties and the magnet go by,
  // so blocks of different widths line up on their middles.
  function widthOf(b: Block){ return (b.span || 1) * BLOCK_W; }
  function centreOf(b: Block){ return b.x + widthOf(b) / 2; }
  // x stays on whole pixels (BLOCK_W is even), so centres compare exactly.
  function clampX(x: number, w?: number){ return Math.round(Math.max(PAD_L, Math.min(lane.clientWidth - PAD_R - (w || BLOCK_W), x))); }
  // Whether spans [x, x + w) overlap: then they share a core.
  function spansMeet(x1: number, w1: number, x2: number, w2: number){ return x1 < x2 + w2 && x2 < x1 + w1; }
  function xOverlap(a: Block, b: Block){ return spansMeet(a.x, widthOf(a), b.x, widthOf(b)); }
  function byId(id: number){ return blocks.find(function(b){ return b.id === id; }); }
  function nextAfter(b: Block){
    var n = null as Block | null;
    blocks.forEach(function(o){
      if (o !== b && xOverlap(o, b) && o.start > b.start && (!n || o.start < n.start)) n = o;
    });
    return n;
  }
  function prevBefore(b: Block){
    var p = null as Block | null;
    blocks.forEach(function(o){
      if (o !== b && xOverlap(o, b) && o.start < b.start && (!p || o.start > p.start)) p = o;
    });
    return p;
  }
  // When a block stops. Done sets it outright. Otherwise a block ends when the next block in its
  // queue (the next block over it in x) begins, and never later than its planned end: past the
  // plan it stops growing but stays running (and stretchable) until something ends it. Blocks
  // apart in x run in parallel and never end it.
  function endOf(b: Block, now: number): number | null {
    if (b.end != null) return b.end;
    var n = nextAfter(b);
    if (n && n.start <= now) return Math.min(b.start + b.plan * MIN_MS, n.start);
    return null;
  }
  function stateOf(b: Block, now: number): State {
    if (b.start > now) return "ahead";
    return endOf(b, now) == null ? "running" : "done";
  }
  // Where the block's area on the timeline ends: its end, or else its planned end.
  function extentOf(b: Block, now: number){
    var e = endOf(b, now);
    return e != null ? e : b.start + b.plan * MIN_MS;
  }
  // The longest plan that fits before the next block in its queue (or the end of the day). A
  // block that has begun can be stretched to now and up to MAX_PLAN beyond it, so coming back
  // late never leaves the block out of reach. That holds for a finished block too: pulled past
  // now, it's still going after all (endPull reopens it). One ended by the next block in its
  // queue can't get there, since that block began before now.
  function roomAfter(b: Block){
    var now = Date.now();
    var cap = b.start <= now ? minsBetween(b.start, now) + MAX_PLAN : MAX_PLAN;
    var n = nextAfter(b);
    return Math.min(cap, minsBetween(b.start, n ? n.start : dayEnd));
  }
  function snapPlan(px: number, max: number){
    var m = Math.round(px / PX / SNAP) * SNAP;
    return Math.max(MIN_PLAN, Math.min(max, m));
  }

  // Lay every block not mid-gesture out again, and refresh the switching balls.
  function relayout(now: number){
    blocks.forEach(function(b){
      if (!b.el || b.anim || (pull && pull.b === b) || (drag && drag.b === b)) return;
      layout(b, null, now);
    });
    rebuildBalls();
    rebuildTies();
    rebuildLinks();
  }

  /* ---------- aligned blocks: one label, one x, tied by a dashed line ---------- */
  // Blocks that share a label and sit on exactly the same centre line are aligned: a dashed line
  // runs up the gap between each one and the next. Nothing is stored — it's drawn from the labels
  // and the positions, so dragging one away unties it. "Align" in the right-click menu lines up
  // every block of a label at once. Widths can differ: changing one keeps its centre, so the
  // line holds.
  var ties: Tie[] = [];
  function kinOf(b: Block){
    return b.label == null ? [] : blocks.filter(function(o){ return o.label === b.label; });
  }
  function rebuildTies(){
    var keep: Partial<Record<string, Tie>> = {};
    ties.forEach(function(t){ keep[t.key] = t; });
    ties = [];
    var rows: Record<string, Block[]> = {};   // label:centre → blocks, so each column of a label is tied in start order
    blocks.forEach(function(b){
      if (b.label == null || !b.el || (drag && drag.b === b)) return;
      var r = b.label + ":" + centreOf(b);
      (rows[r] = rows[r] || []).push(b);
    });
    Object.keys(rows).forEach(function(r){
      var row = rows[r].sort(function(a, c){ return a.start - c.start; });
      for (var i = 0; i < row.length - 1; i++) {
        var key = row[i].id + ":" + row[i + 1].id;
        var t = keep[key];
        delete keep[key];
        if (!t) {
          var el = document.createElement("div");
          el.className = "st-tie";
          lane.append(el);
          t = { key: key, el: el, lo: row[i], hi: row[i + 1] };
        }
        t.lo = row[i];
        t.hi = row[i + 1];
        placeTie(t);
        ties.push(t);
      }
    });
    Object.keys(keep).forEach(function(key){ keep[key]!.el.remove(); });
  }
  // From the top of the earlier block up to the bottom of the later one (time runs up).
  function placeTie(t: Tie){
    var lo = t.lo.el!.root, hi = t.hi.el!.root;
    var top = hi.offsetTop + hi.offsetHeight, bottom = lo.offsetTop;
    t.el.hidden = bottom - top < 2;
    t.el.style.left = (centreOf(t.lo) - 1) + "px";
    t.el.style.top = top + "px";
    t.el.style.height = Math.max(0, bottom - top) + "px";
  }
  function placeTiesOf(b: Block){
    ties.forEach(function(t){ if (t.lo === b || t.hi === b) placeTie(t); });
  }

  // Line up every block of b's label on b's centre line, each keeping its own width, pushing
  // aside other blocks in the way (pushAside). If even that finds no room, the nearest centre
  // where all of them fit as things stand is used instead. Blocks of one label that overlap in
  // time can't share a queue, so then nothing moves.
  function align(b: Block){
    var kin = kinOf(b), now = Date.now();
    var seq = kin.slice().sort(function(a, c){ return a.start - c.start; });
    for (var i = 0; i < seq.length - 1; i++) {
      if (extentOf(seq[i], now) > seq[i + 1].start) {
        say("Can't align: two " + labelOf(b) + " blocks overlap in time.");
        return;
      }
    }
    function fits(c: number){
      return kin.every(function(k){
        var x = c - widthOf(k) / 2;
        return clampX(x, widthOf(k)) === x && !blocks.some(function(o){
          return kin.indexOf(o) < 0 && spansMeet(o.x, widthOf(o), x, widthOf(k)) &&
            o.start < extentOf(k, now) && k.start < extentOf(o, now);
        });
      });
    }
    var c0 = centreOf(b), c: number | null = null;
    var fixed: Fixed = new Map();
    kin.forEach(function(k){ fixed.set(k, { x: c0 - widthOf(k) / 2, span: k.span || 1 }); });
    var push = shove(fixed, c0);
    if (push) { applyPush(push); return; }
    for (var d = 0; c == null && d < lane.clientWidth; d += 4) {
      if (fits(c0 + d)) c = c0 + d;
      else if (fits(c0 - d)) c = c0 - d;
    }
    if (c == null) { say("No room to align these."); return; }
    kin.forEach(function(k){ k.x = c! - widthOf(k) / 2; });
    render();   // they're one queue now; the slide transition carries them there
    persist();
  }

  /* ---------- the switching ball: an atom bouncing between the members ---------- */
  // While a group is on, a little ball ricochets across each gap between adjacent members. Each
  // leg is a straight line: the ball only changes direction when it strikes a block, where it
  // reflects sideways and leaves for a new vertical offset (within ±BALL_AMP of the now line),
  // so the angle changes bounce to bounce. The last few legs stay visible as a fading trace.
  // The ball is only there while both members are inside their plans: when one's time is up it
  // vanishes, and comes back when that block is stretched past now again. It rides up with the
  // clock and goes when the group does. With reduced motion it sits still in the gap, no trace.
  var BALL = 5, BALL_AMP = 9;          // px: ball size (matches the CSS) and vertical reach
  var BALL_VX = 34;                    // px/s: sideways speed; a leg's vertical speed follows
  var TRACE_MS = 5000;                 // how long a finished leg takes to fade
  var balls: Ball[] = [], ballsRaf = false, ballLast = 0;

  // Aim for a new vertical offset on the far block, reached exactly at the next strike.
  function aim(k: Ball){
    var T = Math.max(0.2, (k.hi - k.lo) / BALL_VX);
    k.vy = ((Math.random() * 2 - 1) * BALL_AMP - k.dy) / T;
  }
  function ballAt(k: Ball, cy: number){ return { x: k.x + BALL / 2, y: cy + k.dy }; }
  function legStart(k: Ball, cy: number){
    if (reduceMotion.matches) return;
    var p = ballAt(k, cy);
    k.tx = p.x;
    k.ty = p.y;
    k.leg = document.createElement("div");
    k.leg.className = "st-trace";
    lane.append(k.leg);
  }
  function legUpdate(k: Ball, cy: number){
    if (!k.leg) return;
    var p = ballAt(k, cy);
    k.leg.style.left = k.tx + "px";
    k.leg.style.top = k.ty + "px";
    k.leg.style.width = Math.hypot(p.x - k.tx, p.y - k.ty) + "px";
    k.leg.style.transform = "rotate(" + Math.atan2(p.y - k.ty, p.x - k.tx) + "rad)";
  }
  // A strike: freeze the leg and let it fade, then start the next one from here.
  function legEnd(k: Ball, cy: number){
    if (!k.leg) return;
    legUpdate(k, cy);
    var el = k.leg;
    el.classList.add("fading");
    setTimeout(function(){ el.remove(); }, TRACE_MS + 100);
    legStart(k, cy);
  }
  // A strike against a block: the ball squashes against the wall for a beat, and two comic
  // accent strokes flare at the contact point — the context switch made visible.
  function strike(k: Ball, dir: number, cy: number){
    if (reduceMotion.matches) return;
    if (k.el.animate) k.el.animate(
      [{ transform: "scale(.55, 1.45)" }, { transform: "none" }],
      { duration: 150, easing: "cubic-bezier(.2,.8,.4,1)" });
    var s = document.createElement("div");
    s.className = "st-spark" + (dir < 0 ? " flip" : "");
    s.style.left = (k.x + BALL / 2) + "px";
    s.style.top = (cy + k.dy) + "px";
    lane.append(s);
    setTimeout(function(){ s.remove(); }, 450);
  }

  function hideBall(k: Ball){
    k.el.hidden = true;
    if (k.leg) { k.leg.remove(); k.leg = null; }
  }
  function dropBall(k: Ball){
    k.el.remove();
    if (k.leg) k.leg.remove();
  }

  function rebuildBalls(){
    var keep: Partial<Record<string, Ball>> = {};
    balls.forEach(function(k){ keep[k.key] = k; });
    balls = [];
    var now = Date.now(), cy = yOf(now);
    switches.forEach(function(g){
      if (g.to != null) return;
      var members = g.blocks.map(byId).filter(function(o){ return o !== undefined; }).sort(function(a, c){ return a.x - c.x; });
      for (var i = 0; i < members.length - 1; i++) {
        var lo = members[i].x + widthOf(members[i]) + 1, hi = members[i + 1].x - 1 - BALL;
        if (hi <= lo) continue;
        var key = g.id + ":" + i;
        var k = keep[key];
        delete keep[key];
        if (!k) {
          var el = document.createElement("div");
          el.className = "st-ball";
          el.hidden = true;
          lane.append(el);
          k = { key: key, el: el, a: members[i], b: members[i + 1], lo: lo, hi: hi,
                x: lo + Math.random() * (hi - lo),
                dy: (Math.random() * 2 - 1) * BALL_AMP,
                sx: Math.random() < 0.5 ? -1 : 1, vy: 0, leg: null, tx: 0, ty: 0 };
          aim(k);
        }
        k.a = members[i];
        k.b = members[i + 1];
        k.lo = lo;
        k.hi = hi;
        k.x = Math.max(lo, Math.min(hi, k.x));
        balls.push(k);
      }
    });
    Object.keys(keep).forEach(function(key){ dropBall(keep[key]!); });
    balls.forEach(function(k){ placeBall(k, now, cy); });
    if (balls.length && !ballsRaf && !reduceMotion.matches) {
      ballsRaf = true;
      ballLast = performance.now();
      requestAnimationFrame(ballFrame);
    }
  }

  // Show, hide or pin the ball by the members' state; shared by rebuilds and frames.
  function placeBall(k: Ball, now: number, cy: number){
    if (extentOf(k.a, now) <= now || extentOf(k.b, now) <= now) { hideBall(k); return false; }
    if (k.el.hidden) {
      k.el.hidden = false;
      legStart(k, cy);
    }
    if (reduceMotion.matches) { k.x = (k.lo + k.hi) / 2; k.dy = 0; }
    k.el.style.left = k.x + "px";
    k.el.style.top = (cy + k.dy - BALL / 2) + "px";
    return true;
  }

  function ballFrame(t: number){
    if (!balls.length || reduceMotion.matches) { ballsRaf = false; return; }
    var dt = Math.min(0.05, (t - ballLast) / 1000);
    ballLast = t;
    var now = Date.now(), cy = yOf(now);
    balls.forEach(function(k){
      if (!placeBall(k, now, cy)) return;
      k.x += k.sx * BALL_VX * dt;
      k.dy += k.vy * dt;
      var hit = 0;
      if (k.x <= k.lo) { k.x = k.lo; k.sx = 1; hit = 1; }
      else if (k.x >= k.hi) { k.x = k.hi; k.sx = -1; hit = -1; }
      k.dy = Math.max(-BALL_AMP, Math.min(BALL_AMP, k.dy));
      k.el.style.left = k.x + "px";
      k.el.style.top = (cy + k.dy - BALL / 2) + "px";
      if (hit) { legEnd(k, cy); aim(k); strike(k, hit, cy); }
      else legUpdate(k, cy);
    });
    requestAnimationFrame(ballFrame);
  }

  /* ---------- switching groups ---------- */
  function activeGroupOf(b: Block){
    return switches.find(function(g){ return g.to == null && g.blocks.indexOf(b.id) >= 0; });
  }
  // Mark b and o as switched between. If b already switches, o joins: the old group is closed
  // and a wider one opens, so each span keeps the size it ran at.
  function joinSwitch(b: Block, o: Block){
    var now = Date.now();
    var g = activeGroupOf(b);
    var members = g ? g.blocks.slice() : [b.id];
    if (g) g.to = now;
    members.push(o.id);
    switches.push({ id: nextId++, blocks: members, from: now, to: null });
    relayout(now);
    persist();
  }
  function endSwitch(g: SwitchGroup){
    g.to = Date.now();
    relayout(g.to);
    persist();
  }

  /* ---------- the day ---------- */
  // Show the day `key` ("YYYY-MM-DD"), today if none.
  function buildDay(key?: string){
    var today = dayKeyAt(Date.now());
    dayKey = key || today;
    following = dayKey === today;
    var bounds = dayBounds(dayKey);
    dayStart = bounds.start;
    dayEnd = bounds.end;
    day.style.height = yOf(dayStart) + "px";
    var opts: Intl.DateTimeFormatOptions = { weekday:"long", month:"long", day:"numeric" };
    if (dayKey.slice(0, 4) !== today.slice(0, 4)) opts.year = "numeric";
    $("st-date").textContent = new Date(dayStart).toLocaleDateString(undefined, opts);
    $("st-today").hidden = following;
    cancelRoll();
    cancelPress();
    closeMenu();
    hideTip();

    axis.textContent = "";
    for (var t = dayStart + 30 * MIN_MS; t < dayEnd; t += 60 * MIN_MS) {
      var label = document.createElement("span");
      label.textContent = hourLabel(new Date(t).getHours());
      label.style.top = yOf(t) + "px";
      axis.appendChild(label);
    }
    closeAllBubbles();
    todos.forEach(function(t){ if (t.el) t.el.remove(); });
    // Show this day as saved (a new day starts empty). A day written before free placement has
    // a slot index, or before that a `track` id and a tracks array, whose left-to-right order
    // maps to a column; either way old columns spread out from the left.
    blocks.forEach(function(b){
      if (!b.el) return;
      b.el!.root.remove();
      b.el!.shade.remove();
      if (b.el!.badge) b.el!.badge.remove();
    });
    var doc = saved[dayKey] || {};
    var order = (doc.tracks || []).map(function(t){ return t.id; });
    blocks = (doc.blocks || []).map(function(b){
      var x = b.x;
      if (x == null) {
        var slot = b.slot != null ? b.slot : b.track == null ? 0 : Math.max(0, order.indexOf(b.track));
        x = PAD_L + slot * (BLOCK_W + 8);
      }
      var span = Math.max(1, Math.min(SPAN_MAX, b.span || 1));
      return { id: b.id, task: b.task || "", x: clampX(x, span * BLOCK_W), span: span, start: b.start,
               plan: b.plan, created: b.created, end: b.end == null ? null : b.end,
               color: (b.color == null ? b.id - 1 : b.color) % PALETTE.length,
               label: b.label == null ? null : b.label, note: b.note || "",
               bubbleY: b.bubbleY == null ? null : b.bubbleY, todo: b.todo == null ? null : b.todo };
    });
    todos = (doc.todos || []).map(function(t){
      return { id: t.id, x: t.x, at: t.at, text: t.text || "", color: (t.color || 0) % TODO_PALETTE.length,
               done: !!t.done };
    });
    switches = (doc.switches || []).map(function(g){
      return { id: g.id, blocks: g.blocks.slice(), from: g.from, to: g.to == null ? null : g.to };
    });
    [...blocks, ...switches, ...todos].forEach(function(o){ nextId = Math.max(nextId, o.id + 1); });
    marks = { wake: doc.wake == null ? null : doc.wake, sleep: doc.sleep == null ? null : doc.sleep };
    renderMarks();
    todos.forEach(mountTodo);
    render();
  }

  // Bring the blocks' elements up to date. Elements are kept across renders, so when the columns
  // change, blocks slide to their new widths instead of being redrawn.
  function render(){
    var now = Date.now();
    blocks.forEach(function(b){
      if (!b.el) mount(b);
      else if (stateOf(b, now) !== b.state && !(pull && pull.b === b) && !(move && move.b === b)) remount(b);
    });
    tick();
  }

  function button(label: string, cls: string, title: string, fn: () => void){
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    if (cls) b.className = cls;
    b.addEventListener("click", fn);
    return b;
  }

  function mount(b: Block){
    var now = Date.now();
    b.state = stateOf(b, now);
    var root = document.createElement("div");
    root.className = "st-block " + b.state + (b.state === "ahead" ? "" : " started");
    root.style.setProperty("--st-c", PALETTE[b.color]);
    var fill = document.createElement("div"); fill.className = "st-fill";
    root.append(fill);
    // The halftone shadow is its own element *under* every block (z-index below them), so it
    // can peek out past this block's bottom-right but never print over a neighbour. It follows
    // the block through layout, moveDrag and the pulling/dragging classes.
    var shade = document.createElement("div");
    shade.className = "st-shade";
    // Hover shows when it starts and how long it is, beside the pointer; right-click for actions.
    root.addEventListener("pointermove", function(e){ showTip(b, e); });
    root.addEventListener("pointerleave", hideTip);
    root.addEventListener("contextmenu", function(e){ e.preventDefault(); openMenu(b, e); });
    var handle = null;
    // Finished blocks keep their edges too, so a task logged after the fact can be fixed up.
    {
      handle = document.createElement("div");
      handle.className = "st-handle";
      handle.title = "Pull up to change when it ends";
      handle.addEventListener("pointerdown", function(e){ grabHandle(b, e); });
      var startEdge = document.createElement("div");
      startEdge.className = "st-handle start";
      startEdge.title = "Drag to change when it starts";
      startEdge.addEventListener("pointerdown", function(e){ grabStart(b, e); });
      root.append(handle, startEdge);
    }
    b.el = { root: root, fill: fill, handle: handle, badge: null, shade: shade };
    syncBadge(b);
    lane.append(shade, root);
    layout(b, null, now);
  }

  function remount(b: Block){
    b.el!.root.remove();
    b.el!.shade.remove();
    if (b.el!.badge) b.el!.badge.remove();
    mount(b);
  }

  // The pulling/dragging classes (they kill the slide transition) go to the shade and badge too.
  function mark(b: Block, cls: string, on: boolean){
    b.el!.root.classList.toggle(cls, on);
    b.el!.shade.classList.toggle(cls, on);
    if (b.el!.badge) b.el!.badge.classList.toggle(cls, on);
  }

  // The badge on a labeled block: a mini bubble — rounded box, sharp tail — wearing the first
  // couple of words of the label. Clicking it pops the big bubble out of it.
  function syncBadge(b: Block){
    var r = b.el!;
    var want = b.label != null;
    if (!want) {
      if (r.badge) { r.badge.remove(); r.badge = null; }
      return;
    }
    if (r.badge) {   // relabeled: just re-dress it (its width, and so its tail, may change)
      r.badge.firstChild!.textContent = labelNameOf(b) || "";
      r.badge.title = labelNameOf(b) || "";
      placeBadge(b);
      return;
    }
    var badge = document.createElement("button");
    badge.type = "button";
    badge.className = "st-bub-icon";
    badge.title = labelNameOf(b) || "";
    var txt = document.createElement("span");
    txt.textContent = labelNameOf(b) || "";
    badge.append(txt);
    badge.insertAdjacentHTML("beforeend",
      '<svg class="st-bub-tail" aria-hidden="true"><polyline /></svg>');
    badge.addEventListener("pointerdown", function(e){ badgeDrag(b, e); });
    if (bubbles[b.id]) badge.style.visibility = "hidden";   // its bubble is out
    // The badge lives in the lane, not in the block, at a z above every block — so no
    // neighbour can ever cover it. placeBadge keeps it pinned to its block.
    lane.append(badge);
    r.badge = badge;
    placeBadge(b);
  }

  // Pin the badge to its block at bubbleY below the block's top. The tail is short and fixed;
  // the badge is shifted sideways so the tail's tip lands on the block's centre line. It sits
  // to the right of the centre, or to the left (flipped) near the panel's edge.
  var TAIL_TIP = 7;   // px: the tail tip's x from the box's inner edge on the tail's side
  function placeBadge(b: Block){
    var r = b.el;
    if (!r || !r.badge) return;
    // The centre from the inline left/width — where the block is going — not offsetLeft, which
    // reads the start of a slide, so the badge would stay behind a block sliding away.
    var rootTop = r.root.offsetTop;
    var centre = parseFloat(r.root.style.left) + parseFloat(r.root.style.width) / 2;
    var flip = b.x + widthOf(b) > lane.clientWidth - PAD_R - 70;
    var inner = r.badge.clientWidth;   // the padding box, inside the 2-px border
    var tip = flip ? inner - TAIL_TIP : TAIL_TIP;
    r.badge.classList.toggle("flip", flip);
    r.badge.style.top = (rootTop + (b.bubbleY == null ? -8 : b.bubbleY)) + "px";
    r.badge.style.left = (centre - BADGE_INK - tip) + "px";
    // in the tail's coordinates: x from the padding box, y = 0 at the bottom border's inner edge
    var a = flip ? inner - 12 : 4, z = flip ? inner - 4 : 12;
    r.badge.querySelector("polyline")!.setAttribute("points",
      a + ",-1 " + tip + ",9 " + z + ",-1");
  }

  // Press the badge and drag up or down to slide it along the block (bubbleY, remembered);
  // a press that doesn't move is a click, which pops the bubble out of it.
  function badgeDrag(b: Block, e: PointerEvent){
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    var badge = b.el!.badge!;   // only a labeled block has one, and this is its handler
    try { badge.setPointerCapture(e.pointerId); } catch (_) {}
    var y0 = e.clientY, t0 = parseFloat(badge.style.top) || 0, moved = false;
    var rootTop = b.el!.root.offsetTop;
    function mv(ev: PointerEvent){
      if (ev.pointerId !== e.pointerId) return;
      var dy = ev.clientY - y0;
      if (!moved && Math.abs(dy) < 4) return;
      moved = true;
      var hi = rootTop + Math.max(-8, b.el!.root.offsetHeight - 16);
      badge.style.top = Math.max(rootTop - 8, Math.min(hi, t0 + dy)) + "px";
    }
    function up(ev: PointerEvent){
      if (ev.pointerId !== e.pointerId) return;
      badge.removeEventListener("pointermove", mv);
      badge.removeEventListener("pointerup", up);
      badge.removeEventListener("pointercancel", up);
      if (!moved) {
        if (ev.type !== "pointercancel") {
          if (bubbles[b.id]) closeBubble(b);
          else openBubble(b);
        }
        return;
      }
      var t = parseFloat(badge.style.top) - rootTop;
      if (t !== b.bubbleY) { b.bubbleY = t; persist(); }
    }
    badge.addEventListener("pointermove", mv);
    badge.addEventListener("pointerup", up);
    badge.addEventListener("pointercancel", up);
  }

  // Position a block. `planPx` overrides its length while it's being pulled or settling.
  function layout(b: Block, planPx: number | null, now: number){
    var r = b.el!;
    var live = planPx != null;
    if (planPx == null) planPx = b.plan * PX;
    var height: number, solid: number;
    if (b.state === "done") {
      // mid-pull it can reach past now, where it would be running again: solid only up to now
      height = solid = live ? planPx : Math.max(3, (endOf(b, now)! - b.start) / MIN_MS * PX);
      if (live) solid = Math.min(height, Math.max(0, (now - b.start) / MIN_MS * PX));
    } else if (b.state === "running") {
      height = planPx;
      solid = Math.min(height, Math.max(0, (now - b.start) / MIN_MS * PX));   // the fill stops at the planned end
    } else {
      height = planPx;
      solid = 0;
    }
    var inset = Math.min(b.inset || 0, BLOCK_W * 0.15);   // squeezed while it's being pulled (the same at any width)
    var top = yOf(b.start) - height;                      // it starts at the bottom and grows up
    // Back-to-back blocks in a queue share one outline: when the block above starts exactly
    // where this one ends, this box grows one border up so the two borders print as one line
    // (same ink, so the overlap is invisible). Skipped mid-pull, where height is transient.
    if (!live) {
      var n = nextAfter(b);
      if (n && Math.abs(top - yOf(n.start)) < 0.75) { top -= INK; height += INK; }
    }
    var left = b.x + inset, width = Math.max(8, widthOf(b) - 2 * inset);
    r.root.style.top = top + "px";
    r.root.style.height = height + "px";
    r.root.style.left = left + "px";
    r.root.style.width = width + "px";
    r.fill.style.height = Math.max(0, Math.min(solid, height - 2 * INK)) + "px";   // inside the outline
    r.shade.style.top = (top + SHADE_Y) + "px";
    r.shade.style.height = height + "px";
    r.shade.style.left = (left + SHADE_X) + "px";
    r.shade.style.width = width + "px";
    placeBadge(b);
    placeTiesOf(b);
    placeLink(b);
    if (r.handle) r.handle.style.top = "0px";   // the top edge is always the planned end
  }

  // What the hover label says about a block. Focused time is wall time minus the share spent
  // on the other members while switching — elapsed vs CPU time.
  function infoOf(b: Block, now: number){
    if (b.state === "done") {
      var end = endOf(b, now)!;
      var mins = minsBetween(b.start, end);
      var fd = Math.floor(focusedMs(b.id, b.start, end, switches) / MIN_MS);
      return clock(b.start) + "–" + clock(end) + " · " + mins + " min" +
        (fd < mins ? ", ~" + fd + " focused" : "");
    }
    if (b.state === "running") {
      var e = minsBetween(b.start, now);
      var f = Math.floor(focusedMs(b.id, b.start, Math.min(now, extentOf(b, now)), switches) / MIN_MS);
      if (e > b.plan) return clock(b.start) + "–" + clock(b.start + b.plan * MIN_MS) + " · time up, pull to continue";
      var label = "since " + clock(b.start) + " · " + e + " of " + b.plan + " min";
      var g = activeGroupOf(b);
      if (g) label += " · switching ×" + g.blocks.length + ", ~" + f + " min focused";
      else if (f < e) label += " · ~" + f + " min focused";
      return label;
    }
    return clock(b.start) + " · " + b.plan + " min";
  }

  /* ---------- hover label and right-click menu ---------- */
  var tip = document.createElement("div");
  tip.className = "st-tip";
  tip.hidden = true;
  lane.append(tip);
  function showTip(b: Block, e: MouseEvent){
    if (pull || press || move || drag || menu) { hideTip(); return; }
    var box = lane.getBoundingClientRect();
    var nm = labelNameOf(b);
    var td = todoOf(b);
    tip.textContent = (nm ? nm + " · " : "") + infoOf(b, Date.now()) + (td ? " · for “" + td.text + "”" : "");
    tip.hidden = false;
    var x = e.clientX - box.left + 14, y = e.clientY - box.top + 16;
    tip.style.left = Math.max(4, Math.min(box.width - tip.offsetWidth - 4, x)) + "px";
    tip.style.top = y + "px";
  }
  function hideTip(){ tip.hidden = true; }

  var menu: HTMLDivElement | null = null;
  // A right-click menu: newMenu() makes an empty one, showMenu() puts it at the pointer.
  function newMenu(){
    closeMenu();
    cancelPress();
    hideTip();
    var el = document.createElement("div");
    el.className = "st-menu";
    el.setAttribute("role", "menu");
    return el;
  }
  function showMenu(el: HTMLDivElement, e: MouseEvent){
    var box = lane.getBoundingClientRect();
    lane.append(el);
    el.style.left = Math.max(4, Math.min(box.width - el.offsetWidth - 4, e.clientX - box.left)) + "px";
    el.style.top = (e.clientY - box.top) + "px";
    menu = el;
    (el.firstChild as HTMLElement).focus();
  }
  function openMenu(b: Block, e: MouseEvent){
    var el = newMenu();
    var now = Date.now();
    if (b.state === "running") {
      el.append(button("Done", "", "Stop it now", function(){ closeMenu(); finish(b); }));
    }
    if (b.state === "running" && following) {   // switching is about now, so only today
      const g = activeGroupOf(b);
      if (g) el.append(button("Stop switching", "", "These run in parallel again",
        function(){ closeMenu(); endSwitch(g); }));
      if ((g ? g.blocks.length : 1) < SWITCH_MAX) {
        blocks.forEach(function(o){
          if (o === b || stateOf(o, now) !== "running" || activeGroupOf(o)) return;
          el.append(button("Switch with " + labelOf(o), "", "Mark these as switched between, not parallel",
            function(){ closeMenu(); joinSwitch(b, o); }));
        });
      }
    }
    var kin = kinOf(b);
    if (kin.length > 1 && kin.some(function(o){ return centreOf(o) !== centreOf(b); })) {
      el.append(button("Align", "", "Line up every " + labelOf(b) + " block here",
        function(){ closeMenu(); align(b); }));
    }
    // Width: how much attention it takes, in whole multiples of the narrowest block.
    var wrow = document.createElement("div");
    wrow.className = "st-menu-width";
    var wl = document.createElement("span");
    wl.textContent = "Width";
    wrow.append(wl);
    for (var n = 1; n <= SPAN_MAX; n++) (function(n){
      var cur = (b.span || 1) === n;
      var wb = button(n + "×", cur ? "on" : "", cur ? "This width" : n + " times as wide",
        function(){ closeMenu(); if (!cur) setSpan(b, n); });
      wb.setAttribute("aria-pressed", String(cur));
      wrow.append(wb);
    })(n);
    el.append(wrow);
    el.append(button("Remove", "", "Remove this block", function(){ closeMenu(); remove(b); }));
    // TODOs: what this block works on, one of the day's. The linked one is ticked; picking it
    // again unlinks it.
    var named = todos.filter(function(t){ return t.text; });
    if (named.length) {
      var tsep = document.createElement("div");
      tsep.className = "st-menu-sep";
      var head = document.createElement("div");
      head.className = "st-menu-head";
      head.textContent = "Working on";
      el.append(tsep, head);
      named.forEach(function(t){
        var cur = b.todo === t.id;
        var tb = button((cur ? "✓ " : "") + (t.text.length > 24 ? t.text.slice(0, 23) + "…" : t.text), "todo",
          cur ? "Unlink it from this TODO" : "Link it to this TODO", function(){
            closeMenu();
            linkTodo(b, cur ? null : t.id);
          });
        tb.style.setProperty("--st-c", TODO_PALETTE[t.color]);
        el.append(tb);
      });
    }
    // Labels: the block's type. Every label ever added is here to pick from; the current one is
    // ticked, and picking it again takes it off. The input at the bottom adds a new one.
    var sep = document.createElement("div");
    sep.className = "st-menu-sep";
    el.append(sep);
    // Archived labels are left out, except this block's own (ticked, so it can be taken off).
    // The × beside a label archives it: it leaves the list, blocks that wear it keep it.
    labels.slice().sort(function(a, c){ return a.name.localeCompare(c.name); }).forEach(function(l){
      var cur = b.label === l.id;
      if (l.archived && !cur) return;
      var row = document.createElement("div");
      row.className = "st-menu-label";
      row.append(button((cur ? "✓ " : "") + l.name, "label",
        cur ? "Take this label off" : "Label it " + l.name, function(){
          closeMenu();
          setLabel(b, cur ? null : l.id);
        }));
      if (!l.archived) row.append(button("×", "del", "Delete this label from the list (blocks keep it)",
        function(){ archiveLabel(l); row.remove(); }));
      el.append(row);
    });
    var ni = document.createElement("input");
    ni.className = "st-menu-new";
    ni.placeholder = labels.some(function(l){ return !l.archived; }) ? "New label…" : "Label it…";
    ni.spellcheck = false;
    ni.addEventListener("pointerdown", function(e){ e.stopPropagation(); });
    ni.addEventListener("keydown", function(e){
      e.stopPropagation();
      if (e.key === "Escape") { closeMenu(); return; }
      if (e.key !== "Enter") return;
      var l = addLabel(ni.value);
      if (!l) return;
      closeMenu();
      setLabel(b, l.id);
    });
    el.append(ni);
    showMenu(el, e);
  }
  function closeMenu(){
    if (menu) { menu.remove(); menu = null; }
  }
  // How a menu item names another block: its label, a typed name from before labels, or its time.
  function labelOf(b: Block){
    var n = labelNameOf(b) || b.task;
    if (!n) return "the " + shortClock(b.start) + " block";
    return "“" + (n.length > 16 ? n.slice(0, 15) + "…" : n) + "”";
  }
  function setLabel(b: Block, id: number | null){
    b.label = id;
    closeBubble(b);
    syncBadge(b);
    rebuildTies();
    persist();
  }
  document.addEventListener("pointerdown", function(e){
    var t = e.target as Node;
    if (menu && !menu.contains(t)) closeMenu();
    if (cal && !cal.contains(t) && !calBtn.contains(t)) closeCal();
    // the lane's press handler prevents the default, which would otherwise take focus away
    if (todoInput && t !== todoInput) todoInput.blur();
    // the bubble doesn't close on clicks elsewhere: it stays out until its "−" (or Escape)
  }, true);

  /* ---------- the speech bubbles: what a labeled block is, and a small note on it ---------- */
  // A big bubble pops out of its badge: it appears with its tail at the icon's spot (the icon
  // goes away while it's out) and stays until its "−" shrinks it back — several can be left out
  // at once, one per block. Each is one SVG, like the reference art: a rounded box with a sharp
  // tail, whose halftone shadow is the same path offset down-right and painted first, so the
  // opaque bubble covers the overlap — nothing is clipped, the tail stays sharp.
  var bubbles: Partial<Record<number, Bubble>> = {};   // the open bubbles, by block id
  var BUB_PATH = "M22 8 L158 8 Q172 8 172 22 L172 80 Q172 94 158 94 L74 94 " +
                 "L46 122 L54 94 L22 94 Q8 94 8 80 L8 22 Q8 8 22 8 Z";
  var BUB_W = 190, BUB_H = 140, TAIL_X = 46, TAIL_Y = 122;   // the tail tip, in bubble px
  function openBubble(b: Block){
    if (bubbles[b.id]) return;
    closeMenu();
    hideTip();
    var el = document.createElement("div");
    el.className = "st-bubble";
    el.innerHTML =
      '<svg viewBox="0 0 ' + BUB_W + " " + BUB_H + '" aria-hidden="true">' +
      // the halftone tile at 5 px, the same density as the blocks' shadows
      '<defs><pattern id="st-ht-' + b.id + '" width="5" height="5" patternUnits="userSpaceOnUse">' +
      '<circle cx="1.25" cy="1.25" r="1.07"/><circle cx="3.75" cy="3.75" r="1.07"/>' +
      "</pattern></defs>" +
      '<path class="shade" transform="translate(11,11)" d="' + BUB_PATH + '" fill="url(#st-ht-' + b.id + ')"/>' +
      '<path class="face" d="' + BUB_PATH + '"/>' +
      "</svg>";
    var inner = document.createElement("div");
    inner.className = "st-bub-inner";
    var head = document.createElement("div");
    head.className = "st-bub-head";
    var name = document.createElement("div");
    name.className = "st-bub-name";
    name.textContent = labelNameOf(b) || "";
    var min = button("−", "st-bub-min", "Shrink back to the icon", function(){ closeBubble(b); });
    head.append(name, min);
    var note = document.createElement("textarea");
    note.className = "st-bub-note";
    note.placeholder = "A small note…";
    note.rows = 2;
    note.spellcheck = false;
    note.value = b.note || "";
    function saveNote(){
      var v = note.value.trim();
      if (v !== b.note) { b.note = v; persist(); }
    }
    note.addEventListener("blur", saveNote);
    note.addEventListener("keydown", function(e){
      e.stopPropagation();
      if (e.key === "Escape") closeBubble(b);
    });
    inner.append(head, note);
    el.append(inner);
    lane.append(el);
    // The tail tip lands on the block's centre line, at the badge's height; the badge hides
    // while the bubble is out. The bubble opens up-right, or mirrored to up-left when there's
    // no room.
    var badge = b.el!.badge!;   // only a labeled block has a bubble
    var cx = b.el!.root.offsetLeft + b.el!.root.offsetWidth / 2;
    var cy = badge.offsetTop + badge.offsetHeight / 2;
    var left = cx - TAIL_X;
    if (left + BUB_W > lane.clientWidth + 10) {
      left = cx - (BUB_W - TAIL_X);
      el.classList.add("flip");
    }
    el.style.left = Math.max(2 - 8, left) + "px";
    el.style.top = Math.max(2, cy - TAIL_Y) + "px";
    badge.style.visibility = "hidden";
    bubbles[b.id] = { el: el, b: b, save: saveNote };
  }
  function closeBubble(b: Block){
    var k = bubbles[b.id];
    if (!k) return;
    k.save();
    k.el.remove();
    if (b.el && b.el!.badge) b.el!.badge.style.visibility = "";
    delete bubbles[b.id];
  }
  function closeAllBubbles(){
    Object.values(bubbles).forEach(function(k){ closeBubble(k!.b); });
  }

  /* ---------- getting up and going to bed ---------- */
  // At most one of each a day, kept in the day record as `wake` and `sleep` (ms). Each is a small
  // bubble just right of the axis, its tail pointing at the time, which it also shows. Right-click
  // a blank spot to put one there (or move it there, if the day has one); drag it up or down to
  // the exact minute; right-click it to take it off.
  var MARKS: Record<MarkKind, string> = { wake: "Got out of bed!", sleep: "Going to bed!" };
  var markEls: Partial<Record<MarkKind, HTMLDivElement>> = {};
  function renderMarks(){
    (Object.keys(MARKS) as MarkKind[]).forEach(function(kind){
      var el = markEls[kind];
      if (marks[kind] == null) {
        if (el) { el.remove(); delete markEls[kind]; }
        return;
      }
      if (!el) {
        el = document.createElement("div");
        el.className = "st-mark";
        el.title = "Drag to the exact time · right-click to remove";
        el.innerHTML = "<b></b><time></time>" +
          '<svg class="st-mark-tail" aria-hidden="true"><polyline points="1,-5 -11,0 1,5" /></svg>';
        el.firstChild!.textContent = MARKS[kind];
        el.addEventListener("pointerdown", function(e){ markDrag(kind, e); });
        el.addEventListener("contextmenu", function(e){
          e.preventDefault();
          var m = newMenu();
          m.append(button("Remove", "", "Take this mark off", function(){ closeMenu(); setMark(kind, null); }));
          showMenu(m, e);
        });
        lane.append(el);
        markEls[kind] = el;
      }
      placeMark(kind, marks[kind]);
    });
  }
  function placeMark(kind: MarkKind, ts: number){
    markEls[kind]!.style.top = yOf(ts) + "px";
    markEls[kind]!.querySelector("time")!.textContent = clock(ts);
  }
  // To the minute, inside the day.
  function clampMark(ts: number){
    return Math.max(dayStart, Math.min(dayEnd - MIN_MS, Math.round(ts / MIN_MS) * MIN_MS));
  }
  function setMark(kind: MarkKind, ts: number | null){
    marks[kind] = ts;
    renderMarks();
    if (ts != null && !reduceMotion.matches) markEls[kind]!.animate(
      [{ transform: "translateY(-50%) scale(.6)", opacity: .2 }, { transform: "translateY(-50%)", opacity: 1 }],
      { duration: 240, easing: "cubic-bezier(.2,.9,.3,1.35)" });
    persist();
  }
  // Drag 1:1, a minute at a time; the time inside follows. Scrolling mid-drag counts too.
  function markDrag(kind: MarkKind, e: PointerEvent){
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    hideTip();
    var el = markEls[kind]!;
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    var y0 = e.clientY, s0 = scroller.scrollTop, t0 = marks[kind]!, at = t0;
    el.classList.add("dragging");
    function mv(ev: PointerEvent){
      if (ev.pointerId !== e.pointerId) return;
      var dy = ev.clientY - y0 + (scroller.scrollTop - s0);
      at = clampMark(t0 - dy / PX * MIN_MS);   // up is later
      placeMark(kind, at);
    }
    function up(ev: PointerEvent){
      if (ev.pointerId !== e.pointerId) return;
      el.removeEventListener("pointermove", mv);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.classList.remove("dragging");
      if (ev.type === "pointercancel") at = t0;
      if (marks[kind] !== t0) return;   // the day changed under the drag
      placeMark(kind, at);
      if (at !== t0) { marks[kind] = at; persist(); }
    }
    el.addEventListener("pointermove", mv);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }
  // Right-click a blank spot: put a mark there.
  lane.addEventListener("contextmenu", function(e){
    if ((e.target as Element).closest(".st-block, .st-bub-icon, .st-bubble, .st-menu, .st-mark, .st-die, .st-todo")) return;
    e.preventDefault();
    if (pull || move || drag || storageDown) return;
    var box = lane.getBoundingClientRect();
    var at = tsAt(e.clientY - box.top), ts = clampMark(at), x = e.clientX - box.left;
    var el = newMenu();
    // only ahead of now: it's something still to do
    if (at > Date.now()) el.append(button("Add TODO", "", "Something to finish, here",
      function(){ closeMenu(); addTodo(x, ts); }));
    (Object.keys(MARKS) as MarkKind[]).forEach(function(kind){
      el.append(button(MARKS[kind], "", (marks[kind] == null ? "Mark it at " : "Move it to ") + clock(ts),
        function(){ closeMenu(); setMark(kind, ts); }));
    });
    showMenu(el, e);
  });

  /* ---------- TODOs: things to finish today, and the blocks that work on them ---------- */
  // Kept in the day record as `todos`. Each is a small speech bubble in a loud colour — the next
  // in TODO_PALETTE — whose tail's tip sits on the spot it was put, (x, at). Right-click a blank
  // spot ahead of now to add one; it opens for typing what to do, and one left empty goes away.
  // Click it to edit, click its box to tick it off, drag it anywhere, right-click it for the
  // rest. A block links to one TODO of its day (BlockRecord.todo; its label needn't match), and
  // a dashed curve in the TODO's colour runs from the block's nearest edge to the tail's tip.
  var TODO_PALETTE = [
    "255,234,0",    // highlighter yellow
    "255,46,166",   // magenta
    "0,229,255",    // cyan
    "80,255,40",    // neon green
    "255,128,0"     // orange
  ];
  var TODO_TIP = 8;   // px: the tail tip's x from the box's inner edge on the tail's side
  var todoInput: HTMLInputElement | null = null;   // the TODO being typed into
  var links: Partial<Record<number, SVGPathElement>> = {};   // the cord from a block to its TODO, by block id
  // The cords are paths on one SVG over the whole lane, under the blocks.
  var SVG_NS = "http://www.w3.org/2000/svg" as const;
  var cords = document.createElementNS(SVG_NS, "svg");
  cords.classList.add("st-cords");
  cords.setAttribute("aria-hidden", "true");
  lane.append(cords);
  function todoById(id: number){ return todos.find(function(t){ return t.id === id; }); }
  function todoOf(b: Block){ var t = b.todo == null ? undefined : todoById(b.todo); return t && t.text ? t : undefined; }
  function clampTodoX(x: number){ return Math.round(Math.max(4, Math.min(lane.clientWidth - 4, x))); }
  function nextTodoColor(){
    return todos.length ? (todos[todos.length - 1].color + 1) % TODO_PALETTE.length : 0;
  }

  function mountTodo(t: Todo){
    var el = document.createElement("div");
    el.className = "st-todo";
    el.innerHTML = '<span class="st-todo-box" title="Tick it off"></span><span class="st-todo-text"></span>' +
      '<svg class="st-todo-tail" aria-hidden="true"><polyline /></svg>';
    el.addEventListener("pointerdown", function(e){ todoDown(t, e); });
    el.addEventListener("contextmenu", function(e){ e.preventDefault(); todoMenu(t, e); });
    lane.append(el);
    t.el = el;
    dressTodo(t);
  }
  function dressTodo(t: Todo){
    var el = t.el!;
    el.style.setProperty("--st-c", TODO_PALETTE[t.color]);
    el.classList.toggle("done", t.done);
    el.querySelector(".st-todo-text")!.textContent = t.text;
    el.title = "Click to edit · drag to move · right-click for more";
    placeTodo(t);
  }
  // Put the tail's tip on (x, at): the box sits above it, to the right, or to the left (flipped)
  // near the panel's edge.
  function placeTodo(t: Todo){
    var el = t.el!;
    var flip = t.x - INK - TODO_TIP + el.offsetWidth > lane.clientWidth - 2;
    var inner = el.clientWidth;   // the padding box, inside the 2-px border
    var tip = flip ? inner - TODO_TIP : TODO_TIP;
    el.classList.toggle("flip", flip);
    el.style.left = (t.x - INK - tip) + "px";
    el.style.top = (yOf(t.at) - 9 - INK - el.clientHeight) + "px";
    // in the tail's coordinates: x from the padding box, y = 0 at the bottom border's inner edge
    el.querySelector("polyline")!.setAttribute("points",
      (tip - 5) + ",-1 " + tip + ",9 " + (tip + 5) + ",-1");
    placeLinksTo(t);
  }

  function addTodo(x: number, at: number){
    var t: Todo = { id: nextId++, x: clampTodoX(x), at: at, text: "", color: nextTodoColor(), done: false };
    todos.push(t);
    mountTodo(t);
    t.el!.style.transformOrigin = t.el!.classList.contains("flip") ? "100% 100%" : "0 100%";   // it pops out of its tail
    if (!reduceMotion.matches) t.el!.animate(
      [{ transform: "scale(.4)", opacity: .2 }, { transform: "none", opacity: 1 }],
      { duration: 260, easing: "cubic-bezier(.2,.9,.3,1.35)" });
    editTodo(t);
  }
  // Type into it in place. Enter or a click elsewhere keeps the text, Escape goes back; a TODO
  // that never got any text is taken off again. Clearing an existing one's text keeps the old.
  function editTodo(t: Todo){
    var el = t.el!;
    if (el.classList.contains("editing")) return;
    var text = el.querySelector(".st-todo-text") as HTMLElement;
    var input = document.createElement("input");
    input.className = "st-todo-input";
    input.maxLength = 80;
    input.placeholder = "What to finish?";
    input.spellcheck = false;
    input.value = t.text;
    text.hidden = true;
    el.classList.add("editing");
    text.after(input);
    todoInput = input;
    var over = false;
    function fit(){
      input.size = Math.max(14, Math.min(30, input.value.length + 1));
      placeTodo(t);
    }
    function end(keep: boolean){
      if (over) return;
      over = true;
      todoInput = null;
      var v = input.value.trim();
      input.remove();
      text.hidden = false;
      el.classList.remove("editing");
      if (keep && v && v !== t.text) {
        t.text = v;
        dressTodo(t);
        rebuildLinks();
        persist();
      } else placeTodo(t);
      if (!t.text) removeTodo(t);   // never given anything to do
    }
    input.addEventListener("input", fit);
    input.addEventListener("pointerdown", function(e){ e.stopPropagation(); });
    input.addEventListener("keydown", function(e){
      e.stopPropagation();
      if (e.key === "Enter") end(true);
      else if (e.key === "Escape") end(false);
    });
    input.addEventListener("blur", function(){ end(true); });
    fit();
    input.focus();
    input.select();
  }
  function toggleTodo(t: Todo){
    t.done = !t.done;
    dressTodo(t);
    if (t.done && !reduceMotion.matches) t.el!.animate(
      [{ transform: "rotate(-4deg) scale(1.08)" }, { transform: "none" }],
      { duration: 220, easing: "cubic-bezier(.2,.9,.3,1.35)" });
    persist();
  }
  // Blocks that worked on it are unlinked; they stay as they are.
  function removeTodo(t: Todo){
    if (todoInput && t.el!.contains(todoInput)) todoInput.blur();
    t.el!.remove();
    todos = todos.filter(function(o){ return o !== t; });
    blocks.forEach(function(b){ if (b.todo === t.id) b.todo = null; });
    rebuildLinks();
    if (t.text) persist();
  }
  function linkTodo(b: Block, id: number | null){
    b.todo = id;
    rebuildLinks();
    persist();
  }
  function todoMenu(t: Todo, e: MouseEvent){
    var m = newMenu();
    m.append(button("Edit", "", "Change what to do", function(){ closeMenu(); editTodo(t); }));
    m.append(button(t.done ? "Not done yet" : "Done", "", t.done ? "Untick it" : "Tick it off",
      function(){ closeMenu(); toggleTodo(t); }));
    m.append(button("Remove", "", "Take this TODO off (blocks linked to it are unlinked)",
      function(){ closeMenu(); removeTodo(t); }));
    showMenu(m, e);
  }
  // Press and drag to move it anywhere, 1:1, a minute at a time; a press that doesn't move is a
  // click: on its box it ticks it off, anywhere else it opens it for editing.
  function todoDown(t: Todo, e: PointerEvent){
    if (e.button !== 0 || (e.target as Element).closest("input")) return;
    e.stopPropagation();
    e.preventDefault();
    hideTip();
    var el = t.el!;
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    var x0 = e.clientX, y0 = e.clientY, s0 = scroller.scrollTop, tx0 = t.x, at0 = t.at, moved = false;
    var onBox = !!(e.target as Element).closest(".st-todo-box");
    function mv(ev: PointerEvent){
      if (ev.pointerId !== e.pointerId) return;
      var dx = ev.clientX - x0, dy = ev.clientY - y0 + (scroller.scrollTop - s0);
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      el.classList.add("dragging");
      t.x = clampTodoX(tx0 + dx);
      t.at = clampMark(at0 - dy / PX * MIN_MS);   // up is later
      placeTodo(t);
    }
    function up(ev: PointerEvent){
      if (ev.pointerId !== e.pointerId) return;
      el.removeEventListener("pointermove", mv);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.classList.remove("dragging");
      if (todos.indexOf(t) < 0) return;   // the day changed under the drag
      if (ev.type === "pointercancel") {
        t.x = tx0;
        t.at = at0;
        placeTodo(t);
        return;
      }
      if (!moved) {
        if (onBox) toggleTodo(t);
        else editTodo(t);
        return;
      }
      if (t.x !== tx0 || t.at !== at0) persist();
    }
    el.addEventListener("pointermove", mv);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  // The cords from blocks to their TODOs, kept across rebuilds like the ties.
  function rebuildLinks(){
    var keep = links;
    links = {};
    blocks.forEach(function(b){
      if (!b.el || !todoOf(b)) return;
      var el = keep[b.id];
      delete keep[b.id];
      if (!el) {
        el = document.createElementNS(SVG_NS, "path");
        cords.append(el);
      }
      links[b.id] = el;
      placeLink(b);
    });
    Object.values(keep).forEach(function(el){ el!.remove(); });
  }
  // From the point of the block nearest the tail's tip to the tip, as a curve: it leaves the
  // block square to the edge it starts on and comes up into the tail from below. The block's box
  // comes from its inline style — where it's going — like placeBadge.
  function placeLink(b: Block){
    var el = links[b.id], t = todoOf(b);
    if (!el || !t || !b.el) return;
    var r = b.el.root.style;
    var l = parseFloat(r.left), w = parseFloat(r.width), top = parseFloat(r.top), h = parseFloat(r.height);
    var tx = t.x, ty = yOf(t.at);
    var px = Math.max(l, Math.min(l + w, tx)), py = Math.max(top, Math.min(top + h, ty));
    var len = Math.hypot(tx - px, ty - py);
    var k = Math.min(60, len * 0.45);   // how far the curve keeps its starting and ending directions
    var c1x = px, c1y = py;
    if (px === l || px === l + w) c1x += (px === l ? -1 : 1) * k;   // off a side edge: sideways
    else c1y += (py === top ? -1 : 1) * k;                          // off the top or bottom: up or down
    el.style.display = len < 4 ? "none" : "";
    el.style.stroke = "rgb(" + TODO_PALETTE[t.color] + ")";
    el.setAttribute("d", "M" + px + " " + py + " C" + c1x + " " + c1y + " " + tx + " " + (ty + k) + " " + tx + " " + ty);
  }
  function placeLinksTo(t: Todo){
    blocks.forEach(function(b){ if (b.todo === t.id) placeLink(b); });
  }

  /* ---------- the calendar: open another day ---------- */
  // The icon at the top right opens a month. Days with something in them have a dot; today is
  // ringed and the day on show is filled. Any day can be opened: a past one to look back (and
  // touch up), a future one to plan — its blocks are saved under its date like any day's, so
  // they're simply there when it comes.
  var calBtn = $("st-cal-btn"), cal: HTMLDivElement | null = null, calMonth = { y: 0, m: 0 };
  calBtn.addEventListener("click", function(){ if (cal) closeCal(); else openCal(); });
  $("st-today").addEventListener("click", function(){ showDay(dayKeyAt(Date.now())); });
  function showDay(key: string){
    closeCal();
    buildDay(key);
    scrollToDay();
  }
  function openCal(){
    var p = dayKey.split("-");
    calMonth = { y: +p[0], m: +p[1] - 1 };
    cal = document.createElement("div");
    cal.className = "st-cal";
    cal.setAttribute("role", "dialog");
    cal.setAttribute("aria-label", "Pick a day");
    $("stretch").append(cal);
    calBtn.setAttribute("aria-expanded", "true");
    drawCal();
  }
  function stepMonth(d: number){
    var t = new Date(calMonth.y, calMonth.m + d, 1);
    calMonth = { y: t.getFullYear(), m: t.getMonth() };
    drawCal();
  }
  function hasDay(key: string){
    var d = saved[key];
    return !!d && ((d.blocks || []).length > 0 || (d.todos || []).length > 0 || d.wake != null || d.sleep != null);
  }
  function drawCal(){
    var today = dayKeyAt(Date.now());
    cal!.textContent = "";
    var head = document.createElement("div");
    head.className = "st-cal-head";
    var title = document.createElement("b");
    title.textContent = new Date(calMonth.y, calMonth.m, 1).toLocaleDateString(undefined,
      { month:"long", year:"numeric" });
    head.append(button("‹", "st-cal-nav", "Previous month", function(){ stepMonth(-1); }), title,
      button("›", "st-cal-nav", "Next month", function(){ stepMonth(1); }));
    var grid = document.createElement("div");
    grid.className = "st-cal-grid";
    ["S", "M", "T", "W", "T", "F", "S"].forEach(function(w){
      var s = document.createElement("span");
      s.textContent = w;
      grid.append(s);
    });
    monthCells(calMonth.y, calMonth.m).forEach(function(c){
      var p = c.key.split("-");
      var d = button(String(+p[2]), "st-cal-day",
        new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString(undefined, { weekday:"long", month:"long", day:"numeric" }),
        function(){ showDay(c.key); });
      d.classList.toggle("out", !c.inMonth);
      d.classList.toggle("today", c.key === today);
      d.classList.toggle("on", c.key === dayKey);
      d.classList.toggle("has", hasDay(c.key));
      grid.append(d);
    });
    cal!.append(head, grid);
  }
  function closeCal(){
    if (!cal) return;
    cal.remove();
    cal = null;
    calBtn.setAttribute("aria-expanded", "false");
  }

  /* ---------- storage ---------- */
  // Write the whole day: its blocks (data only) and its switching groups. Writes are queued in
  // order by the bridge, so the last one is the day as it stands.
  function persist(){
    if (storageDown) return;
    var doc: DayRecord = {
      date: dayKey,
      blocks: blocks.map(function(b){
        return { id: b.id, task: b.task, x: b.x, span: b.span, start: b.start, plan: b.plan,
                 created: b.created, end: b.end, color: b.color, label: b.label, note: b.note,
                 bubbleY: b.bubbleY, todo: b.todo };
      }),
      switches: switches.map(function(g){
        return { id: g.id, blocks: g.blocks.slice(), from: g.from, to: g.to };
      }),
      todos: todos.filter(function(t){ return t.text; }).map(function(t){
        return { id: t.id, x: t.x, at: t.at, text: t.text, color: t.color, done: t.done };
      }),
      wake: marks.wake,
      sleep: marks.sleep,
      updatedAt: Date.now()
    };
    saved[dayKey] = doc;
    window.stretch.putDay(doc).catch(function(err){ say("Not saved: " + err); });
  }

  /* ---------- labels: task types, global across days ---------- */
  // Labels live in their own record, keyed "labels" where the days are keyed by date — to Rust
  // it's one more opaque day image (it only reads `date`), replayed the same way. Blocks point
  // at labels by id, so a rename would reach every day that uses it. Deleting a label archives
  // it: it stays in the record (blocks that wear it keep their name and badge, on any day) but
  // leaves the menu's list.
  function labelById(id: number){ return labels.find(function(l){ return l.id === id; }); }
  function labelNameOf(b: Block): string | null { var l = b.label == null ? null : labelById(b.label); return l ? l.name : null; }
  function persistLabels(){
    if (storageDown) return;
    var doc: LabelsRecord = { date: "labels",
                labels: labels.map(function(l){ return { id: l.id, name: l.name, archived: l.archived }; }),
                updatedAt: Date.now() };
    window.stretch.putDay(doc).catch(function(err){ say("Not saved: " + err); });
  }
  // Add a label by name; an existing name (case-insensitively) is reused, not duplicated — an
  // archived one comes back to the list, same id.
  function addLabel(name: string){
    name = name.trim();
    if (!name) return null;
    var have = labels.find(function(l){ return l.name.toLowerCase() === name.toLowerCase(); });
    if (have) {
      if (have.archived) { have.archived = false; persistLabels(); }
      return have;
    }
    var l = { id: nextLabelId++, name: name.slice(0, 40), archived: false };
    labels.push(l);
    persistLabels();
    return l;
  }
  function archiveLabel(l: Label){
    l.archived = true;
    persistLabels();
    say("Deleted “" + l.name + "” from the list.");
  }

  /* ---------- actions ---------- */
  function say(text: string){
    var el = $("st-msg");
    el.textContent = text;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(function(){ el.textContent = ""; }, 2600);
  }

  // Press and hold anywhere on the timeline, even on a block: a ring fills under the pointer, and
  // when it's full a 30-minute block appears centred on it. Keep holding and pull it longer.
  // There's no pointer capture during the hold, so a quick double-click still reaches the block.
  lane.addEventListener("pointerdown", function(e){
    if (e.button !== 0 || pull || press || move || drag || storageDown || dieBusy()) return;
    if ((e.target as Element).closest("button, .st-handle, .st-menu, .st-bubble, .st-die, .st-mark, .st-todo")) return;
    e.preventDefault();
    hideTip();
    var box = lane.getBoundingClientRect();
    var ring = document.createElement("div");
    ring.className = "st-press";
    ring.style.left = (e.clientX - box.left) + "px";
    ring.style.top = (e.clientY - box.top) + "px";
    ring.style.animationDuration = HOLD_MS + "ms";
    ring.style.setProperty("--st-c", PALETTE[nextColor()]);   // the colour the block will be
    lane.append(ring);
    var overEl = (e.target as Element).closest(".st-block");
    press = { pointer: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
              over: overEl && blocks.find(function(b){ return b.el && b.el!.root === overEl; }),
              ring: ring, timer: setTimeout(placeBlock, HOLD_MS) };
  });

  // The colour after the most recently placed block's.
  function nextColor(){
    var last = null as Block | null;
    blocks.forEach(function(b){ if (!last || b.created > last.created) last = b; });
    return last ? (last.color + 1) % PALETTE.length : 0;
  }

  function cancelPress(){
    if (!press) return;
    clearTimeout(press.timer);
    press.ring.remove();
    press = null;
  }

  // The block (other than `b`) that a 1× block at `x` starting at `start` would sit on.
  function clashAt(x: number, start: number, now: number, b: Block | null){
    return blocks.find(function(o){
      return o !== b && spansMeet(o.x, widthOf(o), x, BLOCK_W) &&
        o.start < start + MIN_PLAN * MIN_MS && start < extentOf(o, now);
    });
  }

  function placeBlock(){
    var p = press!;
    press = null;
    p.ring.remove();
    var now = Date.now();
    var box = lane.getBoundingClientRect();
    // The press point is the block's start — its bottom edge. The die is thrown right there,
    // bounces on the start line, and the block sprouts up from it by the rolled minutes.
    var mid = tsAt(p.y - box.top);
    var start0 = snapDown(mid + SNAP / 2 * MIN_MS);   // nearest 5-minute step
    // Pressed at or after now: start no earlier than now. Holding at the now line means "start
    // this now", not "a few minutes ago".
    if (mid >= now - 2 * MIN_MS) start0 = Math.max(start0, snapDown(now));
    // The block goes where it was pressed. A press just inside a block's last few minutes
    // follows that block instead of landing on it; otherwise a taken spot nudges the new block
    // to the nearest free x.
    var x0 = clampX(p.x - box.left - BLOCK_W / 2), x = x0, start = start0;
    var clash: Block | null | undefined = clashAt(x, start, now, null);
    if (clash && clash.start < start && extentOf(clash, now) - start <= TAIL_MIN * MIN_MS) {
      start = snapUp(extentOf(clash, now));
      clash = clashAt(x, start, now, null);
    }
    for (var d = 4; clash && d < lane.clientWidth; d += 4) {
      if (clampX(x0 + d) === x0 + d && !clashAt(x0 + d, start, now, null)) { x = x0 + d; clash = null; }
      else if (clampX(x0 - d) === x0 - d && !clashAt(x0 - d, start, now, null)) { x = x0 - d; clash = null; }
    }
    if (clash) { say("No room for a block here."); return; }

    var b: Block = { id: nextId++, task: "", x: x, span: 1, start: start, plan: MIN_PLAN, created: now, end: null,
              color: nextColor(), label: null, note: "", bubbleY: null, todo: null };
    var room = roomAfter(b);
    if (room < MIN_PLAN) { say("No room for a block here."); return; }
    // Roll for the length: the die bounces on the start line, and the block appears when it
    // lands. The rolled number is clamped into the room there; shrink or stretch it after.
    var rolled = ROLL_MIN + SNAP * Math.floor(Math.random() * ((ROLL_MAX - ROLL_MIN) / SNAP + 1));
    var key = dayKey;
    rollDie(lane, x + BLOCK_W / 2, yOf(start), rolled, function(n){
      var then = Date.now();
      if (dayKey !== key) return;                                   // the view moved to another day mid-roll
      if (clashAt(b.x, b.start, then, null)) { say("No room there any more."); return; }
      b.plan = Math.max(MIN_PLAN, Math.min(n, roomAfter(b)));
      // Placed wholly behind now, it's a task logged after the fact: finished already.
      if (b.start + b.plan * MIN_MS <= then) b.end = b.start + b.plan * MIN_MS;
      blocks.push(b);
      // A block placed behind now may end one that was still going, so bring them all up to date.
      render();
      if (!reduceMotion.matches) {
        b.el!.root.animate([{ transform: "scale(.92, .6)", opacity: .2 }, { transform: "none", opacity: 1 }],
          { duration: 280, easing: "cubic-bezier(.2,.9,.3,1.35)" });
      }
      var tag = document.createElement("div");
      tag.className = "st-tag above";
      tag.textContent = "rolled " + n + (b.plan < n ? " min, " + b.plan + " fit" : " min");
      tag.style.top = (yOf(b.start) - b.plan * PX) + "px";
      tag.style.left = (b.x + 4) + "px";
      lane.append(tag);
      setTimeout(function(){ tag.remove(); }, 2000);
      persist();
    });
  }

  // Make room for blocks being put somewhere new. `fixed` maps each such block to where it's
  // going, { x, span }; it won't move again. Any block that would then sit on another
  // (overlapping in time) gives way outward, away from the centre line `c`, and lands `gap` px
  // clear — knocked a little further than it had to go — taking the blocks aligned with it (same
  // label, same centre) along so their ties hold, and pushing whatever it meets in turn. Returns
  // { pos: every moved block's new x, hits: each pushed block's { depth, dir } (1 = hit by a
  // fixed block, 2 = by one of those…) }, or null if something would have to leave the lane.
  // Nothing is changed here.
  function pushAside(fixed: Fixed, c: number, gap: number): Push | null {
    var now = Date.now(), pos = new Map(), hits = new Map();
    fixed.forEach(function(f, k){ pos.set(k, f.x); });
    function px(k: Block){ return pos.has(k) ? pos.get(k)! : k.x; }
    function wd(k: Block){ return (fixed.has(k) ? fixed.get(k)!.span : k.span || 1) * BLOCK_W; }
    function together(a: Block, k: Block){ return a.start < extentOf(k, now) && k.start < extentOf(a, now); }
    function fits(k: Block, x: number){ return clampX(x, wd(k)) === x; }
    // touching counts (within 2 px): a block that comes up against another knocks it
    function near(a: Block, k: Block){ return px(a) < px(k) + wd(k) + 2 && px(k) < px(a) + wd(a) + 2; }
    // only what this change moves or widens can knock anything; blocks already side by side stay
    function changed(k: Block){ return pos.has(k) && (pos.get(k) !== k.x || wd(k) !== widthOf(k)); }
    var ok = true;
    pos.forEach(function(x, k){ if (!fits(k, x)) ok = false; });
    for (var guard = 0; ok; guard++) {
      if (guard > 500) return null;
      // a moved block on or against another: the one further from c gives way (a fixed one never
      // does), outward, to land `gap` clear. A touch that's already that far apart isn't a hit.
      var hit = null as Hit | null | false;
      blocks.forEach(function(p){
        if (hit === false || !changed(p)) return;
        blocks.forEach(function(o){
          if (hit || hit === false || p === o || fixed.has(o) || !together(p, o) || !near(p, o)) return;
          var dp = Math.abs(centreOf(p) - c), dq = Math.abs(centreOf(o) - c);
          var h: Hit = fixed.has(p) || dq > dp || (dq === dp && p.id < o.id)
            ? { by: p, o: o, dir: 0, d: 0 } : { by: o, o: p, dir: 0, d: 0 };
          if (fixed.has(h.o)) return;
          h.dir = centreOf(h.o) < c ? -1 : 1;
          var to = h.dir < 0 ? Math.min(px(h.o), px(h.by) - wd(h.o) - gap)
                             : Math.max(px(h.o), px(h.by) + wd(h.by) + gap);
          h.d = to - px(h.o);
          if (h.d) hit = h;
          else if (spansMeet(px(p), wd(p), px(o), wd(o))) hit = false;   // on it, and outward won't clear it
        });
      });
      if (hit === false) return null;
      if (!hit) return { pos: pos, hits: hits };
      var o = hit.o, by = hit.by, dir = hit.dir, d = hit.d;
      var depth = (hits.has(by) ? hits.get(by)!.depth : 0) + 1;
      (o.label == null ? [o] : blocks.filter(function(k){
        return k.label === o.label && centreOf(k) === centreOf(o);
      })).forEach(function(k){
        if (fixed.has(k) || !fits(k, px(k) + d)) ok = false;
        pos.set(k, px(k) + d);
        if (!hits.has(k) || hits.get(k)!.depth > depth) hits.set(k, { depth: depth, dir: dir });
      });
    }
    return null;
  }

  // Change how wide a block is, keeping its centre line — so a block aligned with others stays
  // aligned — and pushing aside what's in the way. A wider block can join a queue it didn't touch
  // before, and so end (or be ended by) a block there, like dragging it would.
  function setSpan(b: Block, n: number){
    var c = centreOf(b);
    var push = shove(new Map([[b, { x: c - n * BLOCK_W / 2, span: n }]]), c);
    if (!push) { say("No room to make it " + n + "× wide here."); return; }
    b.span = n;
    applyPush(push);
  }

  // pushAside with the roomiest knock that fits: half a narrow block clear, less when it's full.
  function shove(fixed: Fixed, c: number){
    for (var i = 0; i < KNOCK.length; i++) {
      var push = pushAside(fixed, c, KNOCK[i]);
      if (push) return push;
    }
    return null;
  }
  // Move everything to where pushAside put it. A pushed block is knocked: it squashes for a beat
  // on the side it was hit from, then slides off — the slide transition's overshoot is its
  // bounce. Blocks further down a chain of pushes are hit a little later.
  function applyPush(push: Push){
    push.pos.forEach(function(x, k){ k.x = x; });
    if (!reduceMotion.matches) push.hits.forEach(function(h, k){
      if (!k.el) return;
      var delay = 50 + (h.depth - 1) * 90;
      var els = [k.el.root, k.el.shade, k.el.badge].filter(function(el){ return el != null; });
      els.forEach(function(el){ el.style.transitionDelay = delay + "ms"; });
      setTimeout(function(){
        els.forEach(function(el){ el.style.transitionDelay = ""; });
      }, delay + 450);
      if (k.el.root.animate) k.el.root.animate([
        { transform: "none", transformOrigin: h.dir < 0 ? "0 50%" : "100% 50%" },
        { transform: "scaleX(.78)", transformOrigin: h.dir < 0 ? "0 50%" : "100% 50%", offset: .35 },
        { transform: "none", transformOrigin: h.dir < 0 ? "0 50%" : "100% 50%" }
      ], { duration: 220, delay: Math.max(0, delay - 30), easing: "cubic-bezier(.2,.8,.4,1)" });
    });
    render();   // the slide transition carries the pushed blocks over
    persist();
  }

  // Done ends the block where it stands: now, or its planned end if that has already passed
  // (the block stopped growing there).
  function finish(b: Block){
    b.end = Math.min(Date.now(), b.start + b.plan * MIN_MS);
    render();
    persist();
  }
  function remove(b: Block){
    hideTip();
    closeBubble(b);
    b.el!.root.remove();
    b.el!.shade.remove();
    if (b.el!.badge) b.el!.badge.remove();
    blocks = blocks.filter(function(o){ return o !== b; });
    render();   // tick closes any switching group the block was in
    persist();
  }

  /* ---------- pulling the end edge (the top one) upwards ---------- */
  function give(over: number){ return RUBBER * (1 - 1 / (over * 0.55 / RUBBER + 1)); }
  function rubber(px: number, lo: number, hi: number){
    if (px > hi) return hi + give(px - hi);
    if (px < lo) return Math.max(4, lo - give(lo - px));
    return px;
  }

  function grabHandle(b: Block, e: PointerEvent){
    if (e.button !== 0 || pull || press || move || drag) return;
    e.preventDefault();
    e.stopPropagation();
    try { (e.target as Element).setPointerCapture(e.pointerId); } catch (_) {}
    beginPull(b, e.pointerId, e.clientX, e.clientY, false);
  }

  function beginPull(b: Block, pointer: number, x: number, y: number, created: boolean){
    b.anim = null;   // grab it even mid-bounce
    var tag = document.createElement("div");
    tag.className = "st-tag";
    var band = document.createElement("div");
    band.className = "st-band";
    band.hidden = true;
    band.style.setProperty("--st-c", PALETTE[b.color]);
    lane.append(band, tag);
    // A finished block is as long as it ran, which can be short of its plan (Done, or the next
    // block in its queue began); pulling it starts from there and moves its end.
    if (b.end != null) b.plan = minsBetween(b.start, b.end);
    var px = b.plan * PX;
    pull = { b: b, pointer: pointer, x: x, y: y, plan0: b.plan, end0: b.end, base: px,
             // where the pointer took hold, as a height above the block's start: the pull is
             // measured from here, so the block grows from the first pixel of movement
             anchor: yOf(b.start) - (y - lane.getBoundingClientRect().top),
             max: Math.max(MIN_PLAN, roomAfter(b)),
             edge: px, v: 0, want: px, last: performance.now(),
             created: created, tag: tag, band: band };
    mark(b, "pulling", true);
    requestAnimationFrame(pullFrame);
  }

  function pullFrame(t: number){
    var p = pull;
    if (!p) return;
    var b = p.b;
    var dt = Math.min(0.032, (t - p.last) / 1000);
    p.last = t;
    // Holding near the top (or bottom) of the window scrolls it, so long pulls have room.
    var box = scroller.getBoundingClientRect();
    if (p.y > box.bottom - 32) scroller.scrollTop += 6;
    else if (p.y < box.top + 32) scroller.scrollTop -= 6;

    var laneBox = lane.getBoundingClientRect();
    var base = yOf(b.start);   // the block's bottom
    var reach = base - (p.y - laneBox.top) - p.anchor;   // how far up the pointer has moved since taking hold
    // Up: each extra minute takes more pull. Down: the edge comes back 1:1.
    var want = reach >= 0 ? p.base + TENSION * Math.log(1 + reach / TENSION) : p.base + reach;
    p.want = want;
    want = rubber(want, MIN_PLAN * PX, p.max * PX);

    if (reduceMotion.matches) { p.edge = want; p.v = 0; }
    else {
      p.v += (-FOLLOW_K * (p.edge - want) - FOLLOW_C * p.v) * dt;
      p.edge += p.v * dt;
    }
    // The block narrows a little under the tension.
    var lead = reach - (p.edge - p.base);   // how far the pointer has outrun the edge
    b.inset = SQUEEZE * (1 - 1 / (Math.max(0, lead) / 90 + 1));
    layout(b, p.edge, Date.now());

    // The band from the edge to the pointer: thinner the further it's stretched.
    var gap = (base - p.edge) - (p.y - laneBox.top);
    var left = b.x;
    if (gap > 3) {
      var w = Math.max(2, 9 - gap / 25);
      p.band.hidden = false;
      p.band.style.top = (p.y - laneBox.top) + "px";
      p.band.style.height = gap + "px";
      p.band.style.width = w + "px";
      p.band.style.left = Math.min(left + widthOf(b) - 6, Math.max(left + 6, p.x - laneBox.left)) - w / 2 + "px";
    } else {
      p.band.hidden = true;
    }

    var mins = snapPlan(p.want, p.max);
    p.tag.textContent = "until " + clock(b.start + mins * MIN_MS) + " · " + mins + " min";
    p.tag.style.top = (base - p.edge) + "px";
    p.tag.style.left = (left + 4) + "px";
    requestAnimationFrame(pullFrame);
  }

  function endPull(e: PointerEvent | null, cancel: boolean){
    if (!pull || (e && e.pointerId !== pull.pointer)) return;
    var p = pull, b = p.b;
    pull = null;
    p.tag.remove();
    // the band snaps back into the edge
    if (p.band.hidden || reduceMotion.matches) p.band.remove();
    else p.band.animate([{ transform: "scaleY(1)" }, { transform: "scaleY(0)" }],
      { duration: 120, easing: "ease-in" }).onfinish = function(){ p.band.remove(); };
    mark(b, "pulling", false);
    b.inset = 0;
    b.plan = cancel ? p.plan0 : snapPlan(p.want, p.max);
    // A finished block's end moves with its top edge; pulled past now, it isn't finished after
    // all, and runs again.
    var reopened = false;
    if (p.end0 != null) {
      b.end = cancel ? p.end0 : b.start + b.plan * MIN_MS;
      if (b.end > Date.now()) { b.end = null; reopened = true; }
    }
    settle(b, p.edge, b.plan * PX, p.v);
    if (reopened) render();   // it's running now: remount it in that state
    else relayout(Date.now());   // a longer block can run alongside more of the others
    persist();              // a new block is saved once it's placed
  }

  // Spring the edge from where it was let go onto its 5-minute step, keeping its speed.
  function settle(b: Block, from: number, to: number, v0: number){
    if (reduceMotion.matches) { layout(b, null, Date.now()); return; }
    var token = {}, x = from, v = v0 || 0, last = performance.now();
    b.anim = token;
    requestAnimationFrame(function step(t){
      if (b.anim !== token) return;
      var dt = Math.min(0.032, (t - last) / 1000);
      last = t;
      v += (-SPRING_K * (x - to) - SPRING_C * v) * dt;
      x += v * dt;
      if (Math.abs(x - to) < 0.3 && Math.abs(v) < 4) { b.anim = null; layout(b, null, Date.now()); return; }
      layout(b, x, Date.now());
      requestAnimationFrame(step);
    });
  }

  /* ---------- moving the start edge (the bottom one): 1:1, no elasticity; the end stays put ---------- */
  function grabStart(b: Block, e: PointerEvent){
    if (e.button !== 0 || pull || press || move || drag) return;
    e.preventDefault();
    e.stopPropagation();
    try { (e.target as Element).setPointerCapture(e.pointerId); } catch (_) {}
    var now = Date.now(), end = b.end != null ? b.end : b.start + b.plan * MIN_MS, prev = prevBefore(b);
    var lo = prev ? extentOf(prev, now) : dayStart;
    var tag = document.createElement("div");
    tag.className = "st-tag above";
    lane.append(tag);
    move = { b: b, pointer: e.pointerId, y0: e.clientY, s0: scroller.scrollTop, start0: b.start, end: end,
             lo: b.end != null ? lo : Math.max(lo, end - MAX_PLAN * MIN_MS),   // a finished one can be any length
             hi: end - MIN_PLAN * MIN_MS, tag: tag };
    b.anim = null;
    mark(b, "pulling", true);
    moveStart(e.clientY);
  }
  function moveStart(y: number){
    var m = move!, b = m.b;
    var dy = y - m.y0 + (scroller.scrollTop - m.s0);
    var start = snapDown(m.start0 - dy / PX * MIN_MS + SNAP / 2 * MIN_MS);   // up is later
    start = Math.max(m.lo, Math.min(m.hi, start));
    b.start = start;
    b.plan = Math.round((m.end - start) / MIN_MS);
    relayout(Date.now());
    m.tag.textContent = "from " + clock(start) + " · " + b.plan + " min";
    m.tag.style.top = yOf(start) + "px";
    m.tag.style.left = (b.x + 4) + "px";
  }
  function endMove(e: PointerEvent | null){
    if (!move || (e && e.pointerId !== move.pointer)) return;
    var m = move;
    move = null;
    m.tag.remove();
    mark(m.b, "pulling", false);
    render();   // moving the start can change what's running
    persist();
  }

  /* ---------- dragging a block sideways: moving it, and what it means, is the owner's ---------- */
  // A press that moves mostly sideways while on a block becomes this drag. The block follows
  // the pointer 1:1 — x is free, so where it lands (and how close to the others) can mean
  // whatever she wants. Releasing near another block's x lines the queue up exactly; a landing
  // that would sit on a block it overlaps in time snaps home.
  function beginDrag(b: Block, pointer: number, x: number){
    try { lane.setPointerCapture(pointer); } catch (_) {}
    b.anim = null;
    drag = { b: b, pointer: pointer, x0: b.x, at: b.x,
             dx: x - b.el!.root.getBoundingClientRect().left };
    mark(b, "dragging", true);
    hideTip();
    rebuildTies();   // a block on the move is untied until it lands
    moveDrag(x);
  }
  function moveDrag(x: number){
    var d = drag!;
    d.at = clampX(x - lane.getBoundingClientRect().left - d.dx, widthOf(d.b));
    d.b.el!.root.style.left = d.at + "px";
    d.b.el!.shade.style.left = (d.at + SHADE_X) + "px";
    placeBadge(d.b);
    placeLink(d.b);
  }
  // Whether b, put at `x`, would be clear of every block it overlaps in time.
  function freeAt(x: number, b: Block){
    var now = Date.now(), ext = extentOf(b, now);
    return !blocks.some(function(o){
      return o !== b && spansMeet(o.x, widthOf(o), x, widthOf(b)) && o.start < ext && b.start < extentOf(o, now);
    });
  }
  function endDrag(e: PointerEvent | null, cancel: boolean){
    if (!drag || (e && e.pointerId !== drag.pointer)) return;
    var d = drag, b = d.b;
    drag = null;
    mark(b, "dragging", false);   // the left transition animates the snap
    var to = d.x0;
    if (!cancel) {
      // the magnet: a block whose centre line is within 10 px of the landing's
      var c = d.at + widthOf(b) / 2, near = null as Block | null;
      blocks.forEach(function(o){
        if (o !== b && Math.abs(centreOf(o) - c) < 10 &&
            (!near || Math.abs(centreOf(o) - c) < Math.abs(centreOf(near) - c))) near = o;
      });
      var onNear = near ? centreOf(near) - widthOf(b) / 2 : 0;
      if (near && clampX(onNear, widthOf(b)) !== onNear) near = null;
      var landed = (near ? [onNear, d.at] : [d.at]).find(function(x){ return freeAt(x, b); });
      // Where it lands it knocks what it's up against (or dropped on) a little way off, as
      // widening does; only if that can't fit in the lane does it snap home.
      var at = landed == null ? d.at : landed;
      var push = at !== d.x0 && shove(new Map([[b, { x: at, span: b.span || 1 }]]), at + widthOf(b) / 2);
      if (push) { applyPush(push); return; }
      if (landed == null) say("No room there.");
      else to = landed;
    }
    b.x = to;
    render();   // a new queue can end the block (one above it) or revive the one it ended
    if (to !== d.x0) persist();
  }

  window.addEventListener("pointermove", function(e){
    if (drag && e.pointerId === drag.pointer) { moveDrag(e.clientX); return; }
    if (move && e.pointerId === move.pointer) { moveStart(e.clientY); return; }
    if (press && e.pointerId === press.pointer) {
      press.x = e.clientX;
      press.y = e.clientY;
      var dx = e.clientX - press.x0, dy = e.clientY - press.y0;
      if (Math.hypot(dx, dy) > HOLD_SLOP) {
        var over = press.over, pointer = press.pointer;
        cancelPress();
        // moving mostly sideways from a press on a block drags the block to a new place
        if (over && Math.abs(dx) >= Math.abs(dy)) beginDrag(over, pointer, e.clientX);
      }
    } else if (pull && e.pointerId === pull.pointer) {
      pull.x = e.clientX;
      pull.y = e.clientY;
    }
  });
  window.addEventListener("pointerup", function(e){
    if (press && e.pointerId === press.pointer) cancelPress();   // let go too soon: nothing
    endDrag(e, false);
    endMove(e);
    endPull(e, false);
  });
  window.addEventListener("pointercancel", function(e){
    if (press && e.pointerId === press.pointer) cancelPress();
    endDrag(e, true);
    endMove(e);
    endPull(e, true);
  });
  window.addEventListener("keydown", function(e){
    if (e.key !== "Escape") return;
    closeMenu();
    closeCal();
    closeAllBubbles();
    cancelPress();
    cancelRoll();   // no block then
    if (drag) endDrag(null, true);
    if (pull) endPull(null, true);
  });
  window.addEventListener("resize", function(){ relayout(Date.now()); });

  /* ---------- clock ---------- */
  function tick(){
    var now = Date.now();
    if (dayKeyAt(now) !== dayKey) {
      if (following) { buildDay(); return; }
    } else following = true;   // the future day being shown has come
    $("st-today").hidden = following;
    // On another day, now is off the timeline: a past day is all gone, a future one all ahead.
    nowLine.hidden = now < dayStart || now >= dayEnd;
    nowLine.style.top = yOf(now) + "px";
    past.style.top = Math.max(0, Math.min(yOf(dayStart), yOf(now))) + "px";
    nowLine.firstChild!.textContent = shortClock(now);
    var ended = false;
    blocks.forEach(function(b){
      if ((pull && pull.b === b) || (move && move.b === b) || (drag && drag.b === b)) return;
      // A block that ended because the next one in its queue began: record when, so the log
      // keeps the outcome rather than re-deriving it later.
      if (b.end == null && b.start <= now && endOf(b, now) != null) { b.end = endOf(b, now); ended = true; }
      if (stateOf(b, now) !== b.state) remount(b);       // its time came, or the next one began
    });
    // A switching group needs all its members still running: when one ends (or is removed), the
    // group is closed — an outcome, logged — and the rest, if still two or more, go on as a new
    // group from here, like processes sharing a core after one of them exits.
    switches.forEach(function(g){
      if (g.to != null) return;
      var live = g.blocks.filter(function(id){
        var o = byId(id);
        return o && stateOf(o, now) === "running";
      });
      if (live.length === g.blocks.length) return;
      g.to = now;
      if (live.length >= 2) switches.push({ id: nextId++, blocks: live, from: now, to: null });
      ended = true;
    });
    relayout(now);
    if (ended) persist();
  }
  setInterval(tick, 5000);
  document.addEventListener("stretch:visibility", tick);

  /* ---------- start ---------- */
  // Show the day with now two thirds of the way down and the rest of the day above it.
  function start(){
    buildDay();
    scrollToDay();
  }
  // Today opens at now; another day at its first block or mark, or else at 8 am, two thirds
  // of the way down.
  function scrollToDay(){
    var at: number | null = Date.now();
    if (!following) {
      at = null as number | null;
      blocks.forEach(function(b){ if (at == null || b.start < at) at = b.start; });
      if (marks.wake != null && (at == null || marks.wake < at)) at = marks.wake;
      if (at == null) at = dayStart + (8 * 60 - (4 * 60 + 30)) * MIN_MS;
    }
    scroller.scrollTop = yOf(at) - scroller.clientHeight * 0.67;
  }
  window.stretch.load().then(function(days){
    var all = days || {};
    var stored = all.labels as StoredLabels | undefined;
    delete all.labels;
    saved = all as Partial<Record<string, StoredDay>>;
    labels = ((stored || {}).labels || []).map(function(l){ return { id: l.id!, name: String(l.name), archived: !!l.archived }; });
    labels.forEach(function(l){ nextLabelId = Math.max(nextLabelId, l.id + 1); });
    start();
  }, function(err){
    storageDown = String(err);
    start();
    $("st-msg").textContent = "Storage unavailable: " + storageDown;
  });
})();
