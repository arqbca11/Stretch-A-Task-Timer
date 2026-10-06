# Stretch - A Task Timer

A macOS menu bar timeline for working on several things at once. Today is a vertical strip of
time. You **press and hold** to drop a block where you want to start, then **pull it up like a
rubber band** to say how long it should run. Start something else alongside it, and the panel
splits into parallel columns, one per thread of work.

Built with [Tauri 2](https://tauri.app): a Rust backend with its own append-only log storage,
plain HTML/JS in a WKWebView, and a menu bar icon that opens the panel.

> **Status: prototype, in daily use.** Placing, stretching and parallel blocks are done and
> saved. Still open: a view of earlier days, rewards, and what the menu bar should show while
> blocks run. See [docs/interaction.md](docs/interaction.md).

## The timeline

- **Time runs upwards.** The bottom is 4:30 am, and the day climbs from there to 4:30 am the
  next morning, so late-night work counts toward the day it belongs to. The panel opens with
  now two-thirds of the way down and the rest of the day above.
- **Now** is a dot on the axis with the time beside it. Everything below it, the part of the
  day already gone, has a light grey background.
- **Blocks fill as time passes.** A block is translucent ahead of now and turns solid from the
  bottom up as its minutes are spent. Run past the plan and it keeps growing by itself until you
  finish it or the next block in its column begins.

## The stretch

Making a block is one continuous gesture:

1. **Press and hold** anywhere on the timeline. A ring fills, in the colour the block will be,
   for 400 ms. A click does nothing, so stray clicks don't make blocks.
2. **A 30-minute block pops in, centred under your pointer.** You're holding its middle. Hold
   above now to plan something later. Hold at now to start it now. Hold below now for
   something you started a little while ago.
3. **Keep holding and pull up.** The block's top edge (its end) follows like a weight on a
   rubber band:
   - It trails behind the pointer on a spring and wobbles when you stop.
   - Each extra minute takes more pull than the last, because the stretch is logarithmic.
   - A thin band stretches from the edge to your pointer, and the block narrows slightly
     under the tension.
   - At a limit (10 min, 3 hours, or the next block in the column) the edge gives only a
     little more, like iOS overscroll.
4. **Let go.** The length snaps to a 5-minute step and springs into place, keeping the speed
   the edge had.

Afterwards, grab the **top edge** to stretch it again, or drag the **bottom edge** to move the
start (1:1, no elasticity, the end stays put). **Double-click** to name it. **Hover** to see
its times, and **right-click** for *Done* and *Remove*. Each new block takes the next of nine
bright colours, so neighbours never match.

## Multitasking

Real work overlaps: you're 45 minutes into a 90-minute task when you kick off an agent run,
or start reading while a build finishes. Stretch treats those as parallel **tracks**:

- **Hold on a running block** to start another one beside it. The panel splits: one block
  becomes two halves, two become thirds. The new column takes `1/(n+1)` of the width, and
  the others keep their proportions to each other.
- **Drag the line between two columns** to change the split, for example to 40/60. Columns
  slide to their new widths with a little bounce.
- **Each track is its own sequence.** A block runs until you finish it or the next block in
  *its* column begins. Parallel blocks never end each other.
- **Splits are local in time.** Only blocks that actually overlap share the width. A block
  alone in its stretch of the day takes the full width again.
- **Holding near the end of a block** (its last 10 minutes) queues the new one after it, in
  the same column.

## Storage

Everything is saved locally in
`~/Library/Application Support/com.ruoqi.stretch/`. Nothing goes over the network, and there is
no database library.

```
stretch.log          append-only log, one whole-day image per line
stretch.snapshot     last checkpoint
stretch.log.<seq>    the two most recent rotated segments
```

The store is WAL-flavoured: each change appends the full image of the day it touched, as one
line, and syncs it with `F_FULLFSYNC` before telling the page it's saved. Recovery is snapshot
plus replay. A torn final line is truncated, and damage anywhere else stops the app from
writing rather than dropping history. The page keeps no other copy. The full design, including
crash windows and trade-offs, is in [docs/storage.md](docs/storage.md).

## Menu bar

Left-click the icon to open or close the panel. Right-click for *Open*, *Launch at login* and
*Quit*. The app has no Dock icon. The panel hides instead of closing, so the timeline keeps
running.

## Build and run

You need Rust (via [rustup](https://rustup.rs)), the Xcode Command Line Tools and Node.

```sh
npm install
npm run tauri dev                                      # run in development
npm test                                               # JS tests (node --test)
cargo test --manifest-path src-tauri/Cargo.toml        # storage tests
npm run tauri build -- --target aarch64-apple-darwin   # build the .app and .dmg
```

The bundle is written to `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/`. It is
unsigned, so on first launch right-click → Open, or run
`xattr -dr com.apple.quarantine "Stretch.app"`. To install it, quit the app and copy it to
`/Applications`:

```sh
ditto "src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Stretch.app" /Applications/Stretch.app
```

## Layout

```
src/                     frontend, served as-is (no framework, no bundler)
  index.html             the panel: header and timeline
  js/stretch.js          the timeline, elastic pull, parallel tracks, colours
  js/day.js              the 4:30 am day boundary (shared with the tests)
  js/bridge.js           window.stretch = { load, putDay } over Tauri invoke
  css/stretch.css        all styles; light and dark
  css/fonts.css, fonts/  Karla, served locally
src-tauri/src/
  store.rs               log + snapshot storage, recovery, checkpoint (unit-tested)
  commands.rs            load, put_day
  tray.rs                menu bar icon, menu, panel toggling
  lib.rs                 plugins, setup, window events
scripts/draw-icons.swift draws the menu bar and app icons
test/                    node --test suites
docs/interaction.md      interaction design: decisions, history, model, tunables
docs/storage.md          storage design
```

## History

Stretch started as a menu bar port of a web app called Switch Card, where you rolled a die for
a number of minutes (30–100) and worked on one thing for that long, earning Tetris pieces. The
stretchy timeline began as a second mode inside it and became the whole app on 2026-10-05.
