# Stretch - A Task Timer

A macOS menu bar timeline for working on several things at once. Today is a vertical strip of
time. You **press and hold** to drop a block where you want to start, a die rolls how long it
runs, and you **pull it like a rubber band** to make it shorter or longer. Blocks sit side by
side as thin columns, one per thread of work, and pastel **TODO** bubbles mark what has to be
finished today, while die-cut **stickers** collect what got done or went well.

Built with [Tauri 2](https://tauri.app): a Rust backend with its own append-only log storage,
plain HTML and TypeScript (no framework, no bundler) in a WKWebView, and a menu bar icon that
opens the panel.

> **Status: prototype, in daily use.** Placing, stretching, parallel and switching blocks,
> labels, TODOs, stickers, other days and wake/sleep marks are done and saved. Still open: rewards, and
> what the menu bar should show while blocks run. See [docs/interaction.md](docs/interaction.md).

## The timeline

- **Time runs upwards.** The bottom is 4:30 am, and the day climbs from there to 4:30 am the
  next morning, so late-night work counts toward the day it belongs to. The panel opens with
  now two-thirds of the way down and the rest of the day above.
- **Now** is a dot on the axis with the time beside it. Everything below it, the part of the
  day already gone, has a light grey background.
- **Blocks fill as time passes.** A block is translucent ahead of now and turns solid from the
  bottom up as its minutes are spent. At its planned end it stops growing but keeps running
  until you finish it, the next block in its queue begins, or you stretch it further.
- **The look is comic inking:** thick ink outlines, halftone-dot shadows, speech bubbles with
  sharp tails, against the axis's thin hairlines. Light and dark follow the system.

## Placing a block

1. **Press and hold** anywhere on the timeline. A ring fills, in the colour the block will be,
   for 400 ms. A click does nothing, so stray clicks don't make blocks.
2. **A die is thrown at the press point.** It's the ray-traced die from the Roll app: it bounces
   on the start line and lands after about a second (click it to land it early, Escape
   cancels). The block sprouts up from where you pressed by the rolled length, 30–100 minutes
   in 5-minute steps, clamped to the room there. A tag says what was rolled.
3. **Where you press is when it starts.** Hold at now to start it now, above now to plan it,
   below now to log something after the fact (a block wholly behind now lands finished).
   Holding in a block's last 10 minutes queues the new one right after it.

## The stretch

Grab a block's **top edge** (its end) and pull. It follows like a weight on a rubber band:

- It trails behind the pointer on a spring and wobbles when you stop.
- Each extra minute takes more pull than the last, because the stretch is logarithmic.
- A thin band stretches from the edge to your pointer, and the block narrows slightly under the
  tension.
- At a limit (10 minutes; 3 hours, or 3 hours past now once it has begun; the next block in
  its queue) the edge gives only a little more, like iOS overscroll.
- Let go and the length snaps to a 5-minute step and springs into place.

The **bottom edge** moves the start, 1:1 with no elasticity, and the end stays put. Finished
blocks keep both edges, so a block logged afterwards can be fixed up; pulling a finished block
past now reopens it. **Hover** a block for its times and focused minutes; **right-click** for
*Done*, width, *Align*, switching, *Remove*, its TODO and its label.

## Multitasking

Real work overlaps: you're 45 minutes into a task when you kick off an agent run, or start
reading while a build finishes.

- **Blocks are thin columns, placed freely.** A block is about a tenth of the panel wide, or
  2×–4× that for the task taking the most attention (right-click → *Width*). Drag a block
  sideways to move it. The distances between blocks are yours to mean something with; the app
  doesn't interpret them. Blocks that are moved or widened knock their neighbours aside.
- **Blocks that overlap in x are one queue**, like processes on one core: a block runs until the
  next one over it begins. Blocks apart in x run in parallel and never end each other.
- **Switching:** right-click a running block → *Switch with …* marks 2–3 running blocks as
  time-sliced on one core rather than parallel. A little ball ricochets between them around the
  now line, and hover shows each one's focused time, about 1/n of the wall clock.

## Labels and notes

Blocks aren't named by typing. Right-click one and pick a task type from the global label list,
or type a new one; every label is kept to pick from. A labeled block wears a small speech-bubble
badge; click it to open the bubble with the label and a short note. *Align* lines up every block
of a label on one centre line, and aligned blocks of a label are joined by a dashed line.

## TODOs

Right-click an empty spot **ahead of now** → *Add TODO* puts a small bubble there in a light
pastel (butter, pink, sky, mint, peach in turn), its tail on the spot, and
opens it for typing what to finish. Click it to edit, tick its box when it's done, drag it
anywhere, right-click it for *Edit*, *Done* and *Remove*.

A block can be **linked to one TODO** of its day from the block's right-click menu, under
"Working on"; its label doesn't have to match the TODO. A thin dashed curve in the TODO's colour
runs from the block to the bubble. Several blocks can work on one TODO.

## Stickers

Right-click any empty spot, **past or ahead** → *Add sticker* slaps a die-cut sticker there for
what got done or went well that day ("got an interview invite"). Type a line per win (Enter
for a new line; ⌘Enter or click away to keep it); each line gets a gold ★. Click it to edit,
drag it anywhere, right-click it for *Edit* and *Remove*.

## Other days, getting up and going to bed

- **The calendar icon** at the top right opens a month. Days with something in them have a dot.
  Past days show what was done and can still be touched up; future days take blocks and TODOs
  ahead of time. A *Today* pill goes back.
- **Right-click a blank spot** → *Got out of bed!* or *Going to bed!* puts a small mark on the
  axis at that time. Drag it to the exact minute.

## Storage

Everything is saved in local storage on the user's machine, in the app's data directory.
Nothing goes over the network, and there is no database library.

```
stretch.log          append-only log, one whole-day image per line
stretch.snapshot     last checkpoint
stretch.log.<seq>    the two most recent rotated segments
```

The store is WAL-flavoured: each change appends the full image of the day it touched (its
blocks, switching groups, TODOs, stickers and marks), as one line, and syncs it with `F_FULLFSYNC` before
telling the page it's saved. The label list is one more record, keyed `labels`. Recovery is
snapshot plus replay. A torn final line is truncated, and damage anywhere else stops the app
from writing rather than dropping history. The page keeps no other copy. The full design,
including crash windows and trade-offs, is in [docs/storage.md](docs/storage.md).

## Menu bar

Left-click the icon to open or close the panel. Right-click for *Open*, *Launch at login* and
*Quit*. The app has no Dock icon. The panel hides instead of closing, so the timeline keeps
running.

## Build and run

You need Rust (via [rustup](https://rustup.rs)), the Xcode Command Line Tools and Node 23.6+
(Node runs the TypeScript tests directly).

```sh
npm install
npm run tauri dev                                      # run in development (tsc --watch alongside)
npm run build                                          # compile src/ts to src/js
npm run typecheck                                      # tsc --noEmit over src/ts and test/
npm test                                               # page tests (node --test)
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
  ts/                    the page's TypeScript; tsc emits each file to js/ (gitignored)
  ts/stretch.ts          the timeline: placing, the roll, elastic pull, free placement, labels,
                         switching, TODOs, stickers, marks, the calendar, persistence
  ts/types.ts            the record schema and the StretchBridge interface
  ts/day.ts              the 4:30 am day boundary and the calendar grid (shared with the tests)
  ts/switching.ts        focused time for switching groups (shared with the tests)
  ts/bridge.ts           window.stretch = { load, putDay } over Tauri invoke, writes in order
  js/dice.js             the ray-traced die and its physics, from the Roll app (hand-kept JS)
  css/stretch.css        all styles; light and dark
  css/fonts.css, fonts/  Karla, served locally
  img/halftone.svg       the halftone tile for the shadows
src-tauri/src/
  store.rs               log + snapshot storage, recovery, checkpoint (unit-tested)
  commands.rs            load, put_day
  tray.rs                menu bar icon, menu, panel toggling
  lib.rs                 plugins, setup, window events
scripts/draw-icons.swift draws the menu bar and app icons
test/                    node --test suites for day.ts and switching.ts
docs/interaction.md      interaction design: decisions, history, model, tunables
docs/storage.md          storage design
```

## History

Stretch started as a menu bar port of a web app called Switch Card, where you rolled a die for
a number of minutes (30–100) and worked on one thing for that long, earning Tetris pieces. The
stretchy timeline began as a second mode inside it and became the whole app on 2026-10-05. The
die came back as the way a new block gets its length.
