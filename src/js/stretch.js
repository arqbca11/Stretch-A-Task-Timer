// Stretch mode (prototype). A whole-day timeline: press and hold to place a block, pull its bottom
// edge to change when it ends. A block starts at the time it was placed: behind now it's already
// going, ahead of now it begins by itself when the time comes. Its spent part turns solid as time
// passes.
//
// Multitasking: press and hold anywhere, even on a block, and if that time is taken the new block
// goes in a new track beside it. Each track is a column with a width weight. Where blocks run in
// parallel the panel splits by those weights (drag the line between two to change the split);
// where a block runs alone it takes the full width.
//
// Blocks live in memory only for now: nothing is written to the day log, nothing reaches the
// tray, and no rewards apply. Roll mode is untouched.
import { dayKeyAt } from "./rules.js";

(function(){
  "use strict";

  /* ---------- tunables (minutes; the timeline is drawn at PX px per minute) ---------- */
  var PX = 1.6;                     // 24 h is about 2,300 px
  var SNAP = 5;                     // starts and ends land on 5-minute steps
  var DEFAULT_PLAN = 30;            // a new block appears at 30 minutes
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
  var MIN_COL = 44;                 // px: the narrowest a parallel column can be dragged
  var PAD_L = 12, PAD_R = 8, GUTTER = 4;   // px: lane padding and the gap between parallel columns

  var MIN_MS = 60000;
  // Blocks: { id, task, track, start, plan (min), created, end }, times in ms; `end` is set only
  // by Done. Tracks: { id, w }, in left-to-right order; `w` is a width weight.
  var blocks = [], tracks = [];
  var clusters = [];  // groups of blocks that overlap in time, from the last arrange()
  var dayKey = null, dayStart = 0, dayEnd = 0;
  var pull = null;   // the bottom edge being pulled
  var press = null;  // a press that becomes a block if it's held
  var move = null;   // the top edge being moved
  var split = null;  // the line between two parallel columns being dragged
  var nextId = 1;
  var msgTimer = null;

  function $(id){ return document.getElementById(id); }
  var scroller = $("st-scroll"), day = $("st-day"), lane = $("st-lane"), axis = $("st-axis");
  var nowLine = $("st-now");
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* ---------- time <-> position ---------- */
  function startOfDay(key){
    var p = key.split("-");
    return new Date(+p[0], +p[1]-1, +p[2], 4, 30).getTime();
  }
  function yOf(ts){ return (ts - dayStart) / MIN_MS * PX; }
  function tsAt(y){ return dayStart + y / PX * MIN_MS; }
  function snapDown(ts){ var m = SNAP * MIN_MS; return dayStart + Math.floor((ts - dayStart) / m) * m; }
  function snapUp(ts){ var m = SNAP * MIN_MS; return dayStart + Math.ceil((ts - dayStart) / m) * m; }
  function clock(ts){ return new Date(ts).toLocaleTimeString(undefined, { hour:"numeric", minute:"2-digit" }); }
  function shortClock(ts){ var d = new Date(ts); return (d.getHours() % 12 || 12) + ":" + String(d.getMinutes()).padStart(2, "0"); }
  function hourLabel(h){ return (h % 12 || 12) + (h < 12 ? " am" : " pm"); }
  function minsBetween(a, b){ return Math.floor((b - a) / MIN_MS); }

  /* ---------- blocks (each track is its own sequence) ---------- */
  function trackOf(id){ return tracks.find(function(t){ return t.id === id; }); }
  function nextAfter(b){
    var n = null;
    blocks.forEach(function(o){
      if (o !== b && o.track === b.track && o.start > b.start && (!n || o.start < n.start)) n = o;
    });
    return n;
  }
  function prevBefore(b){
    var p = null;
    blocks.forEach(function(o){
      if (o !== b && o.track === b.track && o.start < b.start && (!p || o.start > p.start)) p = o;
    });
    return p;
  }
  // When a block stops. Done sets it outright. Otherwise a block keeps going (past its plan, if
  // need be) until the next block in its track begins. A block placed after that one had already
  // begun is filled in afterwards, so it covers its plan and no more. Blocks in other tracks run
  // in parallel and never end it.
  function endOf(b, now){
    if (b.end != null) return b.end;
    var n = nextAfter(b);
    if (n && n.start <= now) {
      return b.created <= n.start ? n.start : Math.min(b.start + b.plan * MIN_MS, n.start);
    }
    return null;
  }
  function stateOf(b, now){
    if (b.start > now) return "ahead";
    return endOf(b, now) == null ? "running" : "done";
  }
  // Where the block's area on the timeline ends.
  function extentOf(b, now){
    var e = endOf(b, now);
    if (e != null) return e;
    var planEnd = b.start + b.plan * MIN_MS;
    return b.start <= now ? Math.max(planEnd, now) : planEnd;
  }
  // The longest plan that fits before the next block in its track (or the end of the day).
  function roomAfter(b){
    var n = nextAfter(b);
    return Math.min(MAX_PLAN, minsBetween(b.start, n ? n.start : dayEnd));
  }
  function snapPlan(px, max){
    var m = Math.round(px / PX / SNAP) * SNAP;
    return Math.max(MIN_PLAN, Math.min(max, m));
  }
  function pruneTracks(){
    tracks = tracks.filter(function(t){ return blocks.some(function(b){ return b.track === t.id; }); });
  }

  /* ---------- side by side ---------- */
  // Group blocks that overlap in time. Within a group, each track present gets a column whose
  // width is its weight's share among the tracks present; a block alone gets the full width.
  function arrange(now){
    var items = blocks.map(function(b){ return { b: b, s: b.start, e: extentOf(b, now) }; })
      .sort(function(x, y){ return x.s - y.s; });
    clusters = [];
    var cur = null;
    items.forEach(function(it){
      if (cur && it.s < cur.to) { cur.items.push(it); cur.to = Math.max(cur.to, it.e); }
      else { cur = { from: it.s, to: it.e, items: [it] }; clusters.push(cur); }
    });
    var inner = Math.max(0, lane.clientWidth - PAD_L - PAD_R);
    clusters.forEach(function(c){
      var present = tracks.filter(function(t){ return c.items.some(function(it){ return it.b.track === t.id; }); });
      var total = present.reduce(function(s, t){ return s + t.w; }, 0) || 1;
      var acc = 0;
      c.cols = present.map(function(t, i){
        var x0 = PAD_L + inner * acc / total;
        acc += t.w;
        var x1 = PAD_L + inner * acc / total;
        var gl = i > 0 ? GUTTER / 2 : 0, gr = i < present.length - 1 ? GUTTER / 2 : 0;
        return { track: t, x0: x0, x1: x1, left: x0 + gl, width: x1 - x0 - gl - gr };
      });
      c.items.forEach(function(it){
        var col = c.cols.find(function(k){ return k.track.id === it.b.track; });
        it.b.col = { left: col.left, width: col.width };
      });
    });
  }

  // Lay everything out again: columns, then every block not mid-gesture, then the split lines.
  function relayout(now){
    arrange(now);
    blocks.forEach(function(b){
      if (!b.el || b.anim || (pull && pull.b === b)) return;
      layout(b, null, now);
    });
    drawSplits();
  }

  // The lines between parallel columns, as tall as the group: drag one to change the split.
  function drawSplits(){
    lane.querySelectorAll(".st-split").forEach(function(el){ el.remove(); });
    clusters.forEach(function(c){
      for (var i = 0; i < c.cols.length - 1; i++) {
        var el = document.createElement("div");
        el.className = "st-split";
        el.title = "Drag to change the split";
        el.style.top = yOf(c.from) + "px";
        el.style.height = (yOf(c.to) - yOf(c.from)) + "px";
        el.style.left = (c.cols[i].x1 - 5) + "px";
        el.addEventListener("pointerdown", grabSplit.bind(null, c.cols[i], c.cols[i + 1]));
        lane.append(el);
      }
    });
  }

  /* ---------- the day ---------- */
  function buildDay(){
    dayKey = dayKeyAt(Date.now());
    dayStart = startOfDay(dayKey);
    var next = new Date(dayStart); next.setDate(next.getDate() + 1);
    dayEnd = next.getTime();
    day.style.height = yOf(dayEnd) + "px";
    $("st-date").textContent = new Date(dayStart).toLocaleDateString(undefined,
      { weekday:"long", month:"long", day:"numeric" });

    axis.textContent = "";
    for (var t = dayStart + 30 * MIN_MS; t < dayEnd; t += 60 * MIN_MS) {
      var label = document.createElement("span");
      label.textContent = hourLabel(new Date(t).getHours());
      label.style.top = yOf(t) + "px";
      axis.appendChild(label);
    }
    // A new day starts with an empty timeline.
    blocks.forEach(function(b){ if (b.el && (b.start < dayStart || b.start >= dayEnd)) b.el.root.remove(); });
    blocks = blocks.filter(function(b){ return b.start >= dayStart && b.start < dayEnd; });
    pruneTracks();
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

  function button(label, cls, title, fn){
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    if (cls) b.className = cls;
    b.addEventListener("click", fn);
    return b;
  }

  function mount(b){
    var now = Date.now();
    b.state = stateOf(b, now);
    var root = document.createElement("div");
    root.className = "st-block " + b.state + (b.state === "ahead" ? "" : " started");
    var fill = document.createElement("div"); fill.className = "st-fill";
    var body = document.createElement("div"); body.className = "st-body";
    var name = document.createElement("input");
    name.className = "st-name";
    name.placeholder = "Name the task";
    name.spellcheck = false;
    name.value = b.task;
    name.readOnly = true;
    name.classList.toggle("blank", !b.task);
    name.addEventListener("input", function(){ b.task = name.value; });
    name.addEventListener("keydown", function(e){ if (e.key === "Enter" || e.key === "Escape") name.blur(); });
    name.addEventListener("blur", function(){
      b.task = name.value.trim();
      name.value = b.task;
      name.readOnly = true;
      name.classList.toggle("blank", !b.task);
    });
    body.append(name);
    root.append(fill, body);
    // Hover shows when it starts and how long it is, beside the pointer; right-click for actions.
    root.addEventListener("pointermove", function(e){ showTip(b, e); });
    root.addEventListener("pointerleave", hideTip);
    root.addEventListener("contextmenu", function(e){ e.preventDefault(); openMenu(b, e); });
    // Double-click a block to name it.
    root.addEventListener("dblclick", function(e){
      if (e.target.closest("button")) return;
      name.readOnly = false;
      name.classList.remove("blank");
      name.focus();
      name.select();
    });
    var handle = null;
    if (b.state !== "done") {
      handle = document.createElement("div");
      handle.className = "st-handle";
      handle.title = "Pull to change when it ends";
      handle.addEventListener("pointerdown", function(e){ grabHandle(b, e); });
      var topEdge = document.createElement("div");
      topEdge.className = "st-handle top";
      topEdge.title = "Drag to change when it starts";
      topEdge.addEventListener("pointerdown", function(e){ grabTop(b, e); });
      root.append(handle, topEdge);
    }
    b.el = { root: root, fill: fill, name: name, handle: handle };
    lane.append(root);
    if (b.col) layout(b, null, now);
  }

  function remount(b){
    var editing = document.activeElement === b.el.name;
    b.el.root.remove();
    mount(b);
    if (editing) { b.el.name.readOnly = false; b.el.name.classList.remove("blank"); b.el.name.focus(); }
  }

  // Position a block. `planPx` overrides the plan's length while it's being pulled or settling.
  function layout(b, planPx, now){
    var r = b.el;
    if (planPx == null) planPx = b.plan * PX;
    var height, solid;
    if (b.state === "done") {
      height = solid = Math.max(3, (endOf(b, now) - b.start) / MIN_MS * PX);
    } else if (b.state === "running") {
      solid = Math.max(0, (now - b.start) / MIN_MS * PX);
      height = Math.max(planPx, solid);   // past its plan, the block grows by itself
    } else {
      height = planPx;
      solid = 0;
    }
    var col = b.col || { left: PAD_L, width: lane.clientWidth - PAD_L - PAD_R };
    var inset = Math.min(b.inset || 0, col.width * 0.15);   // squeezed while it's being pulled
    r.root.style.top = yOf(b.start) + "px";
    r.root.style.height = height + "px";
    r.root.style.left = (col.left + inset) + "px";
    r.root.style.width = Math.max(8, col.width - 2 * inset) + "px";
    r.fill.style.height = solid + "px";
    if (r.handle) r.handle.style.top = planPx + "px";

  }

  // What the hover label says about a block.
  function infoOf(b, now){
    if (b.state === "done") {
      var end = endOf(b, now);
      return clock(b.start) + "–" + clock(end) + " · " + minsBetween(b.start, end) + " min";
    }
    if (b.state === "running") {
      var e = minsBetween(b.start, now);
      return "since " + clock(b.start) + " · " +
        (e > b.plan ? e + " min, " + (e - b.plan) + " over" : e + " of " + b.plan + " min");
    }
    return clock(b.start) + " · " + b.plan + " min";
  }

  /* ---------- hover label and right-click menu ---------- */
  var tip = document.createElement("div");
  tip.className = "st-tip";
  tip.hidden = true;
  lane.append(tip);
  function showTip(b, e){
    if (pull || press || move || split || menu) { hideTip(); return; }
    var box = lane.getBoundingClientRect();
    tip.textContent = infoOf(b, Date.now());
    tip.hidden = false;
    var x = e.clientX - box.left + 14, y = e.clientY - box.top + 16;
    tip.style.left = Math.max(4, Math.min(box.width - tip.offsetWidth - 4, x)) + "px";
    tip.style.top = y + "px";
  }
  function hideTip(){ tip.hidden = true; }

  var menu = null;
  function openMenu(b, e){
    closeMenu();
    cancelPress();
    hideTip();
    var box = lane.getBoundingClientRect();
    var el = document.createElement("div");
    el.className = "st-menu";
    el.setAttribute("role", "menu");
    if (b.state === "running") el.append(button("Done", "", "Stop it now", function(){ closeMenu(); finish(b); }));
    el.append(button("Remove", "", "Remove this block", function(){ closeMenu(); remove(b); }));
    lane.append(el);
    el.style.left = Math.max(4, Math.min(box.width - el.offsetWidth - 4, e.clientX - box.left)) + "px";
    el.style.top = (e.clientY - box.top) + "px";
    menu = el;
    el.firstChild.focus();
  }
  function closeMenu(){
    if (menu) { menu.remove(); menu = null; }
  }
  document.addEventListener("pointerdown", function(e){
    if (menu && !menu.contains(e.target)) closeMenu();
  }, true);

  /* ---------- actions ---------- */
  function say(text){
    var el = $("st-msg");
    el.textContent = text;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(function(){ el.textContent = ""; }, 2600);
  }

  // Press and hold anywhere on the timeline, even on a block: a ring fills under the pointer, and
  // when it's full a 30-minute block appears centred on it. Keep holding and pull it longer.
  // There's no pointer capture during the hold, so a quick double-click still reaches the block.
  lane.addEventListener("pointerdown", function(e){
    if (e.button !== 0 || pull || press || move || split) return;
    if (e.target.closest("button, .st-handle, .st-split, .st-menu")) return;
    if (e.target.matches(".st-name:not([readonly])")) return;
    e.preventDefault();
    hideTip();
    var box = lane.getBoundingClientRect();
    var ring = document.createElement("div");
    ring.className = "st-press";
    ring.style.left = (e.clientX - box.left) + "px";
    ring.style.top = (e.clientY - box.top) + "px";
    ring.style.animationDuration = HOLD_MS + "ms";
    lane.append(ring);
    press = { pointer: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
              ring: ring, timer: setTimeout(placeBlock, HOLD_MS) };
  });

  function cancelPress(){
    if (!press) return;
    clearTimeout(press.timer);
    press.ring.remove();
    press = null;
  }

  // Where a new block starting at `start` can go in track `t`, or null if that time is taken.
  // A press just inside a block's last few minutes follows that block instead of going beside it.
  function fitIn(t, start, now){
    var s = start;
    for (var pass = 0; pass < 2; pass++) {
      var clash = blocks.find(function(o){
        return o.track === t.id && o.start < s + MIN_PLAN * MIN_MS && s < extentOf(o, now);
      });
      if (!clash) return s;
      var end = extentOf(clash, now);
      if (pass > 0 || clash.start >= s || end - s > TAIL_MIN * MIN_MS) return null;
      s = snapUp(end);
    }
    return null;
  }

  // A new track takes 1 / (n + 1) of the width it shares with the n tracks already running
  // there; they keep their proportions to each other.
  function newTrack(start, end){
    var shared = [];
    clusters.forEach(function(c){
      if (c.from < end && start < c.to) c.cols.forEach(function(k){
        if (shared.indexOf(k.track) < 0) shared.push(k.track);
      });
    });
    var sum = shared.reduce(function(s, t){ return s + t.w; }, 0);
    var t = { id: nextId++, w: shared.length ? sum / shared.length : 1 };
    tracks.push(t);
    return t;
  }

  function placeBlock(){
    var p = press;
    press = null;
    p.ring.remove();
    var now = Date.now();
    var box = lane.getBoundingClientRect();
    // The block appears centred on the pointer, so you're holding its middle.
    var mid = tsAt(p.y - box.top);
    var start0 = snapDown(mid - DEFAULT_PLAN / 2 * MIN_MS + SNAP / 2 * MIN_MS);   // nearest 5-minute step
    // Pressed at or after now: start no earlier than now. Holding at the now line means "start
    // this now", not "a quarter of an hour ago".
    if (mid >= now - 2 * MIN_MS) start0 = Math.max(start0, snapDown(now));
    // Try the column under the pointer first, then the other tracks from the left; if that time is
    // taken in all of them, start a new track beside them.
    arrange(now);
    var order = tracks.slice(), x = p.x - box.left;
    var here = clusters.find(function(c){ return c.from <= mid && mid < c.to; });
    var under = here && here.cols.find(function(k){ return x >= k.x0 && x < k.x1; });
    if (under) order = [under.track].concat(order.filter(function(t){ return t !== under.track; }));
    var track = null, start = start0;
    for (var i = 0; i < order.length && !track; i++) {
      var s = fitIn(order[i], start0, now);
      if (s != null) { track = order[i]; start = s; }
    }
    if (!track) track = newTrack(start0, start0 + DEFAULT_PLAN * MIN_MS);

    var b = { id: nextId++, task: "", track: track.id, start: start, plan: DEFAULT_PLAN, created: now, end: null };
    var room = roomAfter(b);
    if (room < MIN_PLAN) { pruneTracks(); say("No room for a block here."); return; }
    b.plan = Math.min(DEFAULT_PLAN, room);
    blocks.push(b);
    // A block placed behind now may end one that was still going, so bring them all up to date.
    render();
    b.el.root.classList.add("fresh");   // the name field waits until the block is placed
    if (!reduceMotion.matches) {
      b.el.root.animate([{ transform: "scale(.92, .6)", opacity: .2 }, { transform: "none", opacity: 1 }],
        { duration: 280, easing: "cubic-bezier(.2,.9,.3,1.35)" });
    }
    try { lane.setPointerCapture(p.pointer); } catch (_) {}
    beginPull(b, p.pointer, p.x, p.y, true);
  }

  function finish(b){
    b.end = Date.now();
    render();
  }
  function remove(b){
    hideTip();
    b.el.root.remove();
    blocks = blocks.filter(function(o){ return o !== b; });
    pruneTracks();
    render();
  }

  /* ---------- pulling the bottom edge ---------- */
  function give(over){ return RUBBER * (1 - 1 / (over * 0.55 / RUBBER + 1)); }
  function rubber(px, lo, hi){
    if (px > hi) return hi + give(px - hi);
    if (px < lo) return Math.max(4, lo - give(lo - px));
    return px;
  }

  function grabHandle(b, e){
    if (e.button !== 0 || pull || press || move || split) return;
    e.preventDefault();
    e.stopPropagation();
    try { e.target.setPointerCapture(e.pointerId); } catch (_) {}
    beginPull(b, e.pointerId, e.clientX, e.clientY, false);
  }

  function beginPull(b, pointer, x, y, created){
    b.anim = null;   // grab it even mid-bounce
    var tag = document.createElement("div");
    tag.className = "st-tag";
    var band = document.createElement("div");
    band.className = "st-band";
    band.hidden = true;
    lane.append(band, tag);
    var px = b.plan * PX;
    pull = { b: b, pointer: pointer, x: x, y: y, plan0: b.plan, base: px,
             // where the pointer took hold, relative to the block's top: the pull is measured
             // from here, so the block grows from the first pixel of movement
             anchor: y - lane.getBoundingClientRect().top - yOf(b.start),
             max: Math.max(MIN_PLAN, roomAfter(b)),
             edge: px, v: 0, want: px, last: performance.now(),
             created: created, tag: tag, band: band };
    b.el.root.classList.add("pulling");
    requestAnimationFrame(pullFrame);
  }

  function pullFrame(t){
    var p = pull;
    if (!p) return;
    var b = p.b;
    var dt = Math.min(0.032, (t - p.last) / 1000);
    p.last = t;
    // Holding near the bottom (or top) of the window scrolls it, so long pulls have room.
    var box = scroller.getBoundingClientRect();
    if (p.y > box.bottom - 32) scroller.scrollTop += 6;
    else if (p.y < box.top + 32) scroller.scrollTop -= 6;

    var laneBox = lane.getBoundingClientRect();
    var top = yOf(b.start);
    var reach = p.y - laneBox.top - top - p.anchor;   // how far the pointer has moved since taking hold
    // Down: each extra minute takes more pull. Up: the edge comes back 1:1.
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
    var gap = p.y - laneBox.top - top - p.edge;
    var col = b.col;
    if (gap > 3) {
      var w = Math.max(2, 9 - gap / 25);
      p.band.hidden = false;
      p.band.style.top = (top + p.edge) + "px";
      p.band.style.height = gap + "px";
      p.band.style.width = w + "px";
      p.band.style.left = Math.min(col.left + col.width - 6, Math.max(col.left + 6, p.x - laneBox.left)) - w / 2 + "px";
    } else {
      p.band.hidden = true;
    }

    var mins = snapPlan(p.want, p.max);
    p.tag.textContent = "until " + clock(b.start + mins * MIN_MS) + " · " + mins + " min";
    p.tag.style.top = (top + p.edge) + "px";
    p.tag.style.left = (col.left + 4) + "px";
    requestAnimationFrame(pullFrame);
  }

  function endPull(e, cancel){
    if (!pull || (e && e.pointerId !== pull.pointer)) return;
    var p = pull, b = p.b;
    pull = null;
    p.tag.remove();
    // the band snaps back into the edge
    if (p.band.hidden || reduceMotion.matches) p.band.remove();
    else p.band.animate([{ transform: "scaleY(1)" }, { transform: "scaleY(0)" }],
      { duration: 120, easing: "ease-in" }).onfinish = function(){ p.band.remove(); };
    b.el.root.classList.remove("pulling", "fresh");
    b.inset = 0;
    b.plan = cancel ? p.plan0 : snapPlan(p.want, p.max);
    settle(b, p.edge, b.plan * PX, p.v);
    relayout(Date.now());   // a longer block can run alongside more of the others
  }

  // Spring the edge from where it was let go onto its 5-minute step, keeping its speed.
  function settle(b, from, to, v0){
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

  /* ---------- moving the top edge: 1:1, no elasticity; the end stays put ---------- */
  function grabTop(b, e){
    if (e.button !== 0 || pull || press || move || split) return;
    e.preventDefault();
    e.stopPropagation();
    try { e.target.setPointerCapture(e.pointerId); } catch (_) {}
    var now = Date.now(), end = b.start + b.plan * MIN_MS, prev = prevBefore(b);
    var tag = document.createElement("div");
    tag.className = "st-tag above";
    lane.append(tag);
    move = { b: b, pointer: e.pointerId, y0: e.clientY, s0: scroller.scrollTop, start0: b.start, end: end,
             lo: Math.max(prev ? extentOf(prev, now) : dayStart, end - MAX_PLAN * MIN_MS),
             hi: end - MIN_PLAN * MIN_MS, tag: tag };
    b.anim = null;
    b.el.root.classList.add("pulling");
    moveTop(e.clientY);
  }
  function moveTop(y){
    var m = move, b = m.b;
    var dy = y - m.y0 + (scroller.scrollTop - m.s0);
    var start = snapDown(m.start0 + dy / PX * MIN_MS + SNAP / 2 * MIN_MS);
    start = Math.max(m.lo, Math.min(m.hi, start));
    b.start = start;
    b.plan = Math.round((m.end - start) / MIN_MS);
    relayout(Date.now());
    m.tag.textContent = "from " + clock(start) + " · " + b.plan + " min";
    m.tag.style.top = yOf(start) + "px";
    m.tag.style.left = (b.col.left + 4) + "px";
  }
  function endMove(e){
    if (!move || (e && e.pointerId !== move.pointer)) return;
    var m = move;
    move = null;
    m.tag.remove();
    m.b.el.root.classList.remove("pulling");
    render();   // moving the start can change what's running
  }

  /* ---------- dragging the line between two parallel columns ---------- */
  function grabSplit(left, right, e){
    if (e.button !== 0 || pull || press || move || split) return;
    e.preventDefault();
    e.stopPropagation();
    split = { pointer: e.pointerId, a: left.track, b: right.track,
              x0: left.x0, x1: right.x1, sum: left.track.w + right.track.w };
    lane.classList.add("splitting");   // no width transitions while dragging
  }
  function moveSplit(x){
    var s = split, span = s.x1 - s.x0;
    var f = (x - lane.getBoundingClientRect().left - s.x0) / span;
    var lo = Math.min(0.5, MIN_COL / span);
    f = Math.max(lo, Math.min(1 - lo, f));
    s.a.w = s.sum * f;
    s.b.w = s.sum - s.a.w;
    relayout(Date.now());
  }
  function endSplit(e){
    if (!split || (e && e.pointerId !== split.pointer)) return;
    split = null;
    lane.classList.remove("splitting");
  }

  window.addEventListener("pointermove", function(e){
    if (split && e.pointerId === split.pointer) { moveSplit(e.clientX); return; }
    if (move && e.pointerId === move.pointer) { moveTop(e.clientY); return; }
    if (press && e.pointerId === press.pointer) {
      press.x = e.clientX;
      press.y = e.clientY;
      if (Math.hypot(e.clientX - press.x0, e.clientY - press.y0) > HOLD_SLOP) cancelPress();
    } else if (pull && e.pointerId === pull.pointer) {
      pull.x = e.clientX;
      pull.y = e.clientY;
    }
  });
  window.addEventListener("pointerup", function(e){
    if (press && e.pointerId === press.pointer) cancelPress();   // let go too soon: nothing
    endSplit(e);
    endMove(e);
    endPull(e, false);
  });
  window.addEventListener("pointercancel", function(e){
    if (press && e.pointerId === press.pointer) cancelPress();
    endSplit(e);
    endMove(e);
    endPull(e, true);
  });
  window.addEventListener("keydown", function(e){
    if (e.key !== "Escape") return;
    closeMenu();
    cancelPress();
    if (pull) endPull(null, true);
  });
  window.addEventListener("resize", function(){ relayout(Date.now()); });

  /* ---------- clock ---------- */
  function tick(){
    var now = Date.now();
    if (dayKeyAt(now) !== dayKey) { buildDay(); return; }
    nowLine.style.top = yOf(now) + "px";
    nowLine.firstChild.textContent = shortClock(now);
    blocks.forEach(function(b){
      if ((pull && pull.b === b) || (move && move.b === b)) return;
      if (stateOf(b, now) !== b.state) remount(b);       // its time came, or the next one began
    });
    relayout(now);   // running blocks grow, which can bring them alongside others
  }
  setInterval(tick, 5000);
  document.addEventListener("switchcard:visibility", tick);

  /* ---------- mode switch (from the tray menu) ---------- */
  function setMode(mode){
    var stretch = mode === "stretch";
    if (stretch === document.body.classList.contains("mode-stretch")) return;
    document.body.classList.toggle("mode-stretch", stretch);
    $("stretch").hidden = !stretch;
    if (stretch) {
      tick();
      scroller.scrollTop = yOf(Date.now()) - scroller.clientHeight * 0.3;   // now, a third of the way down
    }
  }
  window.switchcard.onMode(setMode);

  buildDay();
})();
