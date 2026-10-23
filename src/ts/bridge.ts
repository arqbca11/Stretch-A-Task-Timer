// The page's only connection to the app: storage goes to Rust, panel visibility comes back.

import type { StoredDays, StretchRecord } from "./types.ts";

// The slice of Tauri's global API (app.withGlobalTauri) the bridge uses.
declare global {
  interface Window {
    __TAURI__: {
      core: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> };
      event: { listen<T>(event: string, handler: (ev: { payload: T }) => void): Promise<() => void> };
    };
  }
}

var invoke = window.__TAURI__.core.invoke;
var listen = window.__TAURI__.event.listen;

// Writes are whole-day images, so their order is the history: if two puts for a day were
// reordered in flight, the older image would win. Chain them so each starts after the last
// one is durable, and serialize the image now, not when it's sent.
var queue: Promise<unknown> = Promise.resolve();
function write<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  var p = queue.then(function () { return invoke<T>(cmd, args); });
  queue = p.catch(function () {});
  return p;
}
function snapshot<T>(v: T): T { return JSON.parse(JSON.stringify(v)); }

window.stretch = {
  load: function () { return invoke<StoredDays>("load"); },                               // -> { "YYYY-MM-DD": day }
  putDay: function (day: StretchRecord) { return write<number>("put_day", { day: snapshot(day) }); },   // -> seq
  panelVisible: false                                                                      // the panel starts hidden
};

// Hidden panels don't reliably fire visibilitychange in WKWebView; Rust says when it hides.
listen<boolean>("panel-visibility", function (ev) {
  window.stretch.panelVisible = !!ev.payload;
  document.dispatchEvent(new CustomEvent("stretch:visibility", { detail: !!ev.payload }));
});
