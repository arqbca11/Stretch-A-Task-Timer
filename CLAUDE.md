# Stretch — desktop

The app is named **Stretch** (it was "Switch Card"; stretching interactions come later). The
bundle identifier stays `com.ruoqi.switchcard` so the data directory doesn't move, and the
internal bridge keeps the name `window.switchcard`. Don't rename either.

A macOS menu bar app for Ruoqi's "roll a number, work that many minutes" method. It is a port of a
working web version (`reference/switch-card.html`) into a Tauri shell, with a menu bar item and
local, log-based storage. The web version is the source of truth for behavior and look: port it,
don't redesign it.

## What exists already

- `reference/switch-card.html` — the complete web app, one self-contained file (~1,850 lines):
  ray-traced dice roll, block timer, day log with proportional bars, idle tracking, manual logging,
  Tetris rewards. Copied from the published claude.ai artifact (version 37).
- `reference/seed-export.json` — the user's real history and Tetris state as of 2026-10-02, exported
  from the web version's database. Imported once on first launch (see Migration).

Read the reference file before changing behavior. Its comments explain most decisions.

## Stack and decisions

- **Tauri 2**, Rust backend. Frontend is plain HTML/JS served as-is from `src/` (no framework, no
  bundler): `build.frontendDist: "../src"`, `app.withGlobalTauri: true`, so the page uses
  `window.__TAURI__.core.invoke` and `window.__TAURI__.event.listen` directly.
- Target macOS on Apple Silicon (`aarch64-apple-darwin`). The page runs in WKWebView (WebKit/JSC),
  not Chromium: check canvas, `Element.animate` and timing behave the same as in the reference.
- **Menu-bar-only app**: `app.set_activation_policy(ActivationPolicy::Accessory)` in `setup`, so
  there's no Dock icon.
- Plugins: `tauri-plugin-positioner` (feature `tray-icon`) to anchor the panel under the icon,
  `tauri-plugin-notification`, `tauri-plugin-autostart` for launch at login. Grant their permissions
  in `src-tauri/capabilities/default.json`, and nothing else.
- **No database dependency.** Storage is an append-only log plus snapshots (below). Don't add
  SQLite, sled, `tauri-plugin-store`, `tauri-plugin-sql`, or a hosted backend without asking.
  `serde` / `serde_json` are fine.
- **Offline**: put the fonts (Karla, Bricolage Grotesque, woff2) in `src/fonts/` with `@font-face`,
  instead of loading Google Fonts.
- Set a strict CSP in `tauri.conf.json` (`app.security.csp`): self only, plus `data:` for images.

## Layout

```
src/                       frontend, served as-is
  index.html               the ported page (starts as a copy of reference/switch-card.html)
  js/bridge.js             defines window.switchcard = { load, putDay, putGame, status, stretchLoad,
                           stretchPutDay } over invoke,
                           and forwards "tray-action" events to the page
  js/rules.js              pure functions shared with tests: rewardFor, dayKeyAt, idleBefore, carveIdle
  js/stretch.js            Stretch mode (prototype): day timeline, elastic blocks, parallel tracks
  css/stretch.css
  fonts/
src-tauri/
  src/lib.rs               builder, plugins, setup, commands registration
  src/tray.rs              tray icon, title ticker, context menu, notification
  src/store.rs             log + snapshot storage, recovery, checkpoint (unit-tested)
  src/commands.rs          #[tauri::command] load, put_day, put_game, status
  capabilities/default.json
  icons/trayTemplate.png, trayTemplate@2x.png   (monochrome template image) + app icons
  resources/seed-export.json                    (copied from reference/, bundled as a resource)
  tauri.conf.json
test/                      node --test suites for src/js/rules.js
reference/                 read-only inputs, never edited
```

## Menu bar item

- Idle: just the icon (a small die, `icon_as_template(true)` so it follows light/dark menu bars).
- Block running: icon + title `Leetcode · 23/75` (task, elapsed minutes, planned minutes) via
  `TrayIcon::set_title`. Truncate the task name to ~18 characters. Past the plan: `Leetcode · +8`
  (minutes over). The title is plain text, so "over" is shown by the text change, not by colour.
- **Rust owns the title.** Keep the running status in managed state (`Mutex<Status>`) and run a
  ticker on `tauri::async_runtime` every 15 s that recomputes elapsed minutes from wall-clock time and
  calls `set_title` only when the text changes. It never depends on the webview being awake: WebKit
  throttles timers in hidden windows, and the Mac may sleep mid-block, so the next tick after wake
  corrects itself. Also update immediately when `status` is called.
- Left click (`TrayIconEvent::Click`, left button, `MouseButtonState::Up`): toggle the panel window.
  Pass tray events to `tauri_plugin_positioner::on_tray_event`, then
  `move_window(Position::TrayCenter)` before showing. Hide on `WindowEvent::Focused(false)`.
- Panel window (`label: "panel"`): ~420×760, `visible: false`, `decorations: false`,
  `resizable: false`, `alwaysOnTop: true`, `skipTaskbar: true`. Hide instead of closing, so the page
  (timer, Tetris) stays alive.
- Right click: menu with `Done, log it`, `Keep going`, `Roll a number` (shows the panel and starts
  the roll), `Roll mode` / `Stretch mode` (check items; switch the panel, emitted as `set-mode`),
  `Open`, `Launch at login` (check item), `Quit`. Rebuild or enable/disable items when the
  status changes so only valid actions are active.
- When a running block reaches its planned minutes, the ticker sends one notification
  (`"Leetcode: 75 minutes up"`). Once per block (track the block id).

The page owns the app logic. It reports status whenever it changes:
`window.switchcard.status({ running, id, task, startedAt, planned })` → command `status`.
Tray menu actions go the other way: Rust emits `tray-action` with `done | keepGoing | roll`, and
`bridge.js` calls the page's existing `finish()`, `keepGoing()`, `roll()`.

## Stretch mode (prototype)

A second panel mode, switched from the tray menu: press and hold on a day timeline (time runs
upwards) to place a block, pull it up to stretch it, and run blocks in parallel columns. It has its own black/white
palette, with each new block in the next of nine bright colours, scoped to `body.mode-stretch`; Roll mode's look is unchanged. Its blocks are saved in
their own log (`stretch.log`, below), not the day history, and no rewards apply yet. Design history, the model and open
questions are in `docs/stretch-mode.md`. Read it before changing Stretch mode.

## Storage: log + snapshot

Data directory: `app.path().app_data_dir()`
(`~/Library/Application Support/com.ruoqi.switchcard/`, identifier `com.ruoqi.switchcard`).

```
days.log         append-only, one JSON record per line
days.snapshot    last checkpoint: { "seq": N, "days": { "YYYY-MM-DD": {...} } }
game.json        Tetris state, rewritten atomically
stretch.log      Stretch mode's own log + stretch.snapshot, same format and rules
```

Stretch mode uses the same `Store` code under another name (`Store::open_named(dir, "stretch", ..)`),
with its own managed state and lock (`StretchState`) and its own commands (`stretch_load`,
`stretch_put_day`). Each record is a whole Stretch day: `{ date, blocks, tracks, updatedAt }`.
It is kept apart from the day history until we decide how parallel blocks map onto it.

**Records are whole-day images** (physical logging), not fine-grained operations:

```
{"seq":57,"ts":1790405596459,"op":"day.put","day":{"date":"2026-09-25","entries":[...],"updatedAt":...}}
```

The page already calls `persist(dayKey)` after every mutation of a day, with the full day object.
Port that call to `window.switchcard.putDay(day)` and log it as `day.put`. This keeps replay trivial
and idempotent (the last `day.put` for a date wins). A day is a few KB, so the log grows by tens of
KB a day. Don't switch to logical ops (start/finish/edit) unless there's a concrete reason.

Treat day objects as opaque JSON in Rust (`serde_json::Value`), apart from reading `date`. The
schema lives in the page; Rust shouldn't duplicate it.

Rules:

- **Append, then sync.** Open with `OpenOptions::new().append(true).create(true)`, write the line
  including `\n` in one `write_all`, then `sync_all()`. On macOS, Rust's `sync_all` issues
  `F_FULLFSYNC`, so it flushes the drive cache too, not just the OS buffers. That costs a few
  milliseconds, which is fine at this write rate.
- `seq` is monotonic across restarts: on startup, read it from the last good record.
- **Recovery**: read the snapshot, then replay `days.log` records with `seq > snapshot.seq`. If the
  final line doesn't parse or has no trailing newline, it's a torn write: `set_len` the file to the
  end of the last good line and continue. A bad line anywhere else is corruption: stop, leave the
  file untouched, and surface an error to the page. Never silently drop history.
- **Checkpoint** when the log passes 1 MB or 2,000 records: write `days.snapshot.tmp`, `sync_all`,
  `rename` over `days.snapshot`, sync the directory (`File::open(dir)?.sync_all()`), then rotate
  `days.log` to `days.log.<seq>` and start an empty log. Keep the last two rotated segments; delete
  older ones.
- **Log outcomes, not inputs.** Records store what the app decided at the time: the reward granted,
  `auto: true` for blocks auto-logged at 3 h, and which day a block was filed under. Replay never
  recomputes rewards or re-derives idle rows. The reward formula has already changed once; history
  must not shift when it changes again.
- **game.json**: Tetris changes on every locked piece, so it isn't logged. Write `game.json.tmp`,
  `sync_all`, `rename`. Last write wins.
- The store lives behind a `Mutex` in Tauri managed state, and only the commands in `commands.rs`
  call it. There is exactly one writer.
- **Keep one copy of the truth.** The web version lost data this way: a browser with a days-old
  `localStorage` cache auto-logged a stale running block on load, which stamped that day with a fresh
  `updatedAt`, so it won the last-writer-wins merge and overwrote five real entries on the server.
  The desktop app has no cache and no merge: the page renders what `load()` returns and writes back
  through the bridge. Don't add `localStorage` (or any second store) that can be written back.

Storage code from the reference page is replaced by the bridge: `window.claude.use("db")`,
`pushRemote`, `connect`, `connectGame`, and the `localStorage` mirror all go. On startup the page
calls `window.switchcard.load()` → `{ days, game }` instead of `readLocal()` / `connect()`.

## Migration

On first launch (no `days.snapshot` and an empty `days.log`), import the bundled
`resources/seed-export.json` (resolve it with `app.path().resolve(.., BaseDirectory::Resource)`):
write every day as a `day.put`, write `game.json`, then checkpoint. Ignore unknown top-level
keys in the export (it has `exportedAt`, `source` and `notes`). Record
`{"op":"import","source":"seed-export","ts":...}` in the log so it runs only once. The export may
contain a running block (`worked: null`); keep it as-is. The normal 3-hour auto-log rule will close
it.

## Behavior to preserve exactly

These are easy to break during the port. The reference file has the details.

- Roll: uniform integer 30–100. The die rolls until the user taps Stop, then lands and turns into
  the number.
- The logical day runs **4:30 am to 4:30 am**. Blocks started before 4:30 belong to the previous
  day, and the header shows "(late night)". `normalizeDays()` re-files misfiled entries on load.
- Idle rows: starting a block logs the gap since the day's last end time as `type: "idle"`. The
  day's first block gets idle from 8:30 am if it starts after 8:30. Manual entries carve themselves
  out of overlapping idle rows.
- A running block unfinished after 3 hours is auto-logged at 180 minutes with `auto: true` and
  `reward: 0`.
- Rewards (`rewardFor`): length, overrun, way-over and stopped-early terms plus the early-start
  bonus, all ×2 and clamped to **1–20** pieces. Manual (no-roll) entries skip the plan-relative
  terms. Rewards are stored on the entry once granted.
- Log rows are bars whose height is proportional to minutes (1.2 px/min, min 34 px, max 480 px).
- Tetris: gravity 480 ms per row, banked pieces, the total score persists across games.
- The dice renderer (a CPU ray tracer in plain JS, cube ∩ sphere, lamp, table shadow, motion blur) is
  done and tuned. Port it verbatim; don't restyle the die or change its physics. Check its frame time
  under JSC stays in the same range as in Chrome (about 5–9 ms per frame while rolling).

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

- `store.rs`: append + reload; a torn final line is truncated and recovery succeeds; a corrupt
  middle line fails loudly; checkpoint + rotation, then replay from the snapshot gives identical
  state; `seq` continues across restarts. Use a temp dir per test.
- Migration runs once and is idempotent.
- `rewardFor` table: 180/120 min at 6:30 am → 20; 75/75 at 9 am → 10; 75/75 at 3 pm → 8;
  119/90 at 6:02 pm → 11; 10/90 at 11 pm → 1; manual 120 min at 1 pm → 12.
- `dayKeyAt`: 4:29 am belongs to the previous day, 4:31 am to the same day.
- Tray title formatting: running, over plan, long task names, idle.

Pull the pure JS functions into `src/js/rules.js` (an ES module loaded by the page and imported by
the tests). Everything else can stay in the page.

## Working with Ruoqi

- She's a software engineer with a database internals background. Explain storage and systems
  choices precisely, and skip basics.
- Show changes by running the app, not just by describing them. Ask before changing anything that
  alters how the app looks or how rewards are computed.
