# Stretch — desktop

A macOS menu bar app: a day timeline where you press and hold to place a task block, pull it up
like a rubber band to set how long it runs, and run blocks in parallel columns. Time runs
upwards. Bundle identifier `com.ruoqi.stretch`; the page's bridge is `window.stretch`.

Read before changing things:
- `docs/interaction.md` — the interaction design: decisions, history of each round of feedback,
  the block/track model, tunables, open questions. Read it before changing the timeline.
- `docs/storage.md` — the storage design: record format, write path, recovery, checkpoint,
  crash windows, invariants. Read it before changing `store.rs` or what the page writes.

## Stack and decisions

- **Tauri 2**, Rust backend. Frontend is plain HTML/JS served as-is from `src/` (no framework, no
  bundler): `build.frontendDist: "../src"`, `app.withGlobalTauri: true`, so the page uses
  `window.__TAURI__.core.invoke` and `window.__TAURI__.event.listen` directly.
- Target macOS on Apple Silicon (`aarch64-apple-darwin`). The page runs in WKWebView (WebKit/JSC),
  not Chromium: check pointer events, `Element.animate` and timing behave the same.
- **Menu-bar-only app**: `ActivationPolicy::Accessory` in `setup` and `LSUIElement` in
  `Info.plist`, so there's no Dock icon.
- Plugins: `tauri-plugin-positioner` (feature `tray-icon`) to anchor the panel under the icon,
  `tauri-plugin-autostart` for launch at login. Grant their permissions in
  `src-tauri/capabilities/default.json`, and nothing else.
- **No database dependency.** Storage is an append-only log plus snapshots. Don't add SQLite,
  sled, `tauri-plugin-store`, `tauri-plugin-sql`, or a hosted backend without asking.
  `serde_json` is fine.
- **Offline**: Karla is served from `src/fonts/` via `src/css/fonts.css`.
- Strict CSP in `tauri.conf.json` (`app.security.csp`): self only, plus `data:` for images and
  Tauri's IPC origin.

## Layout

```
src/                     frontend, served as-is
  index.html             the panel: header + timeline (axis, lane, now dot)
  js/stretch.js          the whole UI: timeline, press-and-hold, elastic pull, tracks, colours,
                         hover label, right-click menu, persistence
  js/day.js              pure: dayKeyAt, dayBounds (4:30 am day boundary); shared with tests
  js/bridge.js           window.stretch = { load, putDay, panelVisible } over invoke; ordered
                         write queue; forwards "panel-visibility" as the "stretch:visibility" event
  css/stretch.css        all styles; tokens on :root with dark mode
  css/fonts.css, fonts/  Karla 400/500/700
src-tauri/
  src/lib.rs             builder, plugins, setup (opens the store), window events
  src/store.rs           log + snapshot storage, recovery, checkpoint (unit-tested)
  src/commands.rs        #[tauri::command] load, put_day
  src/tray.rs            tray icon, menu (Open, Launch at login, Quit), panel toggling
  capabilities/default.json
  icons/                 trayTemplate.png/@2x (monochrome template) + app icons
  tauri.conf.json
scripts/draw-icons.swift draws the tray and app icons (CoreGraphics); regenerate commands inside
test/                    node --test suites for src/js/day.js
docs/                    interaction.md, storage.md
legacy/                  gitignored, local only: the archived Roll app (see Legacy)
```

## Menu bar and panel

- The icon is a template image (`icon_as_template(true)`), so it follows light/dark menu bars.
  It shows no title.
- Left click (`TrayIconEvent::Click`, left, `Up`) toggles the panel. Tray events go to
  `tauri_plugin_positioner::on_tray_event`, then `move_window(Position::TrayCenter)` before
  showing. A 300 ms guard stops the click that blurred the panel from reopening it.
- Panel window (`label: "panel"`): 420×760, `visible: false`, `decorations: false`,
  `resizable: false`, `alwaysOnTop: true`, `skipTaskbar: true`. Hide on
  `WindowEvent::Focused(false)`, and hide instead of closing so the page stays alive.
- Right click: `Open`, `Launch at login` (check item), `Quit`.
- Rust emits `panel-visibility` (true/false) on show/hide, because hidden WKWebViews don't
  reliably fire `visibilitychange`; the page re-ticks on it.

## The page

Look and interaction are documented in `docs/interaction.md`; keep it current when they change
(add a round to "How it got here" and update "Current behaviour"). Key points:

- Time runs upwards: `yOf(ts) = (dayEnd - ts) / 1 min × PX`. A block's start is its bottom edge
  and its end its top edge; the top edge is elastic, the bottom edge rigid.
- State is derived from time and blocks (`ahead` / `running` / `done`); only Done sets `end`
  directly, and `tick` freezes an end once the next block in the track has begun, then persists.
- The logical day is 4:30 am to 4:30 am (`day.js`); `tick` rebuilds the view when it rolls over.

## Storage

Data directory: `app_data_dir()` = `~/Library/Application Support/com.ruoqi.stretch/`.

```
stretch.log          append-only, one JSON record per line: {"day":{..},"op":"day.put","seq":N,"ts":..}
stretch.snapshot     last checkpoint: { "seq": N, "days": { "YYYY-MM-DD": {...} } }
stretch.log.<seq>    the two most recent rotated segments
```

The full design is in `docs/storage.md`. The rules that must hold:

- **Records are whole-day images** (physical logging). The page calls `persist()` after every
  completed change with the full day; Rust logs it as `day.put`. Replay is
  `days[date] = day`, idempotent, last write wins. Don't switch to logical ops without a concrete
  reason.
- **Rust treats days as opaque JSON** (`serde_json::Value`) and reads only `date`. The schema
  lives in the page.
- **Append, then sync**: one `write_all` of line + `\n`, then `sync_all()` (`F_FULLFSYNC` on
  macOS; plain `fsync` stops at the drive's cache). Acknowledge only after that. Sync the
  directory after creating or renaming any file (new log, new data dir via its parent,
  checkpoint rename/rotation). A failed append is truncated back; if that fails too, the store
  is poisoned until restart.
- **Recovery**: snapshot, then replay records with `seq > snapshot.seq`. A torn final line
  (unterminated or unparsable) is truncated; a bad line anywhere else, or an unknown op, is
  corruption: stop, leave the file untouched, surface the error. Never silently drop history.
- **Checkpoint** at 1 MB or 2,000 records: `.tmp` + `sync_all` + `rename` + directory sync, then
  rotate the log; keep two segments.
- **Log outcomes, not inputs.** Records store what the app decided at the time (e.g. a block's
  frozen `end`). Replay never re-derives.
- **One writer, one copy of the truth.** The store sits behind a `Mutex` in managed state and
  only `commands.rs` calls it. The bridge serializes writes in order. The page renders what
  `load()` returns and has no cache: don't add `localStorage` (or any second store) that can be
  written back. (The web predecessor lost data when a stale cache won a last-writer-wins merge.)

## Legacy: the Roll app

Stretch began as a port of a "roll a number, work that many minutes" web app (die, block timer,
Tetris rewards). That app is archived in **`legacy/roll/`**, which is gitignored and exists only
on Ruoqi's machine. It's a full snapshot of the repo at commit `535774d` plus the personal seed
export; `legacy/roll/README.md` maps it, including line ranges for the die.

- **Reuse it** when asked for Roll-era features, e.g. "a rolling die appears when the user holds
  for a new block": the ray-traced die and its roll/bounce/settle physics are in
  `legacy/roll/src/js/app.js` (die section) with styles in `legacy/roll/src/css/app.css`. Port
  the renderer verbatim; don't restyle the die or change its physics without asking. Other
  reusable pieces: the tray title ticker and notification (`legacy/roll/src-tauri/src/tray.rs`),
  `rewardFor` (`legacy/roll/src/js/rules.js`), the Tetris game.
- **Never commit anything from `legacy/`.** `legacy/roll/reference/seed-export.json` and
  `legacy/roll/src-tauri/resources/seed-export.json` are Ruoqi's real history. If Roll code is
  reused, copy the code into `src/`, not the data.
- `legacy/roll/CLAUDE.roll.md` is the old instructions file; it describes the Roll app, not this
  one.
- The Roll history itself stays in `~/Library/Application Support/com.ruoqi.switchcard/`
  (`days.log`, `days.snapshot`, `game.json`). Stretch doesn't read or write it.

## Commands

Prerequisites: Rust via rustup, Xcode Command Line Tools, Node (for the Tauri CLI and JS tests).

```
npm install                    # @tauri-apps/cli
npm run tauri dev
npm test                       # node --test test/
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build -- --target aarch64-apple-darwin
# → src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Stretch.app (+ dmg/)
```

The app is unsigned for personal use. First launch: right-click the app → Open, or
`xattr -dr com.apple.quarantine "Stretch.app"`.

## Tests that must exist

- `store.rs`: append + reload; a torn final line is truncated and recovery succeeds; a final line
  without its newline is torn; a corrupt middle line fails loudly and leaves the file untouched;
  an unknown op is corruption; checkpoint + rotation, then replay from the snapshot gives
  identical state; a crash between snapshot rename and rotation; `seq` continues across restarts;
  opening in a data directory that doesn't exist yet.
  Use a temp dir per test.
- `dayKeyAt`: 4:29 am belongs to the previous day, 4:30 and 4:31 am to the same day;
  `dayBounds` spans 4:30 am to 4:30 am across a month end.

## Working with Ruoqi

- She's a software engineer with a database internals background. Explain storage and systems
  choices precisely, and skip basics.
- Show changes by running the app, not just by describing them. Ask before changing anything that
  alters how the app looks or how rewards are computed.
