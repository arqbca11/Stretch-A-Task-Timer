// The logical day. A day runs 4:30 am to 4:30 am, so late-night work counts toward the day
// before. Pure functions, shared by the page and the tests (test/).

export const DAY_START_MIN = 4 * 60 + 30;   // 4:30 am, in minutes after midnight

function pad(n: number): string { return n < 10 ? "0" + n : "" + n; }
function keyOf(d: Date): string { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }

// "YYYY-MM-DD" of the day the time `ts` belongs to.
export function dayKeyAt(ts: number): string {
  var d = new Date(ts);
  if (d.getHours() * 60 + d.getMinutes() < DAY_START_MIN) d.setDate(d.getDate() - 1);
  return keyOf(d);
}

// When the day `key` begins (4:30 am on that date) and ends (4:30 am the next date), in ms.
export function dayBounds(key: string): { start: number; end: number } {
  var p = key.split("-");
  var start = new Date(+p[0], +p[1] - 1, +p[2], 0, DAY_START_MIN);
  var end = new Date(+p[0], +p[1] - 1, +p[2] + 1, 0, DAY_START_MIN);
  return { start: start.getTime(), end: end.getTime() };
}

// The calendar's page for a month (`month` 0–11): six weeks of "YYYY-MM-DD" keys, Sunday first,
// starting on the Sunday on or before the 1st. Each is { key, inMonth }.
export function monthCells(year: number, month: number): { key: string; inMonth: boolean }[] {
  var first = new Date(year, month, 1);
  var cells: { key: string; inMonth: boolean }[] = [];
  for (var i = 0; i < 42; i++) {
    var d = new Date(year, month, 1 - first.getDay() + i);
    cells.push({ key: keyOf(d), inMonth: d.getMonth() === month });
  }
  return cells;
}
