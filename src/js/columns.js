// Pure: how blocks share the width of the lane. Shared with the tests.
//
// Blocks that overlap in time, directly or through a chain of others, form a cluster. A cluster
// gets one column per track present in it, sized by the tracks' width weights. Each block sits in
// its track's column and then widens into neighbouring columns that nothing else uses for its
// whole span (calendar-style), so a block running beside one other block shares the width with
// just that one.
//
// Widening claims the column for that span. Two blocks on either side of a free column can't
// both take it: whichever comes first (earlier start, then further left) gets it.

// items: [{ track, s, e }] with s < e (ms); tracks: [{ id, w }] in left-to-right order;
// inner: the lane's width minus its padding. Returns the clusters, and sets on each item
// lo/hi (the first and last column it spans) and col { left, width }.
export function arrange(items, tracks, inner, padL, gutter){
  items = items.slice().sort(function(x, y){ return x.s - y.s; });
  var clusters = [], cur = null;
  items.forEach(function(it){
    if (cur && it.s < cur.to) { cur.items.push(it); cur.to = Math.max(cur.to, it.e); }
    else { cur = { from: it.s, to: it.e, items: [it] }; clusters.push(cur); }
  });
  clusters.forEach(function(c){
    var present = tracks.filter(function(t){ return c.items.some(function(it){ return it.track === t.id; }); });
    var total = present.reduce(function(s, t){ return s + t.w; }, 0) || 1;
    var acc = 0;
    c.cols = present.map(function(t, i){
      var x0 = padL + inner * acc / total;
      acc += t.w;
      var x1 = padL + inner * acc / total;
      var gl = i > 0 ? gutter / 2 : 0, gr = i < present.length - 1 ? gutter / 2 : 0;
      return { track: t, x0: x0, x1: x1, left: x0 + gl, width: x1 - x0 - gl - gr };
    });
    // claims[j]: the spans column j is taken for, by its own blocks and by blocks widened into it
    var claims = c.cols.map(function(){ return []; });
    c.items.forEach(function(it){
      it.lo = it.hi = c.cols.findIndex(function(k){ return k.track.id === it.track; });
      claims[it.lo].push(it);
    });
    function free(j, it){
      return !claims[j].some(function(o){ return o.s < it.e && it.s < o.e; });
    }
    c.items.slice().sort(function(x, y){ return x.s - y.s || x.lo - y.lo; }).forEach(function(it){
      while (it.lo > 0 && free(it.lo - 1, it)) claims[--it.lo].push(it);
      while (it.hi < c.cols.length - 1 && free(it.hi + 1, it)) claims[++it.hi].push(it);
      var a = c.cols[it.lo], z = c.cols[it.hi];
      it.col = { left: a.left, width: z.left + z.width - a.left };
    });
  });
  return clusters;
}
