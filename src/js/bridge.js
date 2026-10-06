// The page's only connection to the app: storage goes to Rust, panel visibility comes back.
(function () {
  "use strict";
  var invoke = window.__TAURI__.core.invoke;
  var listen = window.__TAURI__.event.listen;

  // Writes are whole-day images, so their order is the history: if two puts for a day were
  // reordered in flight, the older image would win. Chain them so each starts after the last
  // one is durable, and serialize the image now, not when it's sent.
  var queue = Promise.resolve();
  function write(cmd, args) {
    var p = queue.then(function () { return invoke(cmd, args); });
    queue = p.catch(function () {});
    return p;
  }
  function snapshot(v) { return JSON.parse(JSON.stringify(v)); }

  window.stretch = {
    load: function () { return invoke("load"); },                 // -> { "YYYY-MM-DD": day }
    putDay: function (day) { return write("put_day", { day: snapshot(day) }); },   // -> seq
    panelVisible: false                                            // the panel starts hidden
  };

  // Hidden panels don't reliably fire visibilitychange in WKWebView; Rust says when it hides.
  listen("panel-visibility", function (ev) {
    window.stretch.panelVisible = !!ev.payload;
    document.dispatchEvent(new CustomEvent("stretch:visibility", { detail: !!ev.payload }));
  });
})();
