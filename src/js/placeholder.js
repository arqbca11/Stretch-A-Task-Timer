(function () {
  var out = document.getElementById("out");
  window.switchcard.load().then(function (r) {
    var keys = Object.keys(r.days).sort();
    out.textContent = keys.length + " days loaded\n" + keys.map(function (k) {
      return k + "  " + r.days[k].entries.length + " entries";
    }).join("\n") + "\n\ngame total: " + (r.game ? r.game.total : "none");
  }, function (e) { out.textContent = "storage error: " + e; });
})();
