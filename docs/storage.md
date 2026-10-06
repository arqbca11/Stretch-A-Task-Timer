# Storage: a log of whole-day images

Stretch keeps its data in an append-only log plus a periodic snapshot, written by a single
Rust component (`src-tauri/src/store.rs`). It borrows the core ideas of a write-ahead log:
durable sequential appends, monotonic sequence numbers, checkpoints and crash recovery. It
leaves out what a WAL exists for in a database, though: there are no data pages behind it to
protect. **The log is the store.** The closest analogues are Redis's AOF + RDB pair, or a redo
log whose only consumer is recovery.

This document covers the format, the write path, recovery, checkpointing, what can fail and
how, and the trade-offs behind each choice.

## Requirements

- **Never lose an acknowledged change.** When the page is told a write succeeded, the change
  must survive a crash or power loss.
- **Never silently drop or rewrite history.** If the data on disk is damaged, the app refuses to
  start rather than guessing.
- **One copy of the truth.** No cache that can be written back and no merge. (The web
  predecessor lost five entries when a stale browser cache won a last-writer-wins merge.)
- **No database dependency.** `serde_json` and `std::fs` only.
- **Small and boring.** One user, a few writes a minute at most, a few hundred bytes to a few
  KB per write. Simplicity matters more than throughput.

## Files

Data directory: `~/Library/Application Support/com.ruoqi.stretch/` (Tauri's `app_data_dir`).
The store has a name, `stretch`, and its files derive from it:

```
stretch.log           the live log: one JSON record per line
stretch.snapshot      the last checkpoint: every day as of some seq
stretch.log.<seq>     rotated log segments; the two most recent are kept
stretch.snapshot.tmp  a checkpoint in progress (deleted on startup if found)
```

## Data model

The unit of storage is a **day**: the page's whole state for one logical day (4:30 am to
4:30 am), keyed by `date`:

```json
{ "date": "2026-10-05",
  "blocks": [{ "id": 3, "task": "Leetcode", "track": 1, "start": 1791259200000, "plan": 45,
               "created": 1791259212000, "end": null, "color": 2 }],
  "tracks": [{ "id": 1, "w": 1 }],
  "updatedAt": 1791259300000 }
```

Rust treats a day as **opaque JSON** (`serde_json::Value`) and reads only `date`. The schema
belongs to the page (`src/js/stretch.js`). Rust doesn't duplicate it, so a new block field
needs no Rust change and no migration.

## Record format

```
{"day":{...},"op":"day.put","seq":42,"ts":1791259300123}\n
```

| Field | Meaning |
|---|---|
| `seq` | Sequence number, strictly increasing across the store's whole life (like an LSN). |
| `ts` | Wall-clock time of the append, in epoch ms. Informational only; nothing orders by it. |
| `op` | Always `day.put`. Any other op is treated as corruption (see Recovery). |
| `day` | The full image of one day after the change. |

Serialization is `serde_json`, so keys come out sorted. A record is one line, and the newline
is part of the record.

### Why whole-day images (physical logging)

Each change logs the entire day it touched, not the operation ("block 3's plan went from 30 to
45"):

- **Replay is trivial and idempotent.** Recovery is "for each record, `days[date] = day`". It
  can apply a record twice or start from any snapshot with no harm. Nothing has to know what a
  "pull" or a "split drag" means.
- **Outcomes, not inputs.** A record stores what the app decided at that moment. One example is
  a block's `end`, which is frozen when the next block in its column begins. Changing the
  page's rules later can't rewrite logged history, because replay never re-derives anything.
- **The price is write amplification.** A day is a few hundred bytes to a few KB. The first
  real day of use produced 41 records averaging ~500 bytes, so about 20 KB. At this scale
  that's nothing. It would stop being nothing with a very large day or a very high write rate,
  and neither applies here.

The page writes after each completed gesture (placing a block, pulling or moving an edge,
dragging a split, renaming, Done, Remove), not on every pointer move. It also writes when a
block's end is first determined.

## Write path

```
page (stretch.js)                      Rust
  persist() builds the day image
  window.stretch.putDay(day)
    bridge.js: serialize now,
    queue behind the previous write
      invoke("put_day") ───────────▶ commands::put_day
                                       lock the store's Mutex
                                       Store::put_day
                                         append: one write_all(line + "\n")
                                                 sync_all()        ← durable here
                                         days[date] = day (in memory)
                                         maybe checkpoint
      ◀──────────────────────── Ok(seq)
```

1. **Order is decided in the page.** Tauri doesn't promise that two in-flight `invoke`s arrive
   in order, and with whole-day images a reordered pair would let the older image win. The
   bridge therefore chains writes: each `put_day` starts only after the previous one has
   returned. It serializes the image when the write is issued, not when it's sent, so a later
   change to the page's objects can't leak into an earlier write.
2. **Single writer.** The store lives in Tauri's managed state behind a `Mutex`. Only the two
   commands in `commands.rs` touch it, and nothing else opens the files.
3. **Append, then sync.** The file is opened once with `O_APPEND`. A record goes out in a single
   `write_all` of the whole line including `\n`, followed by `sync_all()`. See
   [Append, then sync](#append-then-sync) below for exactly what each step guarantees.
4. **Acknowledge after durability.** The in-memory map is updated and `seq` returned only after
   `sync_all` succeeds. The page shows "Not saved: …" if a write fails.

### Append, then sync

A write passes through three layers on its way to permanent storage:

```
write(2)  →  kernel buffer cache  →  SSD's volatile write cache  →  NAND (permanent)
             └─ fsync(2) flushes this ┘
             └──────── F_FULLFSYNC flushes all of this ───────┘
```

- **Append.** When `write_all` returns, the line is only in the kernel's buffer cache. A
  process crash after that is safe, because the kernel still has the bytes. A kernel panic or
  power loss can lose them. `write_all` may also take several `write(2)` calls, so a crash can
  leave part of a line: the newline is the commit mark, and recovery truncates a final line
  without one.
- **Sync.** `File::sync_all()`, which Rust implements on macOS as `fcntl(fd, F_FULLFSYNC)`.
  Plain `fsync(2)` on macOS sends the file's data and metadata to the drive but doesn't make
  the drive flush its own cache, so a power loss can still lose or reorder the data (Apple's
  man page says so). `F_FULLFSYNC` also sends the drive a flush-cache command and waits for
  it. `sync_all` rather than `sync_data` because an append changes the file's length, which
  is metadata. On Apple platforms both map to `F_FULLFSYNC` anyway.
- **Acknowledge.** `put_day` returns its `seq` only after `sync_all` succeeds.

Measured on the development Mac (Apple silicon, internal SSD) by appending a 500-byte line
and syncing, 100 times:

| Method | Median | p90 |
|---|---|---|
| no sync | 0.00 ms | 0.00 ms |
| `fsync(2)` | 0.02 ms | 0.03 ms |
| `F_FULLFSYNC` | 4.00 ms | 4.10 ms |
| Rust `write_all` + `sync_all` | 4.00 ms | 4.15 ms |

Rust's `sync_all` matches `F_FULLFSYNC`, which confirms it doesn't fall back to plain
`fsync`. Plain `fsync` is 200 times cheaper because it stops at the drive's cache. About 4 ms
per write is irrelevant at a few writes a minute.

**Directory entries.** A file's data being durable doesn't make its *name* durable. The name
is an entry in the directory, and it needs the directory itself synced. The store syncs the
directory whenever it creates or renames a file: after creating `stretch.log` the first time,
after creating the data directory (by syncing its parent), and after each checkpoint's rename
and rotation.

What it can't cover: a drive that reports a flush it didn't do. Software can't detect that.

### A failed append

If `write_all` or `sync_all` fails, part of the line may already be in the file. If it were
left there, the next good append would land after it and turn a torn tail into a corrupt line
in the middle of the log. So the store immediately `set_len`s the file back to the end of the
last good record and syncs again. If even that fails, the store marks itself **poisoned** and
refuses all further writes until restart. Recovery then deals with the tail.

## Recovery

`Store::open` runs before the app serves any command:

1. **Delete `stretch.snapshot.tmp`** if present. It's a checkpoint that was never renamed, so
   the old snapshot is still the valid one.
2. **Load the snapshot**, if there is one: `{ "seq": S, "days": { date: day, ... } }`. A snapshot
   that doesn't parse or lacks `seq`/`days` is corruption.
3. **Replay `stretch.log`** line by line, applying `day.put` records with `seq > S`:
   - Each record's `seq` must be greater than the previous record's in the log. A record with
     `seq ≤ S` is skipped, not rejected: it was already folded into the snapshot (see the
     crash windows below).
   - A day without a `date`, or a record with no `seq`, is corruption.
   - **An unknown `op` is corruption.** Replay can't know what an op it doesn't understand
     would have done, so it stops rather than skip it.
4. **The torn tail.** If the **last** line has no trailing newline, or doesn't parse, it's a
   write that was never acknowledged. The file is truncated to the end of the last good line,
   then synced. A last line without its newline counts as torn even if it happens to parse:
   the newline is the commit mark.
5. **Corruption anywhere else** means a bad line before the last one. The store returns an error
   naming the file and line, and **leaves the file untouched**. The app starts, but every
   command reports the error and the page shows "Storage unavailable: …" and makes no writes.
   Nothing is ever dropped to get past damage. Repair is manual, with the rotated segments and
   snapshot as evidence.
6. **`seq` resumes** at `max(S, last good record's seq)`. Taking the snapshot's value matters
   right after a checkpoint, when the log is empty.

The page renders exactly what `load` returns. It has no cache to reconcile.

## Checkpoint and rotation

The log is compacted into a snapshot when it passes **1 MB or 2,000 records**, whichever comes
first. The check runs right after an append, which by then is already durable:

1. Serialize every day as `{ "seq": current, "days": {...} }`.
2. Write it to `stretch.snapshot.tmp`, `sync_all`, `rename` it over `stretch.snapshot`, and
   `sync_all` the directory so the rename itself is durable.
3. Rename `stretch.log` to `stretch.log.<seq>`, open a new empty `stretch.log`, and sync the
   directory.
4. Delete rotated segments beyond the two most recent.

A failed checkpoint isn't an error for the write that triggered it: the record is already
safe. The log just keeps growing, and the next append tries again.

### Crash windows

| Crash during or after… | State on disk | Recovery reads |
|---|---|---|
| writing `.tmp` | old snapshot + full log + partial `.tmp` | old snapshot + full log; `.tmp` deleted |
| the snapshot rename | new snapshot (seq = N) + full log | new snapshot; log records ≤ N skipped |
| the log rename, before the new log exists | new snapshot, no `stretch.log` | new snapshot; a missing log reads as empty |
| pruning old segments | an extra segment | same as a clean checkpoint; pruned next time |

Every window recovers to the same state. Tests simulate the second and third directly.

### Retention

Recovery reads only the snapshot and the live log. Rotated segments aren't needed for
correctness. They are kept (two of them) as a cheap audit trail for diagnosing damage by hand.

## Invariants

1. A line in `stretch.log` is a complete record exactly when it ends with `\n`.
2. `seq` strictly increases through the log, and every record in the live log either has
   `seq > snapshot.seq` or is a leftover from a checkpoint that crashed before rotation.
3. A write is acknowledged only after it's on stable storage (`F_FULLFSYNC`), in a file whose
   directory entry is already durable.
4. Only `store.rs` writes these files, through one `Store` behind one lock.
5. `days` in memory always equals snapshot + replay of the log. No other copy exists.

## What it doesn't do (deliberately)

- **No transactions across days.** The atomic unit is one record, which is one day. Nothing in
  the app changes two days at once.
- **No undo log.** Physical redo records only, so there's nothing to roll back.
- **No partial compaction.** A checkpoint rewrites every day. At a few KB per day that's years
  of history in a few MB. Revisit if snapshots get slow to write.
- **No group commit or batching.** One fsync per write. A few writes a minute don't justify the
  complexity.
- **No checksums per record.** A bit flip inside a line that still parses as JSON would go
  undetected. APFS doesn't checksum file data either. A CRC per line is the cheapest upgrade if
  this ever matters.
- **No multi-process safety.** One app instance owns the directory. A second instance would
  break invariant 4. Nothing locks against it today. An `flock` on the log would be the fix.

## Tests

`cargo test --manifest-path src-tauri/Cargo.toml` runs these, each in a fresh temp directory:

- append and reload; the last `day.put` for a date wins
- a day without a date is rejected before anything is written
- a torn final line is truncated, and appends afterwards produce a clean log
- a final line without its newline is torn even if it parses
- a corrupt middle line fails loudly and leaves the file byte-for-byte untouched
- an unknown op is corruption
- checkpoint + rotation (every 4 records, over 14), then replay from snapshot + log gives
  identical state; only two segments are kept
- a crash between the snapshot rename and the log rotation replays correctly
- a log missing after rotation reads as empty
- `seq` continues across restarts, including right after a checkpoint (from the snapshot)
- the store opens in a data directory that doesn't exist yet (the directory syncs themselves
  can't be tested without cutting power)

## History

The format was first written for the Roll app this project started as, whose `days.log` held
whole-day images of a block log. Stretch reuses the same code under its own name. The Roll
data stays in the old data directory (`com.ruoqi.switchcard/`) and isn't read by Stretch.
