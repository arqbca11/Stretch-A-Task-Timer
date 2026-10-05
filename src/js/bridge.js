// The page's only connection to the app: storage and status go to Rust, tray actions come back.
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

  window.switchcard = {
    load: function () { return invoke("load"); },                 // -> { days, game }
    putDay: function (day) { return write("put_day", { day: snapshot(day) }); },
    putGame: function (game) { return write("put_game", { game: snapshot(game) }); },
    status: function (s) { return write("status", { status: s }); },   // ordered, like writes
    panelVisible: false                                            // the panel starts hidden
  };

  // Rust emits "done" | "keepGoing" | "roll"; the page registers handlers for them.
  var handlers = {};
  window.switchcard.onTrayAction = function (map) { handlers = map || {}; };
  listen("tray-action", function (ev) {
    var fn = handlers[ev.payload];
    if (typeof fn === "function") fn();
  });

  // The tray menu switches the panel between Roll and Stretch mode.
  window.switchcard.onMode = function (fn) {
    listen("set-mode", function (ev) { fn(ev.payload); });
  };

  // Hidden panels don't reliably fire visibilitychange in WKWebView; Rust says when it hides.
  listen("panel-visibility", function (ev) {
    window.switchcard.panelVisible = !!ev.payload;
    document.dispatchEvent(new CustomEvent("switchcard:visibility", { detail: !!ev.payload }));
  });
})();
