# Stretch - A Task Timer

A macOS menu bar timer for one way of working: **roll a number between 30 and 100, then work on
one thing for that many minutes.** When the time is up, log the block and roll again, or switch.
Each logged block earns Tetris pieces. Stretching interactions between blocks are planned.

Stretch started as a desktop port of a single-file web app called Switch Card
(`reference/switch-card.html`). The app is built with
[Tauri 2](https://tauri.app): a Rust backend, the original page running in a WKWebView, and a
menu bar item that shows the running block.

> **Status: working.** Storage, migration, the menu bar item and the ported page are done and in
> daily use. Still open: measuring the die's full frame time inside the app, and checking that the
> "minutes up" notification appears in the release build.

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
  *Roll a number*, *Roll mode* / *Stretch mode*, *Open*, *Launch at login* and *Quit*. The app
  has no Dock icon.
- **Stretch mode (prototype).** A whole-day timeline that runs upwards: press and hold to place
  a block, keep holding and pull up to stretch it. Hold on a running block to start a parallel one: the
  panel splits into columns, and you can drag the line between them. Saved in its own log,
  separate from the day history.

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
`xattr -dr com.apple.quarantine "Stretch.app"`. To install it, copy it to `/Applications`
(quit the app first):

```sh
ditto "src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Stretch.app" /Applications/Stretch.app
```

## Storage

Data lives in `~/Library/Application Support/com.ruoqi.switchcard/`. The bundle identifier
keeps the app's original name so existing history stays where it is. Nothing goes over the
network, and the app uses no database library.

```
days.log          append-only log, one JSON record per line
days.snapshot     last checkpoint: {"seq": N, "days": {"YYYY-MM-DD": {...}}}
days.log.<seq>    the two most recent rotated log segments
game.json         Tetris state, replaced atomically
stretch.log       Stretch mode's own log (+ stretch.snapshot, rotated segments), same rules
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
- **Ordered writes.** `bridge.js` sends writes (and status) one at a time, in order, each image
  captured when it's issued. Tauri doesn't guarantee that two in-flight `invoke`s arrive in order,
  and with whole-day records a reordered pair would let an older image win.
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
  index.html          the reference page's markup, unchanged
  js/app.js           the reference page's script; storage replaced by the bridge
  js/rules.js         pure rules shared with the tests: rewards, day keys, idle rows
  js/bridge.js        window.switchcard = { load, putDay, putGame, status } over Tauri invoke
  css/, fonts/        the reference styles, and Karla + Bricolage Grotesque served locally
test/                 node --test suites for rules.js
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
