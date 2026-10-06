// The logical day. A day runs 4:30 am to 4:30 am, so late-night work counts toward the day
// before. Pure functions, shared by the page and the tests (test/).

export var DAY_START_MIN = 4 * 60 + 30;   // 4:30 am, in minutes after midnight

function pad(n){ return n < 10 ? "0" + n : "" + n; }
function keyOf(d){ return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }

// "YYYY-MM-DD" of the day the time `ts` belongs to.
export function dayKeyAt(ts){
  var d = new Date(ts);
  if (d.getHours() * 60 + d.getMinutes() < DAY_START_MIN) d.setDate(d.getDate() - 1);
  return keyOf(d);
}

// When the day `key` begins (4:30 am on that date) and ends (4:30 am the next date), in ms.
export function dayBounds(key){
  var p = key.split("-");
  var start = new Date(+p[0], +p[1] - 1, +p[2], 0, DAY_START_MIN);
  var end = new Date(+p[0], +p[1] - 1, +p[2] + 1, 0, DAY_START_MIN);
  return { start: start.getTime(), end: end.getTime() };
}
