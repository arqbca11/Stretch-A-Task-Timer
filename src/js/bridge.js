// The page's only connection to the app: storage and status go to Rust, tray actions come back.
(function () {
  "use strict";
  var invoke = window.__TAURI__.core.invoke;
  var listen = window.__TAURI__.event.listen;

  window.switchcard = {
    load: function () { return invoke("load"); },                 // -> { days, game }
    putDay: function (day) { return invoke("put_day", { day: day }); },
    putGame: function (game) { return invoke("put_game", { game: game }); },
    status: function (s) { return invoke("status", { status: s }); }
  };

  // Rust emits "done" | "keepGoing" | "roll"; the page registers handlers for them.
  var handlers = {};
  window.switchcard.onTrayAction = function (map) { handlers = map || {}; };
  listen("tray-action", function (ev) {
    var fn = handlers[ev.payload];
    if (typeof fn === "function") fn();
  });

  // Hidden panels don't reliably fire visibilitychange in WKWebView; Rust says when it hides.
  window.switchcard.panelVisible = true;
  listen("panel-visibility", function (ev) {
    window.switchcard.panelVisible = !!ev.payload;
    document.dispatchEvent(new CustomEvent("switchcard:visibility", { detail: !!ev.payload }));
  });
})();
