# Stretch mode: design notes

Design discussion and progress from 2026-10-04. Stretch mode is a second way to plan and track
work, next to Roll mode. It is a prototype: its blocks are saved in their own log, and there are
no rewards yet.

Code: `src/js/stretch.js`, `src/css/stretch.css`. The tray menu items live in `src-tauri/src/tray.rs`.

## The idea

Roll mode picks a block's length for you (a random 30–100). Stretch mode lets you shape it by
hand. A block is a piece of rubber band on a day timeline: you place it, then pull it longer. It
fills in as time passes. The starting point was a Figma sketch with four notes:

1. Click on blank space and a box appears that stands for a task, 30 min by default.
2. Pull it down and it feels like stretching a rubber band. The longer you pull, the longer the
   plan (e.g. 90 min).
3. A time axis on the left stands for the day.
4. If you don't stop when the time is up, the block keeps growing by itself.

The numbers in the sketch are placeholders, not a spec.

## Decisions

| Question | Decision |
|---|---|
| Replace the die? | No. Stretch is a second mode, and Roll mode is untouched. |
| How do you switch modes? | Right-click the menu bar icon → *Roll mode* / *Stretch mode* (check items). There's no switch in the panel. *Roll a number* and *Keep going* switch back to Roll on their own. |
| Timeline | The whole logical day (4:30 am to 4:30 am), scrolling, at 1.6 px/min. Time runs **upwards**: 4:30 am at the bottom, later higher up. It opens with now two thirds of the way down, so the rest of the day is above. |
| Look | Its own black-and-white palette (white background, black in dark mode). Blocks take bright colours in turn, starting with the sketch's teal (`#00C2CE`). No grid: a thin axis line with hour ticks and labels. Now is a dot on the axis with the time beside it, and the part of the day already gone has a light grey background. |
| Where does a block start? | At the time you place it. Behind now, it's already going. Ahead of now, it starts by itself when its time comes. There's no Start button. |
| Rewards | Deferred until blocks and pulling feel right. |

## How it got here

Each round was built, installed and tried in the menu bar panel.

1. **Click to create, pull the edge.** The edge followed the pointer 1:1, with iOS-style
   overscroll at the limits and a spring onto the 5-minute step on release. The block had a
   Start button for planned blocks, a dashed planned-end line and a grip bar.
   *Feedback:* use black and white, drop the grid, no Start button, make the spent part solid.
2. **Time-driven blocks.** A translucent block turns solid from the top as time passes. Overrun
   keeps growing solid. A block ends when the next one begins.
   *Feedback:* the pull doesn't feel like a rubber band, and a single click makes blocks by
   accident.
3. **Press and hold to create, plus an elastic pull.** A ring fills during a 400 ms hold, and a
   click makes nothing. The edge becomes a mass on a spring tied to the pointer, so it trails and
   wobbles. The pull is logarithmic, so each minute costs more. A band is drawn between the edge
   and the pointer, and on release the edge keeps its speed into the settle.
   *Feedback:* the block appears with the pointer on its top edge, so you have to move to the
   bottom edge before you can stretch.
4. **The block appears centred on the pointer.** The pull is measured from where you took hold,
   so the block grows from the first pixel of movement.
   *Feedback:* remove the dashed line and the grip bar. Show the name field only after placing.
   Make the top edge adjustable but not stretchy. Make the stretch stronger.
5. **Invisible edges and a stronger stretch.** Edges became invisible grab zones. The top edge
   moves 1:1 in 5-minute steps and keeps the end fixed. `TENSION` went 300 → 200, the follow
   spring got softer (`FOLLOW_K` 170 → 110), and the block narrows by up to 18 px a side under
   tension.
   *Feedback:* remove the hint text and the mode buttons. The name field should appear only on
   double-click.
6. **Multitasking.** Hold anywhere, even on a running block, and start a parallel block. The
   panel splits into columns, and you can drag the line between two columns to change the split.
   *Feedback:* the time and × get covered in narrow columns.
7. **Hover label, right-click menu, centred name.** Start time and length moved into a label
   that follows the pointer. *Done* and *Remove* moved into a right-click menu. The name sits in
   the middle of the block.
8. **A colour per block.** Each new block takes the next colour in a ring of nine bright ones
   (teal, hot pink, orange, electric blue, lemon, violet, mint, coral, lime), so two blocks
   placed one after another never match. The hold ring fills in the colour that's coming.
9. **Time runs upwards.** The axis is flipped: a block starts at its bottom edge, you stretch it
   by pulling up, and it fills from the bottom up as time passes. Rounds 1–8 above describe the
   downward version; the top/bottom edges in them are swapped now.
10. **Now as a dot.** The line across the lane is gone. Now is a black dot on the axis with
    the time beside it, and the time already gone (below it) has a light grey background
    (`#F0F0F0`, `#1C1C1C` in dark mode).

## Current behaviour

- **Create:** press and hold for 400 ms; moving more than 6 px first cancels. A 30-min block pops
  in, centred on the pointer. A press at or after now starts no earlier than now, so "hold at
  the now line" means "start this now". Keep holding and pull up to stretch it.
- **Top edge = the end (elastic):**
  - Target length = `base + TENSION·ln(1 + reach/TENSION)`, where `reach` is the pointer travel
    since taking hold. Pulling back down is 1:1.
  - The edge follows the target on a spring (`FOLLOW_K/C`), so it lags and overshoots.
  - Past the limits (10 min, 180 min, the next block in the same track) the edge gives at most
    36 px.
  - A band connects the edge to the pointer, and the block narrows under tension.
  - On release, the length snaps to a 5-minute step and springs there (`SPRING_K/C`), starting
    from the edge's current speed.
- **Bottom edge = the start (rigid):** drag it to change the start 1:1 in 5-minute steps. The end stays fixed,
  and it can't go into the previous block in its track.
- **Colour:** each block gets the next colour after the last block placed (`PALETTE` in
  `stretch.js`). Black text reads on all of them.
- **Fill:** the spent part is solid colour, from the bottom up, and the rest is translucent. The fill grows every 5 s
  with a 1 s ease. A block not yet started is all translucent.
- **Name:** hidden until you double-click the block. Then it's edited in place, centred, and
  shown as bold text.
- **Hover:** a label next to the pointer, e.g. "since 8:55 PM · 3 of 65 min",
  "9:20 PM · 50 min" or "8:10–9:00 PM · 50 min".
- **Right-click:** *Done* (if running) and *Remove*.

## The model

```
block  { id, task, track, start, plan (min), created, end, color }
                                         end is set only by Done; color indexes PALETTE
track  { id, w }                                               left-to-right order, width weight
```

- **Tracks are independent sequences.** Within a track, blocks don't overlap. A block keeps
  going, past its plan if need be, until the next block *in its track* begins. A block filled
  in after that next block had already begun (`created > next.start`) covers only its plan.
  Blocks in other tracks run in parallel and never end it.
- **State is derived** from the time and the blocks: `ahead` (start > now), `running`
  (no end yet), `done`.
- **Placement:** the new block tries the column under the pointer first, then the other tracks
  from the left. If the time is taken in all of them, it starts a new track. A press within a
  block's last 10 minutes goes after that block in the same track rather than beside it.
- **Layout:** blocks that overlap in time form a group. Within a group, each track present gets
  a column sized by its weight's share. A block that overlaps nothing takes the full width, even
  if the day was split earlier. Elements are kept across renders, so blocks slide to their new
  widths.
- **Widths:** a new track takes `1/(n+1)` of the width it shares with the `n` tracks there
  (its weight is their mean). The others keep their proportions: a 40:60 pair becomes
  26.7 : 40 : 33.3. Dragging a split moves weight between the two neighbouring tracks, and no
  column can go narrower than 44 px.
- **Empty tracks** are removed.

## Storage

Stretch mode has its own log, separate from the day history: `stretch.log`, `stretch.snapshot`
and rotated `stretch.log.<seq>` files, next to `days.log` in the app's data directory. It is the
same `Store` code under another name (`Store::open_named`), so it keeps the same rules: append
then fsync, torn-tail recovery, and checkpoint with rotation. It has its own lock
(`StretchState`) and two commands, `stretch_load` and `stretch_put_day`.

- **One record per day:** `{ date, blocks: [{ id, task, track, start, plan, created, end, color }],
  tracks: [{ id, w }], updatedAt }`. Writes go through the bridge's ordered queue.
- **When it's written:** after placing a block (on release), pulling an edge, moving the start
  edge, dragging a split, renaming, *Done* and *Remove*.
- **Outcomes, not inputs:** when a block ends because the next block in its track began, its
  `end` is written into the record at that moment. A later change to the rules then doesn't
  rewrite history.
- **On startup** the page loads all Stretch days and shows today's. If the log can't be read, the
  panel says so and makes no writes.

## Tunables

At the top of `src/js/stretch.js`:

```
PX 1.6        SNAP 5        DEFAULT_PLAN 30    MIN_PLAN 10    MAX_PLAN 180
HOLD_MS 400   HOLD_SLOP 6   TAIL_MIN 10
TENSION 200   RUBBER 36     FOLLOW_K 110 / C 11    SPRING_K 380 / C 14    SQUEEZE 18
MIN_COL 44
```

## Open questions and next steps

- **Merging with the day history.** Stretch has its own log for now (see Storage). Before
  merging, decide whether the existing day entries (`startedAt`, `planned`, `worked`) need a
  track field, and how parallel time counts.
- **Rewards.** Deferred. Undecided whether a stretched plan earns like a rolled one, and how
  parallel blocks count.
- **Menu bar title.** It shows only Roll blocks. With parallel blocks, decide what it should
  show.
- **Track reuse.** Holding on a block reuses an earlier, free extra track with its old weight,
  so the split isn't always exactly `1/(n+1)`.
- **Stretching interactions.** These are the eventual reason for the name and haven't been
  designed yet.
