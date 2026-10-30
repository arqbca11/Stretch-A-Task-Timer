# Companion: an agent behind the timeline

A roadmap, not a spec. Nothing here is built yet. Each phase should be lived with before the
next one starts, and several end in a decision only Ruoqi can make.

## The idea

Personal agents wait to be given a task, and someone with ADHD doesn't reliably start one. The
companion sits behind Stretch, watches what the log already records, and notices when something
drops off: a week of TCF practice, then nothing. It speaks rarely and quietly. When it does, it
doesn't report the gap. It offers an **on-ramp**: a two-minute thing you can't fail, which
happens to lead back into the real work.

- TCF: "Tu peux me traduire cette phrase ?" with a B1 sentence. Answering it is already practice.
  Then: "Want to keep going? I'll put a TCF block on now." The die rolls and the practice site
  opens.
- Ski season: "Look at this touring report from the Wasatch." Photos, then: "A few squats to
  protect your knees for the season?"

**The plan comes up only after the conversation has started.** "You did five days, then a gap.
The exam is in December. What would make next week work?" is fine once you're engaged. As an
opener it reads as an accusation. Goals like "score CLB5" or "three sessions a week" exist in the
companion's model, but they're never the first thing it says.

## Principles

- **Detection is deterministic; the LLM only phrases things and makes on-ramps.** No model
  polls the log. Plain code computes trends and fires triggers; a model runs only when a trigger
  fires or a conversation is under way. That makes it cheap, testable, and predictable about
  *when* it speaks, which matters more than *what* it says.
- **Silence by default.** At most one nudge a day, fewer per week, backing off when ignored. A
  badly timed nudge costs more than a missed one: it becomes a shame signal and the app gets
  avoided.
- **Invite, don't report.** On-ramps are questions or offers, never statistics. Every step of
  the ladder can be declined, and a decline ends it gracefully.
- **The companion reads the day log and never writes to it.** It keeps its own log. The page
  stays the only writer of days (storage.md's "one writer, one copy of the truth"). The one
  exception goes through the page: placing a block the user accepted is an ordinary page action
  and an ordinary `day.put`.
- **Log outcomes.** Every nudge, what it offered, and how far the user went are recorded at the
  time they happen, so later phases can learn from them without re-deriving anything.
- **Personal data stays local unless a phase says otherwise.** When a model API is involved,
  send derived features and the minimum context, not day records.

## Phase 1 — Per-label trends (read only, no UI)

The foundation, and useful on its own as a check of whether the signal is there.

- `src/ts/trends.ts`, pure like `switching.ts`, shared with tests. Input: the days `load()`
  returns plus the labels record. Per label, per logical day (`day.ts` boundaries): focused
  minutes (`switching.ts`, so time-sliced blocks count at their share).
- Per label it outputs:
  - minutes per day over a trailing window
  - **cadence**: active days in the last 14
  - **last active day** and current **gap**
  - **state**: `established` / `lapsing` / `dormant` / `new`
- Lapse is relative to the label's own rhythm. Something done daily lapses after ~2 empty days,
  something done twice a week after ~5. Starting rule: established = active on ≥4 of the trailing
  10 days; lapsing = gap ≥ max(2, 2 × median interval between active days); dormant = lapsing
  for > 14 days (the companion stops raising it on its own).
- Days with no blocks at all (travel, illness, an unopened app) shouldn't count as gaps for
  every label. Treat a fully empty day as "unknown", not "zero".
- Tests (`test/trends.test.ts`): a daily label lapses after its threshold and not before; a
  weekly rhythm isn't flagged as lapsing mid-week; empty days don't break a streak; archived
  labels are still computed but marked; blocks with only a legacy `task` and no `label` are
  ignored.
- A dev script (`scripts/trends.ts`) reads `stretch.snapshot` + `stretch.log` **read-only** and
  prints the table for the real history.

**Exit:** run it on the real log. Does it flag TCF on the day you'd have wanted it to, and stay
quiet about things you meant to stop? Tune the thresholds here, while nothing is speaking yet.

## Phase 2 — The companion's own log, and goals

- A second store instance, `companion`, using the same `store.rs` machinery (the store already
  takes a name). Its own files: `companion.log`, `companion.snapshot`. Same durability rules,
  separate history. New ops replace `day.put`, e.g. `goal.put`, `nudge.put` (whole-record
  images again, so replay stays `records[id] = record`).
- A **goal** is small and human:
  - one or more labels it watches
  - a free-text intent ("TCF in December", "ski season")
  - its **on-ramp kinds** (translate a sentence, a listening clip, an exercise, a trip report)
  - an optional URL to open
  - an optional horizon (the exam date, the first ski day)
  - a state: active / paused / let go
- A minimal way to create goals. Initially that can be by hand (a JSON file, or through me)
  rather than UI.
- Rust commands `companion_load` / `companion_put`, alongside `load` / `put_day`. The bridge
  keeps the two write queues separate.

**Decision:** where goal editing eventually lives in the panel (a UI change, so it needs a
design round first).

## Phase 3 — First nudge, no LLM

Prove timing before content.

- When a goal's label goes `lapsing`, the companion picks an on-ramp from a **hand-written
  pool** (e.g. fifty B1 sentences, a handful of exercises) and shows it as **one quiet bubble
  in the panel**, the next time it's opened. No notification and no tray mark yet.
- **Budget:** one nudge a day at most, none for a goal that was nudged in the last N days, and
  exponential back-off after each ignore. "Not now" and "let this go" are one tap each; "let this
  go" sets the goal to let go.
- Every nudge is logged with its outcome: `shown`, `answered`, `dismissed`, `ignored` (shown and
  the panel closed with no response).
- The answer counts: a translation answered is TCF engagement and feeds back into Phase 1's
  trend, so the person who just answered isn't nudged again for the same gap. It's offered as a
  sticker on today ("traduit une phrase"), which you can keep or skip.

**Exit:** two weeks of living with it. Were the moments right? Did any nudge sting? Content can
be bad in this phase; timing can't.

**Decision:** how the bubble looks and where it sits. A UI change, so design it first.

## Phase 4 — The escalation ladder

After an answered on-ramp, offer the next step, one at a time:

1. On-ramp, answered.
2. "Keep going?" → place a block for that goal's label at now. The die rolls as for any new
   block, so the existing ritual starts the session. Placed by the page, logged as a normal day.
3. Open the goal's URL (the TCF practice site).
4. Only now, if still engaged, a short plan check-in. Phase 6 does this properly; here a
   template ("5 days on, 3 off; exam in 6 weeks") is enough.

Each step logs how far the ladder got.

**Decision:** opening URLs needs `tauri-plugin-opener` (or a small Rust command around macOS
`open`). CLAUDE.md limits plugins and permissions to positioner and autostart, so this is an
explicit addition to approve.

## Phase 5 — Generated on-ramps (the first model call)

Replace the hand-written pool with generated ones, where generation clearly helps:

- Fresh B1 sentences, varied in topic and grammar point, and checking the answer kindly (what
  was right, one thing to look at).
- Exercises chosen for the goal and season.
- **Pre-generate in batches** while online and keep them in the companion log, so an on-ramp
  never fails for lack of network and there's no wait when the panel opens.
- Model calls go from Rust (not the page): API key in the macOS Keychain; requests carry the
  goal's intent and on-ramp kind, never day records.

**Decisions:** Claude API vs. an on-device model (quality vs. privacy and offline). The CSP
stays as it is, since only Rust talks to the network.

## Phase 6 — The conversation after engagement

Once you're in the ladder, the companion can talk about the plan:

- Context sent to the model is **derived**: the label's trend table from Phase 1, the goal's
  intent and horizon, recent nudge outcomes. Not blocks, notes, TODO text or stickers, unless
  a specific question needs them and that's been agreed.
- Aim: one small, concrete commitment ("Tuesday and Thursday mornings, 30 minutes?"), which can
  become TODOs for those days. Placed by the page, after you accept.
- The conversation is logged in the companion log (summarized, not every token), so the next
  one can refer back: "Last time you said mornings work better."

## Phase 7 — Outside content (the ski trip report)

- **Curated sources only**: a short list of feeds or sites you choose (e.g. Wasatch backcountry
  trip reports), fetched by Rust. The model may pick and introduce one; it never invents a
  report, a place or a photo.
- Images: the CSP blocks remote images, so Rust fetches them and passes them as `data:` URLs,
  or the bubble links out. Keep a credit line and link to the source.
- Seasonal awareness: ski on-ramps make sense from autumn on, TCF ones up to the exam date.
  Goals with a horizon ramp up as it nears.

**Decision:** which sources, and whether photos are shown in the panel or only linked.

## Phase 8 — More signals

What the day log can't see today:

- **Opening the panel without doing anything.** Probably the strongest "stuck" signal. It's
  an interaction event, not a day change, so it belongs in the companion log (or a third,
  lossy telemetry stream), never in `day.put`.
- Energy proxies already in the days and worth adding to the trend features: rolled length vs.
  the pulled top edge (shrinking vs. stretching), early Done, wake/sleep marks, how much
  switching, TODOs left unlinked at day's end.
- Time-of-day patterns: when blocks for each label actually start, so nudges arrive when you
  tend to be able to act on them.

**Decision:** whether interaction events are recorded at all, and how long they're kept.

## Phase 9 — Learning from outcomes

With weeks of nudge outcomes in the companion log:

- which on-ramp kinds get answered, per goal
- which times of day and days of the week work
- how far up the ladder each kind usually gets

Use it to weight choices, simply (counts, not a model) at first. And the reverse: a goal whose
nudges keep being dismissed gets a gentle "still a goal?" rather than more nudges.

## Delivery channel (deferred)

The order of intrusiveness: a bubble waiting in the panel → a mark on the tray icon → a macOS
notification. Start with the first. The others need the companion to run while the panel is
hidden, which means detection in Rust, or trusting the hidden page's timers. Revisit after
Phase 3 shows whether the panel alone is enough.

## Open questions

- Should the companion have a name and a voice, or stay an unnamed presence in the panel?
- French on-ramps for TCF are obvious. What language is everything else in?
- What counts as engagement for goals that aren't timed on the timeline (squats)? A sticker,
  a tap, a short block?
- How does it behave on travel days or sick days: detect them, or let you say "off for a few
  days"?
- How much of the companion log should you be able to see and edit? (Probably all of it.)
