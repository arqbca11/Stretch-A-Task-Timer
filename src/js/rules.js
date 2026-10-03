// Pure rules shared by the page (src/js/app.js) and the tests (test/). No DOM, no storage.
// Moved verbatim from reference/switch-card.html; functions that read `state.days` there take
// the day as an argument here.

export var MIN = 30, MAX = 100;
export var AUTO_LOG_MS = 3 * 60 * 60 * 1000;   // unfinished blocks auto-log at 3h
export var DAY_START_H = 8, DAY_START_M = 30;  // idle before the first block counts from 8:30
// A "day" runs 4:30 am to 4:30 am: anything before 4:30 belongs to the night before.
export var ROLL_MIN = 4 * 60 + 30;

// Pieces earned for a logged block. Tune the weights here.
export var REWARD = {
  PER_MIN: 1 / 30,   // length: +1 piece per 30 min actually worked
  OVER_W: 2,         // overrun: +2 per 100% over plan, counted up to OVER_CAP
  OVER_CAP: 0.5,     //   i.e. at most +1, reached at 50% over
  EXCESS_W: 1,       // way over: -1 per 100% beyond OVER_CAP
  EARLY_AT: 0.5,     // stopped early: penalty starts below 50% of plan
  EARLY_W: 1,        //   scaling to -1 at 0 min
  MORNING_W: 3,      // early start: +3 for blocks started by 7:00 am,
  MORNING_FULL: 7 * 60,   //   fading linearly to 0 at 10:00 pm;
  MORNING_ZERO: 22 * 60,  //   late-night blocks (before 4:30 am) get 0
  SCALE: 2,          // everything above is doubled, so the best possible block
                     //   (3 h, 50% over plan, started by 7 am) earns exactly MAX
  MIN: 1, MAX: 20    // every logged block earns between 1 and 20 pieces
};

/* ---------- dates ---------- */
export function pad(n){ return n < 10 ? "0" + n : "" + n; }
export function keyOf(d){ return d.getFullYear() + "-" + pad(d.getMonth()+1) + "-" + pad(d.getDate()); }
export function minuteOfDay(d){ return d.getHours() * 60 + d.getMinutes(); }
export function dayKeyAt(ts){
  var d = new Date(ts);
  if (minuteOfDay(d) < ROLL_MIN) d.setDate(d.getDate() - 1);
  return keyOf(d);
}
// a clock time on day `key`, where times before 4:30 fall after midnight
export function tsOn(key, value){
  var p = key.split("-"), t = value.split(":");
  var h = +t[0], m = +t[1];
  var d = new Date(+p[0], +p[1]-1, +p[2], h, m);
  if (h * 60 + m < ROLL_MIN) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function clone(v){ return v == null ? v : JSON.parse(JSON.stringify(v)); }

/* ---------- entries ---------- */
export function endOf(e){
  if (e.endedAt) return e.endedAt;
  if (e.startedAt && e.worked != null) return e.startedAt + e.worked * 60000;
  return null;
}
export function latestEnd(day){
  var best = null;
  day.entries.forEach(function(e){ var end = endOf(e); if (end && (best == null || end > best)) best = end; });
  return best;
}

// Idle gap to log before a block starting at `now` on day `key` (whose record is `day`, or
// undefined): from the latest end time in the day, or from 8:30 if the day is empty.
export function idleBefore(day, key, now){
  var from = null;
  if (!day || !day.entries.length){
    var p = key.split("-");
    var dayStart = new Date(+p[0], +p[1]-1, +p[2], DAY_START_H, DAY_START_M).getTime();
    if (now <= dayStart) return null;
    from = dayStart;
  } else {
    day.entries.forEach(function(e){
      var end = endOf(e);
      if (end && (from == null || end > from)) from = end;
    });
    if (from == null) return null;
  }
  var mins = Math.floor((now - from) / 60000);
  if (mins < 1) return null;
  return {
    id: "idle" + String(now) + Math.random().toString(36).slice(2,6),
    type: "idle",
    task: "idle",
    planned: null,
    startedAt: from,
    endedAt: now,
    worked: mins
  };
}

// remove the span [s, e] from any idle rows it overlaps (trim, split, or drop)
export function carveIdle(day, s, e){
  var out = [];
  day.entries.forEach(function(x){
    if (x.type !== "idle" || x.endedAt <= s || x.startedAt >= e){ out.push(x); return; }
    var pieces = [];
    if (x.startedAt < s) pieces.push([x.startedAt, s]);
    if (x.endedAt > e) pieces.push([e, x.endedAt]);
    pieces.forEach(function(pc, i){
      var mins = Math.floor((pc[1] - pc[0]) / 60000);
      if (mins < 1) return;
      var y = clone(x);
      if (i > 0) y.id = x.id + "b";
      y.startedAt = pc[0]; y.endedAt = pc[1]; y.worked = mins;
      out.push(y);
    });
  });
  day.entries = out;
}

/* ---------- rewards ---------- */
export function startMinute(ts){
  var m = minuteOfDay(new Date(ts));
  return m < ROLL_MIN ? m + 1440 : m;
}
export function rewardFor(e){
  var W = e.worked, P = e.planned, parts = [];
  if (W == null) return { n: REWARD.MIN, parts: parts };
  parts.push(["length", W * REWARD.PER_MIN]);
  if (P){   // plan-relative terms only apply to rolled blocks
    var ratio = W / P;
    var over = Math.max(0, ratio - 1);
    if (over > 0){
      parts.push(["overrun", REWARD.OVER_W * Math.min(over, REWARD.OVER_CAP)]);
      if (over > REWARD.OVER_CAP) parts.push(["way over", -REWARD.EXCESS_W * (over - REWARD.OVER_CAP)]);
    }
    if (ratio < REWARD.EARLY_AT) parts.push(["stopped early", -REWARD.EARLY_W * (REWARD.EARLY_AT - ratio) / REWARD.EARLY_AT]);
  }
  if (e.startedAt){
    var sm = startMinute(e.startedAt);
    var f = (REWARD.MORNING_ZERO - sm) / (REWARD.MORNING_ZERO - REWARD.MORNING_FULL);
    f = Math.max(0, Math.min(1, f));
    if (f > 0) parts.push(["early start", REWARD.MORNING_W * f]);
  }
  parts = parts.map(function(x){ return [x[0], x[1] * REWARD.SCALE]; });
  var raw = parts.reduce(function(sum, x){ return sum + x[1]; }, 0);
  return { n: Math.max(REWARD.MIN, Math.min(REWARD.MAX, Math.round(raw))), parts: parts };
}
export function describeReward(rw){
  return rw.parts.map(function(x){
    return x[0] + " " + (x[1] >= 0 ? "+" : "−") + Math.abs(x[1]).toFixed(1);
  }).join(", ");
}
