# Stretch: interaction design

How the timeline, the elastic pull and parallel blocks work, and how they got that way. Design
discussion and progress from 2026-10-04 onwards. Storage has its own document,
[storage.md](storage.md).

Code: `src/ts/stretch.ts`, `src/css/stretch.css`.

Stretch began as a second mode ("Stretch mode") inside a Roll app, which picked a block's length
with a die. Since 2026-10-05 it is the whole app; the Roll app is archived locally (see Legacy in
CLAUDE.md). Rounds 1–10 below happened while it was still a mode.

## The idea

The Roll app picked a block's length for you (a random 30–100). Stretch lets you shape it by
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
| Replace the die? | At first no: Stretch was a second mode, switched from the menu bar menu. From 2026-10-05 Stretch is the only interface and the die is archived for reuse. |
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
11. **Stretch is the app.** Roll mode, the die, Tetris rewards and the mode items in the menu
    were removed (archived locally). The panel opens straight into the timeline. New icon: two
    parallel blocks, solid up to now.
12. **Blocks widen into free columns.** A group of overlapping blocks is transitive, so a
    column can be empty for part of it. A block planned later in the day kept its track's
    narrow column even when only one other block ran beside it. Now each block widens over the
    neighbouring columns that are free for its whole span, and split lines are drawn only where
    two blocks actually meet.
13. **Widening claims the column.** With many blocks, two blocks on either side of a free
    column could both widen into it and draw on top of each other. Widening now claims the
    column for the block's span: blocks are widened in order of start (then left to right), and
    a column already claimed is no longer free. The layout moved to `src/js/columns.js` (pure)
    with a randomized stress test that checks no two blocks that overlap in time overlap on
    screen.
14. **Overrun stopped growing.** The sketch's note 4 ("if you don't stop when the time is up,
    the block keeps growing by itself") was built in rounds 1–13: a running block's top edge
    followed now past its plan. *Feedback (2026-10-18):* it should stop growing at the planned
    end, and be stretchable to now or beyond when you come back. Now a block never extends past
    its planned end: past it the block sits fully solid but stays *running*, with its handles,
    until Done or the next block in its track begins. The pull limit for a begun block is now
    `elapsed + MAX_PLAN` (i.e. up to 3 h past now), so coming back late never leaves it out of
    reach; *Done* after the plan has passed ends it at the planned end, where it visibly stopped.
    The hover label past the plan says "9:00–9:30 AM · time up, pull to continue".
15. **Slots, migration and switching (2026-10-18).** Three changes in one round, with the Linux
    kernel's process model as the reference: multiprogramming is either true parallelism
    (several CPUs) or time-slicing one CPU with context switches.
    - *Slots.* Blocks no longer share the panel by track weights (and no longer widen to fill
      it). The lane is a fixed row of equal-width columns — **slots**, like the cores of a small
      SMP machine (~4 at the panel's width). Every block is one slot wide; empty slots are idle.
      "Next block in the track ends the previous" becomes "next block in the slot". Track
      weights, split-dragging and the widening layout (`columns.js`) were removed.
    - *Migration.* A press on a block that moves mostly sideways drags the block 1:1; on release
      it snaps to the nearest slot if that slot is free for its whole span, else snaps home —
      moving a task to another core's runqueue.
    - *Switching.* Right-click a running block → "Switch with …" marks 2–3 running blocks as
      switched between rather than parallel: one core, time-sliced. Time accounting stays wall
      clock (the blocks still span real time); the group is a logged outcome, and hover shows
      the honest share — *focused* time = elapsed − shared·(1−1/n), each member getting ~1/n of
      the shared span: elapsed vs CPU time. Over the shared span the fills interleave into
      scheduler slices (5-min bands, round-robin by member index) — synthetic and even, since
      the app doesn't see real context switches. Joining or leaving closes the group and opens a
      new one with the new size, so every span keeps the n it ran at; when a member ends, the
      survivors (if ≥2) continue as a new group. Pure logic in `src/js/switching.js` (now `src/ts/switching.ts`), tested.
16. **Thin blocks, free x, instant stripes.** *Feedback (2026-10-18, same day):* marking two
    blocks as switching showed nothing (the slices only accrue with time — minutes before
    anything visible), and four 68-px slots still read as blocks taking up the panel; blocks
    should be about a tenth of the panel wide, and movable to any place, "their places and
    distances to show how much they are related". So:
    - *Free x.* A block's `x` is a free pixel position, not a slot index; the distances between
      blocks carry her meaning and the app doesn't interpret them. The queue rule generalises:
      blocks that **overlap in x** are one core's sequence (the next one over a block ends it);
      blocks apart in x are parallel. `BLOCK_W` is 34 px. Placement lands where pressed,
      following a block's tail as before, else nudging sideways to the nearest free spot;
      dragging is 1:1 with a 10-px magnet onto another block's exact x (queues line up), and a
      landing that would overlap a time-overlapping block snaps home.
    - *Instant switching feedback.* An active group also stripes the stretch ahead — from now up
      to where the first member stops — with the member's own turns at ghost strength and the
      others' turns fainter (35% of ghost). Marking is visible the moment it happens; the spent
      interleaving still accrues behind now. Slice phase is anchored at the group's start.
    - *Vertical names.* At 34 px a horizontal name is unreadable, so names run bottom-to-top
      along the time axis (`writing-mode: vertical-rl` rotated).
17. **Badge and tie instead of interleaving.** *Feedback (2026-10-18, same day):* "I don't like
    the interleaving design." Switched to the quieter visual that was the other option in that
    round's design question: fills stay solid; a thin dashed tie runs between the members of an
    active group at the now line, climbing with the clock — the context switch is happening
    there, now. Past groups show only in the hover's focused time. The slice rendering (and
    `sliceSpans`) was removed; `switching.js` keeps just `focusedMs`. The ⇄ first sat on each
    member; further feedback moved it into the middle of the tie, between the blocks.
18. **The ball.** *Feedback (2026-10-18, same day):* "a small ball bouncing between them, moving
    both left and right and up and down a bit (imagine the tiny ball hitting the block from an
    angle) like a moving atom." The tie and ⇄ are gone. A 5-px ball ping-pongs across each gap
    between adjacent members (one ball per gap, so a ×3 group gets two), with a slower vertical
    bounce (±9 px) around the now line — sideways 34 px/s, vertical 21 px/s, incommensurate so
    the strike angle keeps changing. It rides up with the clock; the animation runs only while a
    group is on (and pauses with the hidden panel, since rAF stops). With reduced motion the
    ball sits still in the middle of the gap.
19. **Straight legs, time-up rest, trace.** *Feedback (2026-10-18, same day):* the ball changed
    direction mid-air ("randomly swimming") — now each leg is a straight line and the ball only
    turns when it strikes a block, reflecting sideways and aiming for a new vertical offset
    reached exactly at the next strike (so the angle still varies). It kept bouncing after a
    task's time was up — now it's there only while *both* members are inside their plans: when
    one's plan runs out the ball vanishes, and it comes back when that block is stretched past
    now again (the group itself stays on). And the last few legs linger as a 1-px fading trace
    (~5 s, two-plus bounces), so the ricochet path reads like a particle track.
20. **The die returns, labels replace names, comic inking.** *Feedback (2026-10-19):* three asks —
    bring back the randomness ("do the die rolling animation… produce a random number between
    30–100 mins", die about a block wide), stop typing task names and *label* blocks instead
    (right-click, pick a task type from everything ever added; labeled blocks wear a small
    speech-bubble icon that opens to the label and a small note), and give the whole thing more
    finished detail — a comic speech-bubble reference image: thick/thin line contrast, shadows,
    a richer switching animation. So:
    - *The roll.* Press-and-hold now throws the Roll app's ray-traced die (ported verbatim into
      `src/js/dice.js`, scaled to half ≈ a block's width) at the press point; it bounces on the
      start line, lands by itself after ~1 s (a click lands it early, Escape cancels), and the
      block sprouts up by the rolled 30–100 min (5-min steps, clamped into the room there — a
      tag says "rolled 85 min" or "rolled 85 min, 60 fit"). The press point is now the block's
      **start**, not its middle, since the length isn't known until the die lands; the pull-up
      that used to continue the hold is gone — shrink or stretch with the top edge after. With
      reduced motion there's no die, just the rolled length.
    - *Labels.* Typing into blocks is gone (old typed names still show). The right-click menu
      lists every label ever added (ticked on the current one; picking the tick takes it off)
      plus a "New label…" input. Labels are global `{ id, name }`s in their own `"labels"`
      record — one more opaque day image to Rust, replayed like any day. A labeled block wears
      a comic speech-bubble badge; clicking it opens a bubble with the label name and a small
      note (saved on blur). The hover tip leads with the label name.
    - *Inking.* Blocks get a thick 2-px ink outline with a halftone-dot shadow peeking out
      bottom-right (the reference image's look), against the axis's thin hairlines; the menu is
      a comic panel (thick border, solid offset shadow); the bubble has a thick outline, a
      pointed tail toward its block, thin accent ticks and the dot shadow. The switching ball
      squashes against the block it strikes and two accent strokes flare at the contact point.
21. **Names gone, bubbles slide, printed halftone.** *Feedback (2026-10-19, same day):* three
    adjustments — stop showing typed names at all (today and onward), make the bubble movable up
    and down its block by press-and-drag, and fix the rough inking: outlines overlapped between
    blocks and the on-the-fly dot gradient looked sparse — use a pattern image instead. So:
    - Blocks render no name; `task` stays in the data but nothing shows it.
    - The bubble drags vertically along its block (pointer capture on the bubble; the note still
      edits normally) and remembers its place per block — `bubbleY`, px from the block's top,
      persisted with the day.
    - The halftone is now a real tile, `src/img/halftone.svg` (a 45° dot grid), applied as a
      mask over solid ink so it follows the theme. Each block's shadow is its own element at a
      z-index *below* every block, offset bottom-right and kept at the block's size by layout —
      it peeks past its own block and slides under neighbours instead of printing over them.
      Back-to-back blocks in a queue fuse their outlines: when the block above starts exactly
      where one ends, the lower box grows one border up so the two 2-px borders print as one.
22. **The icon slides; the bubble pops from it.** *Feedback (2026-10-19, same day):* round 21
    misread "the bubble slides" — it's the small **icon** that should slide along the block, not
    the opened bubble; the big bubble should appear right at the icon's place (icon hidden while
    it's out), stay until a "−" shrinks it, its shadow mustn't overlap it, and its shape must be
    sharp like the reference, tail uncut. So: the badge drags vertically along its block
    (`bubbleY` is now the badge's offset from the block's top; a press that doesn't move is the
    click that opens). The bubble is one inline SVG, like the reference art: the halftone shadow
    is the same bubble path offset (11,11) painted first, the opaque bubble (3-px stroke) covers
    the overlap — no clipping, pointed tail intact — with two thin accent ticks; it opens with
    the tail tip on the icon's spot, mirrors when there's no room to the right, and the label +
    note + "−" sit in HTML over the face. No more closing on outside clicks — only "−" or
    Escape.
23. **Several bubbles, worded badges, boxes not ovals.** *Feedback (2026-10-19, same day):*
    several big bubbles can be left out on the panel at once (one per block — `bubbles` is a map
    by block id now, and only "−", Escape, relabeling or removing closes one); the small icon
    wears the label's first words instead of being a plain glyph (a mini bubble with the text,
    ellipsised past ~two words, full name in its tooltip, flipping to the block's left near the
    panel's edge); and both bubbles changed shape from an oval to a rounded-corner box with the
    same sharp tail — the big one's SVG path is a 14-px-radius box, the badge is a CSS box with
    a triangle tail and a solid offset shadow.
24. **Badges above all blocks.** *Feedback (2026-10-19, same day):* the small bubbles should
    always stay on top of blocks — as block children they lived inside their block's stacking
    context, so a neighbouring block drawn later could cover them. Badges are lane children now,
    at a z-index above every block (including one being dragged), pinned to their block by
    `placeBadge` through layout, sideways drags and the slide transition.
25. **Tails point at the block; no accent ticks.** *Feedback (2026-10-19, same day):* both
    bubbles' tail tips should point to the centre of the block, and the two curves around the
    big bubble (the accent ticks from the reference image) should go. The badge's tail stays
    short and fixed (an SVG polyline near the box's corner, filled over the box's border so it
    opens into it, only the slanted sides inked); `placeBadge` shifts the whole badge sideways so
    the tip lands on the block's centre line. (A first try stretched the tail out to the centre
    instead; she wanted the bubble moved, not the tail lengthened.) The big bubble opens with its
    tip on the block's centre line at the badge's height. The ticks are removed.
26. **Denser block shadows.** *Feedback (2026-10-19, same day):* the dots in the blocks'
    shadows should be denser. The halftone tile is drawn at 5 px instead of 7 px for the block
    shadows (`mask-size` on `.st-shade`), so the dots are smaller and closer together, at the
    same ink coverage. A follow-up asked the same for the big bubble: its inline SVG pattern is
    now the same tile at 5 px, so all the halftone shadows match.
27. **Align.** *Feedback (2026-10-21):* a block with the same label as another block earlier or
    later in the day should have a right-click *Align* that puts every block of that label at
    the same horizontal position, with a dashed line connecting them. *Align* moves them all to
    the right-clicked block's x (or the nearest x where every one of them fits, nudging in 4-px
    steps like placement); if two of them overlap in time they can't share a queue, so it says
    so and nothing moves. The dashed line is drawn, not stored: blocks that share a label and an
    exact x are tied by a 2-px dashed ink line up the gap between each one and the next, under
    the blocks like the shadows, sliding with them. Dragging one away unties it; the drag
    magnet landing one on another's x ties them too.
28. **Deletable labels.** *Feedback (2026-10-21, same day):* labels should be deletable; blocks
    that already wear a deleted label keep it, but it leaves the list — keep a pool of archived
    labels. Each label row in the right-click menu has a quiet × (shown on hover) that archives
    it: `archived: true` in the labels record, never removed, so labeled blocks on any day keep
    their name and badge. A block wearing an archived label still sees it in its own menu,
    ticked, so it can be taken off. Typing an archived label's name into "New label…" brings it
    back from the pool, same id.
29. **Other days, and getting up and going to bed.** *Feedback (2026-10-22):* a small calendar
    icon at the top right should open a small calendar; clicking a past date loads that day's
    blocks, and a future date loads a blank day where blocks can be scheduled ahead, already
    there when the day comes. And: right-click a blank spot to pick "Got out of bed!" or "Going
    to bed!", which puts a bubble there that can be moved up or down to the exact time.
    The calendar is a comic panel under the icon (month, ‹ ›, Sunday-first grid from
    `monthCells` in `day.js`); a dot marks days with blocks or marks, today is ringed, the day
    on show is filled. Any day opens in the same timeline: nothing new is stored for a future
    day beyond the usual day record under its date, so when the clock reaches it the blocks are
    simply loaded. The view follows the clock (rolls over at 4:30 am) only while it's on today;
    a "Today" pill beside the date leads back. The marks are `wake` and `sleep` on the day
    record — at most one each a day — drawn as small bubbles just right of the axis, tail
    pointing at the time, showing the time; drag 1:1 to the minute, right-click → *Remove*.
30. **Wider blocks for the task taking the most attention.** *Feedback (2026-10-22, same day):*
    block width should be changeable, only in whole multiples of the narrowest (1×, 2×, 3×…),
    with aligned blocks staying aligned on their middle line when any width changes. A block
    has a `span` (1–`SPAN_MAX` = 4), set from a *Width 1× 2× 3× 4×* row in the right-click menu.
    A width change keeps the block's centre, and everything that lines blocks up now goes by
    centre line instead of left edge: ties (same label + same centre), *Align* (every block of
    the label onto one centre, each keeping its width), and the drag magnet (snaps when the
    centres are within 10 px). `x` is kept on whole pixels so centres compare exactly. The queue
    test became an interval overlap ([x, x + width)), so a wide block shares a core with every
    block it spans. A width that would cross the lane's edge or sit on a block it overlaps in
    time is refused ("No room to make it n× wide here"), rather than moved off its centre.
31. **Logging finished tasks; widening past blocks.** *Feedback (2026-10-23):* she should be able
    to add a block for a task she didn't log while it was going and that's already over — a
    block placed wholly in the past couldn't be resized — and past blocks couldn't be made
    wider. The log showed why. A block's end is frozen as soon as a later block in its queue
    begins, so a back-filled block in a queue with anything after it was `done` the moment it
    landed, and `done` blocks had no edges. And widening was refused whenever the centred
    width ran into a neighbour it had run alongside (107 and 108 on Oct 22, 7 px apart) — not
    a past-block rule at all, but it hit past blocks, which sit densely. Now: finished blocks
    keep both edges. Pulling the top moves its `end` (and `plan` with it), up to now and the
    next block in the queue; the bottom moves the start with no MAX_PLAN floor. A block placed
    wholly behind now is finished on landing (`end = start + plan`). Widening pushes blocking
    neighbours outward (she picked this over growing off-centre or a clearer refusal): each
    block in the way slides away from the widened block's centre line just far enough, taking
    its aligned blocks (same label, same centre) along, and pushing whatever it meets in turn;
    only if something would leave the lane is it refused.
32. **Align pushes too.** *Feedback (2026-10-23, same day):* two "HNSW with GPUs" blocks
    couldn't be aligned. Lining 107 (2×, 18:10–19:15) up under 118 (2×, 23:50) would sit it on
    119 (3×, 19:00–21:20), and Align's fallback, searching for a centre where everything fits
    without moving anything else, found none for a 2× block. Align now uses the same push as
    widening (`pushAside`, shared): every block of the label goes onto the right-clicked
    block's centre line, and blocks in the way slide outward with their aligned kin. The old
    nearest-free-centre search is the fallback when pushing would leave the lane.
33. **Knocks.** *Feedback (2026-10-23, same day):* when moving or widening a block leaves two
    blocks touching, there should be a small physical effect, as if the block pushed the other
    a bit further away — about half a 1× width, or less when the panel is full. A pushed block
    now lands `KNOCK` px clear of what pushed it: 17 (half of BLOCK_W), or 12, 8, 4, 0 —
    the roomiest that fits in the lane. Touching counts as a hit (within 2 px), not just
    overlapping, but only for blocks this change moved or widened, so blocks that already sat
    side by side stay put. On the hit the block squashes horizontally for a beat (to 78 %,
    anchored on its far side) and then slides off with the usual overshoot; blocks further down
    a chain of pushes start 90 ms later per link. Dragging joined in: a dropped block knocks
    what it lands against, and a drop onto a block pushes it aside instead of snapping home
    (it still snaps home if the push would leave the lane). Reduced motion: no squash, no delay.
    *Fix (same day):* a TinyFrames block couldn't widen to 2× though a 0-px knock fitted: at
    gap 0 a pushed block lands flush, flush still counted as touching, and a touch needing no
    move was taken for "can't get clear". A touch already at the knock distance isn't a hit now;
    only a real overlap that outward motion can't clear refuses.

## Current behaviour

- **Other days:** the calendar icon at the top right opens a month (‹ › to page). Days with
  something in them have a dot, today is ringed, the day on show is filled; click any day to
  open it. Past days show what was done and can still be edited (blocks, labels, notes,
  marks); a future day starts blank and takes blocks ahead of time — they're saved under its
  date and are there when it comes. Off today, the now dot is hidden, a past day is all grey
  and a future one all white, switching isn't offered, and a "Today" pill beside the date goes
  back. Another day opens scrolled to its first block or wake mark, or 8 am. The view only
  rolls over at 4:30 am while it's on today; a future day being shown becomes today in place.
- **Got out of bed / going to bed:** right-click a blank spot → *Got out of bed!* or *Going to
  bed!* puts that bubble at the clicked minute (or moves the day's one there). The bubble sits
  just right of the axis with its tail on the time and shows the time; drag it up or down,
  1:1, to the exact minute. Right-click it → *Remove*.

- **Thin, free blocks:** a block is 34 px wide (about a tenth of the panel), or a whole
  multiple of that — right-click → *Width 1× 2× 3× 4×*; wider means the task takes more of
  her attention. It sits at a free x position — the distances between blocks are the owner's
  to mean something with (how related the tasks are); the app doesn't interpret them. Blocks
  whose spans overlap in x are one queue (a core's sequence); blocks apart in x run in
  parallel. A width change keeps the block's centre line, so aligned blocks stay aligned.
  Blocks it would now sit on or touch (overlapping in time) are knocked outward, away from
  that centre line, to land half a 1× width clear (less if the panel is full) — a quick squash
  on the side it was hit, then a slide with a little overshoot — each taking the blocks aligned
  with it along, and knocking whatever it meets in turn, a beat later. If that would push something out of the lane, it says there's no room and nothing
  changes. Past blocks widen the same way.
- **Create:** press and hold for 400 ms; moving more than 6 px first cancels (unless it becomes a
  drag, below). The die is thrown at the press point — it bounces on the start line, lands on its
  own after about a second (click it to land it early; Escape cancels) — and the block sprouts up
  from the pressed time by the rolled length: 30–100 min on 5-minute steps, clamped into the room
  there (a tag says what was rolled, and what fit). The pressed x is kept, or nudged sideways to
  the nearest free spot if taken ("No room" if nowhere fits). A press at or after now starts no
  earlier than now, so "hold at the now line" means "start this now". Shrink or stretch with the
  top edge afterwards. With reduced motion there's no die — the block just appears at the rolled
  length. A block placed wholly behind now is a task logged after the fact: it lands finished
  (`end` = start + rolled length), and its edges still stretch and move it.
- **Move:** a press on a block that moves mostly sideways drags it 1:1 left or right. Releasing
  with its centre within 10 px of another block's centre snaps onto that centre line exactly.
  Where it lands it knocks blocks it overlaps in time and touches (or was dropped on) a little
  way off, as widening does; only if that can't fit in the lane does
  a landing on a block it overlaps in time snap home.
- **Align:** right-click a labeled block → *Align* (shown when another block today has the same
  label and they aren't all lined up already) moves every block of that label onto this
  block's centre line, each keeping its width, pushing other blocks in the way outward the
  same way widening does — or, if that would push something out of the lane, onto the nearest
  centre where all of them fit; "Can't align" if two of them overlap in time.
  Blocks sharing a label and a centre line are joined by a dashed line through the gaps between them —
  derived from the data, not stored, so dragging one away removes its line.
- **Switching:** right-click a running block → "Switch with …" (other running blocks are listed
  by name or start time) marks 2–3 blocks as switched between, not parallel — one core,
  time-sliced. While the group is on and every member is inside its plan, a little ball
  ricochets between the members around the now line in straight legs, turning only when it
  strikes a block, its last few legs lingering as a fading trace; when a member's time is up the
  ball vanishes until that block is stretched past now again. Hover shows
  "switching ×n, ~X min focused"
  (focused = elapsed − shared·(1−1/n)); a past group shows only there. "Stop switching"
  dissolves the group; a member ending dissolves and re-forms it with the survivors. Groups are
  logged outcomes with from/to times.
- **Top edge = the end (elastic):**
  - Target length = `base + TENSION·ln(1 + reach/TENSION)`, where `reach` is the pointer travel
    since taking hold. Pulling back down is 1:1.
  - The edge follows the target on a spring (`FOLLOW_K/C`), so it lags and overshoots.
  - Past the limits (10 min; 180 min for a block that hasn't begun, elapsed + 180 min for one
    that has; the next block in the same track) the edge gives at most 36 px.
  - A band connects the edge to the pointer, and the block narrows under tension.
  - On release, the length snaps to a 5-minute step and springs there (`SPRING_K/C`), starting
    from the edge's current speed.
- **Bottom edge = the start (rigid):** drag it to change the start 1:1 in 5-minute steps. The end stays fixed,
  and it can't go into the previous block in its slot.
- **Finished blocks** keep both edges, so a block logged after the fact (or ended by Done or
  the next block) can be fixed up: the top edge moves its end — from where it actually ended,
  up to now and the next block in its queue — and the bottom edge its start, any length.
- **Colour:** each block gets the next colour after the last block placed (`PALETTE` in
  `stretch.js`). Black text reads on all of them.
- **Fill:** the spent part is solid colour, from the bottom up, and the rest is translucent. The fill grows every 5 s
  with a 1 s ease. A block not yet started is all translucent. The fill (and the block) stops at
  the planned end: a block past its plan sits fully solid, still running, until Done or the next
  block in its track begins. Pull its top edge to stretch it to now or beyond.
- **Label:** blocks aren't typed into and show no name. Right-click lists every label ever added
  — the current one ticked (pick it again to take it off) — plus a "New label…" input; labels
  are global and kept forever to pick from. The × beside a label (on hover) deletes it from the
  list — it's archived, not erased: blocks that wear it keep it, and typing its name again
  brings it back. A labeled block wears a mini speech bubble — a
  rounded box with a sharp tail — showing the label's first words; it can be pressed and dragged
  up and down the block (it remembers its place), and flips to the block's left near the panel's
  edge; it sits shifted so its short tail's tip touches the block's centre. Clicking it pops the
  big bubble out at its height,
  tail tip on the block's centre line — the badge hides while it's out — with
  the label name and a small note, edited in place and saved on blur. A bubble stays until its
  "−" shrinks it back (Escape shrinks them all), and several blocks' bubbles can be left out at
  once.
- **Hover:** a label next to the pointer, led by the block's label name, e.g.
  "Deep work · since 8:55 PM · 3 of 65 min", "9:20 PM · 50 min", "8:10–9:00 PM · 50 min", with
  ", ~X focused" when some of it was shared, or, past the plan,
  "8:10–9:00 PM · time up, pull to continue".
- **Right-click:** *Done*, *Stop switching* / *Switch with …* (if running), *Align* (if it
  applies), *Width 1× 2× 3× 4×*, *Remove*, then the labels. *Done* ends the block at now, or at its planned end if that has already passed.
- **The look:** comic inking — blocks have a thick 2-px ink outline and a halftone shadow to the
  bottom right (the `img/halftone.svg` tile, masked over ink; each shadow is its own layer under
  every block, so it never prints over a neighbour), against the axis's thin hairlines;
  back-to-back blocks in a queue share one outline; the menu is a comic panel with a solid
  offset shadow; the bubbles are rounded boxes with sharp pointed tails aimed at the block's
  centre — the big one an SVG with a thick outline and the halftone shadow painted behind so it
  never overlaps the face, the badge a mini box with a solid offset shadow; the
  switching ball squashes on impact with two accent strokes at the contact point; the die is the
  Roll app's ray-traced one, with its real soft table shadow.

## The model

```
block   { id, task, x, span, start, plan (min), created, end, color, label, note, bubbleY }
                                     end is set only by Done; x is the left edge in the
                                     lane, whole px; span the width in BLOCK_Ws (1–4;
                                     missing = 1); color indexes PALETTE; label is a label id
                                     (or null), note a small free note, bubbleY where the
                                     badge was dragged to (px from the block's top, or
                                     null); task is a typed name from before labels, kept
                                     in the data but no longer shown
switch  { id, blocks: [block ids], from, to }      to is null while the group is on
day     { date, blocks, switches, wake, sleep }  wake/sleep: when she got out of bed and
                                     went to bed that day, ms, or null
label   { id, name, archived }       global, not per day — in the "labels" record; archived
                                     labels are off the menu's list but kept for the blocks
                                     that wear them
```

- **Blocks that overlap in x are one queue** — a core. Within a queue, blocks don't overlap in
  time. A block runs until the next block *over it in x* begins, and never extends past its
  planned end: when its plan runs out it stops growing but stays running (and stretchable) until
  something ends it. Blocks apart in x run in parallel and never end it. The queue test is
  pairwise (the x spans [x, x + span·BLOCK_W) overlap), so A–B and B–C can be queues while A
  and C are not — a wide block can share a core with two blocks that run in parallel.
- **State is derived** from the time and the blocks: `ahead` (start > now), `running`
  (no end yet), `done`.
- **Placement:** the new block lands at the pressed x; a press within a taken block's last
  10 minutes goes after it at the same x, and any other clash nudges the new block sideways in
  4-px steps to the nearest free spot.
- **Moving:** dropping a block re-sorts it into whatever queue it now overlaps, which can end it
  earlier (a next block above it) or revive the block it used to end. Elements are kept across
  renders, so blocks slide to where they land.
- **Switching groups** (`src/ts/switching.ts`, pure, tested): a group never overlaps another for
  the same block — joining and leaving close the old group and open a new one, so each span
  keeps the size it ran at. Focused time is elapsed − Σ shared·(1−1/n). The storage knows
  nothing of groups beyond the day doc.

## Storage

Each change writes the whole day, `{ date, blocks: [{ id, task, x, span, start, plan, created,
end, color, label, note, bubbleY }], switches: [{ id, blocks, from, to }], wake, sleep,
updatedAt }`, as one
record in an append-only log. It's written after a placed block's die lands, pulling an edge,
moving the start edge, moving a block sideways, labeling, editing a note, sliding a badge to a
new place, changing a block's width, placing, dragging or removing a wake/sleep mark, *Done*, *Remove*, forming or
dissolving a switching group, and when a block's end is first determined (the next block in its
queue began), so the log keeps those outcomes rather than re-deriving them. The labels live in
their own record, `{ date: "labels", labels: [{ id, name, archived }], updatedAt }` — keyed "labels" where
days are keyed by date, one more opaque image to Rust, replayed the same way; blocks point at
labels by id, so a rename would reach every day. Days written before 2026-10-18 have a `slot`
index, or `track` ids and a `tracks` array; on load both map to x positions spread from the
left. On startup the page loads every day and shows today's (the calendar opens the others
from the same loaded map, and writes go to the day on show); if the log can't be read, it says
so and makes no writes. The design is in [storage.md](storage.md).

## Tunables

At the top of `src/ts/stretch.ts`:

```
PX 1.6        SNAP 5        ROLL_MIN 30 / ROLL_MAX 100    MIN_PLAN 10    MAX_PLAN 180
HOLD_MS 400   HOLD_SLOP 6   TAIL_MIN 10
TENSION 200   RUBBER 36     FOLLOW_K 110 / C 11    SPRING_K 380 / C 14    SQUEEZE 18
BLOCK_W 34    SPAN_MAX 4    KNOCK 17/12/8/4/0    SWITCH_MAX 3
BALL 5        BALL_AMP 9    BALL_VX 34         TRACE_MS 5000
```

The die's own numbers (size, camera, lamp, gravity) are the Roll app's, unchanged, at the top of
`src/js/dice.js`; its on-screen size is the `scale(.5)` on `.st-die` in the CSS.

## Open questions and next steps

- **Back to today on open?** The panel keeps showing whatever day was picked, even after it's
  hidden and reopened. Jumping back to today on reopen might suit a menu bar timer better.
- **Marks and blocks overlap.** The wake/sleep bubbles sit at the lane's left edge, above any
  block there. They only move up and down for now.
- **Rewards.** Deferred. Undecided whether stretching earns anything, and how parallel blocks
  count. The Roll app's reward rules and Tetris game are archived if they're wanted back.
- **Menu bar title.** The icon shows nothing about running blocks. With parallel blocks,
  decide what it should show (the Roll app's title ticker is archived).
- **Uneven switching shares.** Every member gets 1/n; the kernel has nice-values and CFS
  weights. Is "mostly task A, glancing at B" worth modelling?
- **Real context switches.** The slices are synthetic. Logging actual switches (a tap on the
  block I'm turning to) would make the fill a true scheduler trace — and a heavier interaction.
- **Stretching interactions.** These are the eventual reason for the name and haven't been
  designed yet.
