# Stretch mode: design notes

Design discussion and progress from 2026-10-04. Stretch mode is a second way to plan and track
work, next to Roll mode. It is a prototype: nothing is saved yet, and there are no rewards.

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
| Timeline | The whole logical day (4:30 am to 4:30 am), scrolling, at 1.6 px/min. It opens with now a third of the way down. |
| Look | Its own black-and-white palette (white background, black in dark mode) with one teal (`#00C2CE`, from the sketch). No grid: a thin axis line, hour ticks and labels, and a thin now line. |
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

## Current behaviour

- **Create:** press and hold for 400 ms; moving more than 6 px first cancels. A 30-min block pops
  in, centred on the pointer. A press at or after now starts no earlier than now, so "hold at
  the now line" means "start this now". Keep holding and pull down to stretch it.
- **Bottom edge (elastic):**
  - Target length = `base + TENSION·ln(1 + reach/TENSION)`, where `reach` is the pointer travel
    since taking hold. Pulling back up is 1:1.
  - The edge follows the target on a spring (`FOLLOW_K/C`), so it lags and overshoots.
  - Past the limits (10 min, 180 min, the next block in the same track) the edge gives at most
    36 px.
  - A band connects the edge to the pointer, and the block narrows under tension.
  - On release, the length snaps to a 5-minute step and springs there (`SPRING_K/C`), starting
    from the edge's current speed.
- **Top edge (rigid):** drag it to change the start 1:1 in 5-minute steps. The end stays fixed,
  and it can't go into the previous block in its track.
- **Fill:** the spent part is solid teal and the rest is translucent. The fill grows every 5 s
  with a 1 s ease. A block not yet started is all translucent.
- **Name:** hidden until you double-click the block. Then it's edited in place, centred, and
  shown as bold text.
- **Hover:** a label next to the pointer, e.g. "since 8:55 PM · 3 of 65 min",
  "9:20 PM · 50 min" or "8:10–9:00 PM · 50 min".
- **Right-click:** *Done* (if running) and *Remove*.

## The model

```
block  { id, task, track, start, plan (min), created, end }   end is set only by Done
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

## Tunables

At the top of `src/js/stretch.js`:

```
PX 1.6        SNAP 5        DEFAULT_PLAN 30    MIN_PLAN 10    MAX_PLAN 180
HOLD_MS 400   HOLD_SLOP 6   TAIL_MIN 10
TENSION 200   RUBBER 36     FOLLOW_K 110 / C 11    SPRING_K 380 / C 14    SQUEEZE 18
MIN_COL 44
```

## Open questions and next steps

- **Storage.** Stretch blocks live in memory only. Before they're saved, decide how they map
  onto the day log: whether the existing day entries (`startedAt`, `planned`, `worked`) need a
  track field, and how parallel time counts. The "outcomes, not inputs" rule in `CLAUDE.md`
  still applies.
- **Rewards.** Deferred. Undecided whether a stretched plan earns like a rolled one, and how
  parallel blocks count.
- **Menu bar title.** It shows only Roll blocks. With parallel blocks, decide what it should
  show.
- **Track reuse.** Holding on a block reuses an earlier, free extra track with its old weight,
  so the split isn't always exactly `1/(n+1)`.
- **Stretching interactions.** These are the eventual reason for the name and haven't been
  designed yet.
