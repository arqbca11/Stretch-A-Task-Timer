# Switch Card

A macOS menu bar timer for one way of working: **roll a number between 30 and 100, then work on
one thing for that many minutes.** When the time is up, log the block and roll again, or switch.
Each logged block earns Tetris pieces.

It's a desktop port of a single-file web app (`reference/switch-card.html`). The app is built with
[Tauri 2](https://tauri.app): a Rust backend, the original page running in a WKWebView, and a
menu bar item that shows the running block.

> **Status: work in progress.** The Rust side is done: storage, migration, tray and commands.
> The panel still shows a placeholder page while the web app is being ported.

## What it does

- **Roll.** A ray-traced die rolls until you tap Stop, then lands on a number from 30 to 100.
- **Block timer.** The menu bar shows `Leetcode · 23/75` (minutes worked / minutes planned), then
  `Leetcode · +8` once you pass the plan. You get one notification when the plan is reached.
- **Day log.** Each day's blocks and the idle time between them are drawn as bars whose height is
  proportional to minutes. A day runs from 4:30 am to 4:30 am, so late-night work counts toward
  the day before.
- **Rewards.** Each logged block earns 1–20 Tetris pieces. Longer blocks, finishing near or a bit
  past the plan, and starting early in the day all earn more. Your total score carries over
  between games.
- **Menu bar.** Left-click opens the panel. Right-click gives *Done, log it*, *Keep going*,
  *Roll a number*, *Open*, *Launch at login* and *Quit*. The app has no Dock icon.

## Build and run

You need Rust (via [rustup](https://rustup.rs)), the Xcode Command Line Tools and Node.

```sh
npm install
npm run tauri dev                                      # run in development
npm test                                               # JS rule tests (node --test)
cargo test --manifest-path src-tauri/Cargo.toml        # storage + tray tests
npm run tauri build -- --target aarch64-apple-darwin   # build the .app and .dmg
```

The bundle is written to `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/`. It is
unsigned, so on first launch right-click → Open, or run
`xattr -dr com.apple.quarantine "Switch Card.app"`.

## Storage

Data lives in `~/Library/Application Support/com.ruoqi.switchcard/`. Nothing goes over the
network, and the app uses no database library.

```
days.log          append-only log, one JSON record per line
days.snapshot     last checkpoint: {"seq": N, "days": {"YYYY-MM-DD": {...}}}
days.log.<seq>    the two most recent rotated log segments
game.json         Tetris state, replaced atomically
```

- **Physical records.** Each record is the full image of one day:
  `{"seq":57,"ts":…,"op":"day.put","day":{…}}`. Replay is idempotent, and the last `day.put` for a
  date wins. Rust treats a day as opaque JSON and reads only its `date`.
- **Durability.** Each record is written with one `write_all` of the line plus `\n`, then
  `sync_all`. On macOS that is `F_FULLFSYNC`, which also flushes the drive cache. If an append
  fails, the log is truncated back to the last complete record. If even that fails, the store
  refuses further writes, so a torn line can never end up in the middle of the log.
- **Recovery.** Load the snapshot, then replay the records with `seq > snapshot.seq`.
  - A final line that is unterminated or doesn't parse is a torn write and is truncated.
  - A bad line anywhere else is corruption. Startup stops, the file is left untouched, and the
    error is reported to the page.
  - `seq` carries on across restarts as `max(snapshot.seq, last record seq)`.
- **Checkpoint.** Runs when the log passes 1 MB or 2,000 records, in this order:
  1. Write `days.snapshot.tmp`, fsync it, rename it over `days.snapshot`, fsync the directory.
  2. Rename `days.log` to `days.log.<seq>` and start a new empty log.

  A crash at any step leaves a state that recovery reads correctly. The tests cover the window
  between the snapshot rename and the log rotation, and the case where the log is missing.
- **Outcomes, not inputs.** Records store what the app decided at the time: the reward granted,
  `auto: true` for blocks auto-logged at 3 h, and the day a block was filed under. Replay never
  recomputes these, so changing the reward formula doesn't rewrite history.
- **One copy of the truth.** The page has no `localStorage` cache and nothing is merged: it
  renders what `load()` returns and writes back through four commands (`load`, `put_day`,
  `put_game`, `status`). The web version lost data when a stale browser cache won a
  last-writer-wins merge.

### Importing history

On first launch the app imports `src-tauri/resources/seed-export.json` (the web version's export
format) if one was bundled. Each day is written as a `day.put`, `game.json` is written, an
`import` marker is logged last, and then a checkpoint runs.

- A crash part-way through leaves no marker, so the import runs again on the next launch. That's
  safe because the records are idempotent.
- With no seed bundled, only the marker is written. A seed added later therefore can't overwrite
  days logged in the meantime.

The real export is personal and listed in `.gitignore`. For the format, see
[`src-tauri/resources/seed-export.example.json`](src-tauri/resources/seed-export.example.json).

## Layout

```
src/                  frontend, served as-is (no bundler)
  js/bridge.js        window.switchcard = { load, putDay, putGame, status } over Tauri invoke
src-tauri/src/
  store.rs            log + snapshot storage, recovery, checkpoint, import (unit-tested)
  tray.rs             menu bar icon, title ticker, context menu, notification (title tests)
  commands.rs         the four commands the page can call
  lib.rs              plugins, setup, window events
reference/            the original web app, read-only
```

## Design notes

- **Rust owns the menu bar title.** A 15 s ticker recomputes elapsed minutes from wall-clock
  time. WebKit throttles timers in hidden windows and the Mac can sleep during a block, so the
  title must not depend on the webview.
- **The panel is hidden, never closed.** The timer and the Tetris game keep their state.
- **Strict CSP.** Self only, `data:` for images, plus Tauri's IPC origin. Fonts are bundled
  locally.
