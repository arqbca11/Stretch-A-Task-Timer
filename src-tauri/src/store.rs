//! Day history as an append-only log of whole-day images plus a periodic snapshot.
//!
//! ```text
//! days.log          {"seq":N,"ts":..,"op":"day.put","day":{..}}\n   one record per line
//! days.snapshot     {"seq":N,"days":{"YYYY-MM-DD":{..}}}          last checkpoint
//! days.log.<seq>    rotated segments (the last two are kept)
//! game.json         Tetris state, replaced atomically, not logged
//! ```
//!
//! Recovery = snapshot + replay of log records with `seq > snapshot.seq`. Records are physical
//! (whole days), so replay is idempotent and the last `day.put` for a date wins. Day objects are
//! opaque JSON; only `date` is read here.
//!
//! The same code runs a second, independent log for Stretch mode under another name
//! (`stretch.log`, `stretch.snapshot`, `stretch.log.<seq>`); see [`Store::open_named`]. Each log
//! has its own store and its own lock, so each file still has exactly one writer.

use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// The day history's log name; files are `<name>.log`, `<name>.snapshot`, `<name>.log.<seq>`.
pub const DAYS: &str = "days";
/// Stretch mode's log, kept apart from the day history.
pub const STRETCH: &str = "stretch";
#[cfg(test)]
const LOG: &str = "days.log";
#[cfg(test)]
const SNAPSHOT: &str = "days.snapshot";
const GAME: &str = "game.json";
const GAME_TMP: &str = "game.json.tmp";
const KEEP_SEGMENTS: usize = 2;

#[derive(Debug)]
pub enum StoreError {
    Io(io::Error),
    /// A file is damaged somewhere other than a torn tail. Nothing has been modified.
    Corrupt { file: PathBuf, detail: String },
    /// The caller passed something that can't be stored (e.g. a day without a date).
    Invalid(String),
    /// A failed append could not be rolled back; writing more would bury garbage mid-log.
    Poisoned,
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Io(e) => write!(f, "storage I/O error: {e}"),
            StoreError::Corrupt { file, detail } => {
                write!(f, "{} is damaged ({detail}); it was left untouched", file.display())
            }
            StoreError::Invalid(m) => write!(f, "{m}"),
            StoreError::Poisoned => {
                write!(f, "an earlier write failed and could not be undone; restart the app")
            }
        }
    }
}

impl std::error::Error for StoreError {}

impl From<io::Error> for StoreError {
    fn from(e: io::Error) -> Self {
        StoreError::Io(e)
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_log_bytes: u64,
    pub max_log_records: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { max_log_bytes: 1 << 20, max_log_records: 2000 }
    }
}

pub struct Store {
    dir: PathBuf,
    /// `<name>.log`, `<name>.snapshot` and `<name>.snapshot.tmp`.
    log_name: String,
    snapshot_name: String,
    snapshot_tmp: String,
    limits: Limits,
    days: BTreeMap<String, Value>,
    /// Last sequence number written (or recovered). Never reused.
    seq: u64,
    snapshot_seq: u64,
    has_snapshot: bool,
    import_recorded: bool,
    log: File,
    /// Length of the log up to the end of the last record known to be complete.
    log_bytes: u64,
    log_records: u64,
    poisoned: bool,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn sync_dir(dir: &Path) -> io::Result<()> {
    File::open(dir)?.sync_all()
}

/// Write `bytes` to `dir/tmp`, fsync, rename over `dir/name`, fsync the directory.
fn replace_file(dir: &Path, tmp: &str, name: &str, bytes: &[u8]) -> io::Result<()> {
    let tmp_path = dir.join(tmp);
    let mut f = File::create(&tmp_path)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    drop(f);
    fs::rename(&tmp_path, dir.join(name))?;
    sync_dir(dir)
}

fn day_date(day: &Value) -> Option<&str> {
    day.get("date").and_then(Value::as_str).filter(|d| !d.is_empty())
}

impl Store {
    pub fn open(dir: impl Into<PathBuf>) -> Result<Store> {
        Store::open_with(dir, Limits::default())
    }

    pub fn open_with(dir: impl Into<PathBuf>, limits: Limits) -> Result<Store> {
        Store::open_named(dir, DAYS, limits)
    }

    /// Open the log called `name` in `dir`. Only the `days` store owns `game.json`.
    pub fn open_named(dir: impl Into<PathBuf>, name: &str, limits: Limits) -> Result<Store> {
        let dir = dir.into();
        let log_name = format!("{name}.log");
        let snapshot_name = format!("{name}.snapshot");
        let snapshot_tmp = format!("{name}.snapshot.tmp");
        fs::create_dir_all(&dir)?;
        // A leftover .tmp is a checkpoint that never got renamed: the old snapshot is still valid.
        let _ = fs::remove_file(dir.join(&snapshot_tmp));
        if name == DAYS {
            let _ = fs::remove_file(dir.join(GAME_TMP));
        }

        let mut days = BTreeMap::new();
        let mut snapshot_seq = 0;
        let snap_path = dir.join(&snapshot_name);
        let has_snapshot = snap_path.exists();
        if has_snapshot {
            let corrupt = |detail: String| StoreError::Corrupt { file: snap_path.clone(), detail };
            let v: Value = serde_json::from_slice(&fs::read(&snap_path)?)
                .map_err(|e| corrupt(format!("not valid JSON: {e}")))?;
            snapshot_seq = v
                .get("seq")
                .and_then(Value::as_u64)
                .ok_or_else(|| corrupt("missing seq".into()))?;
            let map = v
                .get("days")
                .and_then(Value::as_object)
                .ok_or_else(|| corrupt("missing days".into()))?;
            for (k, d) in map {
                days.insert(k.clone(), d.clone());
            }
        }

        let log_path = dir.join(&log_name);
        let replay = replay_log(&log_path, snapshot_seq, &mut days)?;

        let log = OpenOptions::new().append(true).create(true).open(&log_path)?;
        Ok(Store {
            dir,
            log_name,
            snapshot_name,
            snapshot_tmp,
            limits,
            days,
            seq: snapshot_seq.max(replay.last_seq),
            snapshot_seq,
            has_snapshot,
            import_recorded: replay.import_recorded,
            log,
            log_bytes: replay.good_len,
            log_records: replay.records,
            poisoned: false,
        })
    }

    pub fn days(&self) -> &BTreeMap<String, Value> {
        &self.days
    }

    #[cfg(test)]
    pub fn seq(&self) -> u64 {
        self.seq
    }

    /// Log the full image of one day. Returns once the record is on stable storage.
    pub fn put_day(&mut self, day: Value) -> Result<u64> {
        let date = day_date(&day)
            .ok_or_else(|| StoreError::Invalid("day has no date".into()))?
            .to_owned();
        let seq = self.append(json!({ "seq": self.seq + 1, "ts": now_ms(), "op": "day.put", "day": &day }))?;
        self.days.insert(date, day);
        self.maybe_checkpoint();
        Ok(seq)
    }

    fn append(&mut self, record: Value) -> Result<u64> {
        if self.poisoned {
            return Err(StoreError::Poisoned);
        }
        let mut line = serde_json::to_vec(&record).map_err(|e| StoreError::Invalid(e.to_string()))?;
        line.push(b'\n');
        if let Err(e) = self.log.write_all(&line).and_then(|_| self.log.sync_all()) {
            // Part of the line may be in the file. Cut it off now, or the next good append
            // would turn this torn tail into a corrupt line in the middle of the log.
            if self.log.set_len(self.log_bytes).and_then(|_| self.log.sync_all()).is_err() {
                self.poisoned = true;
            }
            return Err(e.into());
        }
        self.seq += 1;
        self.log_bytes += line.len() as u64;
        self.log_records += 1;
        Ok(self.seq)
    }

    fn maybe_checkpoint(&mut self) {
        if self.log_bytes >= self.limits.max_log_bytes || self.log_records >= self.limits.max_log_records {
            // The record that triggered this is already durable in the log. A failed checkpoint
            // only means the log keeps growing; the next append tries again.
            if let Err(e) = self.checkpoint() {
                eprintln!("stretch: checkpoint failed: {e}");
            }
        }
    }

    /// Snapshot everything up to `seq`, then rotate the log.
    ///
    /// Crash windows: before the snapshot rename, the old snapshot + full log are intact. After
    /// it but before the log is rotated, replay skips the records with `seq <= snapshot.seq`.
    /// After `days.log` is renamed but before a new one exists, a missing log reads as empty.
    pub fn checkpoint(&mut self) -> Result<()> {
        if self.poisoned {
            return Err(StoreError::Poisoned);
        }
        let days: Map<String, Value> = self.days.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let bytes = serde_json::to_vec(&json!({ "seq": self.seq, "days": days }))
            .map_err(|e| StoreError::Invalid(e.to_string()))?;
        replace_file(&self.dir, &self.snapshot_tmp, &self.snapshot_name, &bytes)?;
        self.snapshot_seq = self.seq;
        self.has_snapshot = true;

        let log_path = self.dir.join(&self.log_name);
        fs::rename(&log_path, self.dir.join(format!("{}.{}", self.log_name, self.seq)))?;
        self.log = OpenOptions::new().append(true).create(true).open(&log_path)?;
        sync_dir(&self.dir)?;
        self.log_bytes = 0;
        self.log_records = 0;
        self.prune_segments()?;
        Ok(())
    }

    fn prune_segments(&self) -> io::Result<()> {
        let prefix = format!("{}.", self.log_name);
        let mut segs: Vec<(u64, PathBuf)> = fs::read_dir(&self.dir)?
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let name = e.file_name().into_string().ok()?;
                let n = name.strip_prefix(&prefix)?.parse::<u64>().ok()?;
                Some((n, e.path()))
            })
            .collect();
        segs.sort_by_key(|(n, _)| std::cmp::Reverse(*n));
        for (_, p) in segs.into_iter().skip(KEEP_SEGMENTS) {
            fs::remove_file(p)?;
        }
        Ok(())
    }

    /// True until a seed import has fully completed. The marker is written after the imported
    /// days, so a crash part-way leaves no marker and the import is redone (idempotently).
    pub fn needs_import(&self) -> bool {
        !self.has_snapshot && !self.import_recorded
    }

    /// One-time import of a web export (`{days: {date: day}, game: {..}, ...}`). With `None`
    /// (no seed bundled), only the marker is written, so a seed added later can't overwrite
    /// days logged in the meantime. Returns whether anything ran.
    pub fn import_seed(&mut self, seed: Option<&Value>) -> Result<bool> {
        if !self.needs_import() {
            return Ok(false);
        }
        let mut source = "none";
        if let Some(seed) = seed {
            source = "seed-export";
            if let Some(days) = seed.get("days").and_then(Value::as_object) {
                for (key, day) in days {
                    if day_date(day) != Some(key.as_str()) {
                        return Err(StoreError::Invalid(format!("seed day {key} has a mismatched date")));
                    }
                    self.append(json!({ "seq": self.seq + 1, "ts": now_ms(), "op": "day.put", "day": day }))?;
                    self.days.insert(key.clone(), day.clone());
                }
            }
            if let Some(game) = seed.get("game").filter(|g| g.is_object()) {
                self.put_game(game)?;
            }
        }
        self.append(json!({ "seq": self.seq + 1, "ts": now_ms(), "op": "import", "source": source }))?;
        self.import_recorded = true;
        self.checkpoint()?;
        Ok(true)
    }

    pub fn load_game(&self) -> Result<Option<Value>> {
        let path = self.dir.join(GAME);
        match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|e| StoreError::Corrupt { file: path, detail: format!("not valid JSON: {e}") }),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn put_game(&mut self, game: &Value) -> Result<()> {
        let bytes = serde_json::to_vec(game).map_err(|e| StoreError::Invalid(e.to_string()))?;
        replace_file(&self.dir, GAME_TMP, GAME, &bytes)?;
        Ok(())
    }
}

struct Replay {
    last_seq: u64,
    good_len: u64,
    records: u64,
    import_recorded: bool,
}

/// Apply `days.log` on top of the snapshot. A torn final line is truncated away; any other bad
/// line is corruption and aborts without touching the file.
fn replay_log(path: &Path, snapshot_seq: u64, days: &mut BTreeMap<String, Value>) -> Result<Replay> {
    let mut out = Replay { last_seq: 0, good_len: 0, records: 0, import_recorded: false };
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.into()),
    };

    let corrupt = |line_no: usize, detail: String| StoreError::Corrupt {
        file: path.to_path_buf(),
        detail: format!("line {line_no}: {detail}"),
    };

    let mut pos = 0usize;
    let mut line_no = 0usize;
    let mut torn = false;
    while pos < bytes.len() {
        line_no += 1;
        let (line, next, terminated) = match bytes[pos..].iter().position(|&b| b == b'\n') {
            Some(i) => (&bytes[pos..pos + i], pos + i + 1, true),
            None => (&bytes[pos..], bytes.len(), false),
        };
        let is_last = next >= bytes.len();
        // A line without its newline was never acknowledged, even if it happens to parse.
        let parsed = if terminated { serde_json::from_slice::<Value>(line).ok() } else { None };
        let Some(rec) = parsed else {
            if is_last {
                torn = true;
                break;
            }
            return Err(corrupt(line_no, "not a complete JSON record".into()));
        };

        let seq = rec
            .get("seq")
            .and_then(Value::as_u64)
            .ok_or_else(|| corrupt(line_no, "record has no seq".into()))?;
        if seq <= out.last_seq {
            return Err(corrupt(line_no, format!("seq {seq} does not follow {}", out.last_seq)));
        }
        match rec.get("op").and_then(Value::as_str) {
            Some("day.put") => {
                let day = rec.get("day").ok_or_else(|| corrupt(line_no, "day.put without day".into()))?;
                let date = day_date(day).ok_or_else(|| corrupt(line_no, "day without date".into()))?;
                if seq > snapshot_seq {
                    days.insert(date.to_owned(), day.clone());
                }
            }
            Some("import") => out.import_recorded = true,
            other => return Err(corrupt(line_no, format!("unknown op {other:?}"))),
        }
        out.last_seq = seq;
        out.good_len = next as u64;
        out.records += 1;
        pos = next;
    }

    if torn {
        let f = OpenOptions::new().write(true).open(path)?;
        f.set_len(out.good_len)?;
        f.sync_all()?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn day(date: &str, n: u64) -> Value {
        json!({ "date": date, "entries": [{ "id": format!("b{n}"), "task": "Leetcode", "worked": n }], "updatedAt": n })
    }

    fn log_text(dir: &Path) -> String {
        fs::read_to_string(dir.join(LOG)).unwrap()
    }

    #[test]
    fn append_and_reload() {
        let tmp = TempDir::new().unwrap();
        {
            let mut s = Store::open(tmp.path()).unwrap();
            s.put_day(day("2026-09-25", 1)).unwrap();
            s.put_day(day("2026-09-26", 2)).unwrap();
            s.put_day(day("2026-09-25", 3)).unwrap(); // last put for a date wins
        }
        let s = Store::open(tmp.path()).unwrap();
        assert_eq!(s.days().len(), 2);
        assert_eq!(s.days()["2026-09-25"], day("2026-09-25", 3));
        assert_eq!(s.days()["2026-09-26"], day("2026-09-26", 2));
        assert_eq!(log_text(tmp.path()).lines().count(), 3);
    }

    #[test]
    fn rejects_day_without_date() {
        let tmp = TempDir::new().unwrap();
        let mut s = Store::open(tmp.path()).unwrap();
        assert!(matches!(s.put_day(json!({ "entries": [] })), Err(StoreError::Invalid(_))));
        assert_eq!(s.seq(), 0);
    }

    #[test]
    fn torn_final_line_is_truncated() {
        let tmp = TempDir::new().unwrap();
        {
            let mut s = Store::open(tmp.path()).unwrap();
            s.put_day(day("2026-09-25", 1)).unwrap();
            s.put_day(day("2026-09-26", 2)).unwrap();
        }
        let good = fs::metadata(tmp.path().join(LOG)).unwrap().len();
        let mut f = OpenOptions::new().append(true).open(tmp.path().join(LOG)).unwrap();
        f.write_all(br#"{"seq":3,"ts":1,"op":"day.put","day":{"date":"2026-09"#).unwrap();
        drop(f);

        let mut s = Store::open(tmp.path()).unwrap();
        assert_eq!(fs::metadata(tmp.path().join(LOG)).unwrap().len(), good);
        assert_eq!(s.days().len(), 2);
        assert_eq!(s.seq(), 2);
        // Appending after recovery yields a clean log.
        s.put_day(day("2026-09-27", 3)).unwrap();
        drop(s);
        let s = Store::open(tmp.path()).unwrap();
        assert_eq!(s.days().len(), 3);
    }

    #[test]
    fn final_line_without_newline_is_torn_even_if_it_parses() {
        let tmp = TempDir::new().unwrap();
        {
            let mut s = Store::open(tmp.path()).unwrap();
            s.put_day(day("2026-09-25", 1)).unwrap();
        }
        let good = fs::metadata(tmp.path().join(LOG)).unwrap().len();
        let mut f = OpenOptions::new().append(true).open(tmp.path().join(LOG)).unwrap();
        f.write_all(json!({ "seq": 2, "ts": 1, "op": "day.put", "day": day("2026-09-26", 2) }).to_string().as_bytes())
            .unwrap();
        drop(f);

        let s = Store::open(tmp.path()).unwrap();
        assert_eq!(fs::metadata(tmp.path().join(LOG)).unwrap().len(), good);
        assert!(!s.days().contains_key("2026-09-26"));
    }

    #[test]
    fn corrupt_middle_line_fails_and_leaves_file_untouched() {
        let tmp = TempDir::new().unwrap();
        {
            let mut s = Store::open(tmp.path()).unwrap();
            for n in 1..=3 {
                s.put_day(day(&format!("2026-09-2{n}"), n)).unwrap();
            }
        }
        let text = log_text(tmp.path());
        let mut lines: Vec<&str> = text.lines().collect();
        lines[1] = "{\"seq\":2,\"ts\":1,\"op\":\"day.p";
        let damaged = lines.join("\n") + "\n";
        fs::write(tmp.path().join(LOG), &damaged).unwrap();

        match Store::open(tmp.path()) {
            Err(StoreError::Corrupt { detail, .. }) => assert!(detail.contains("line 2"), "{detail}"),
            Err(e) => panic!("expected corruption, got {e}"),
            Ok(_) => panic!("expected corruption, got a store"),
        }
        assert_eq!(log_text(tmp.path()), damaged);
    }

    #[test]
    fn checkpoint_rotation_and_replay_match() {
        let tmp = TempDir::new().unwrap();
        let limits = Limits { max_log_bytes: u64::MAX, max_log_records: 4 };
        let mut s = Store::open_with(tmp.path(), limits).unwrap();
        for n in 1..=14u64 {
            s.put_day(day(&format!("2026-09-{:02}", 10 + n % 5), n)).unwrap();
        }
        // 14 records with a checkpoint every 4: segments at 4, 8, 12; two are kept; 2 left in the log.
        let expected = s.days().clone();
        drop(s);

        assert!(tmp.path().join(SNAPSHOT).exists());
        assert!(!tmp.path().join("days.log.4").exists());
        assert!(tmp.path().join("days.log.8").exists());
        assert!(tmp.path().join("days.log.12").exists());
        assert_eq!(log_text(tmp.path()).lines().count(), 2);

        let s = Store::open_with(tmp.path(), limits).unwrap();
        assert_eq!(s.days(), &expected);
        assert_eq!(s.seq(), 14);
    }

    #[test]
    fn crash_between_snapshot_and_rotation_replays_correctly() {
        let tmp = TempDir::new().unwrap();
        let mut s = Store::open(tmp.path()).unwrap();
        s.put_day(day("2026-09-25", 1)).unwrap();
        s.put_day(day("2026-09-26", 2)).unwrap();
        let expected = s.days().clone();
        // Simulate: snapshot written, then crash before the log was rotated.
        let days: Map<String, Value> = expected.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        fs::write(tmp.path().join(SNAPSHOT), json!({ "seq": 2, "days": days }).to_string()).unwrap();
        drop(s);

        let mut s = Store::open(tmp.path()).unwrap();
        assert_eq!(s.days(), &expected);
        assert_eq!(s.put_day(day("2026-09-27", 3)).unwrap(), 3);
    }

    #[test]
    fn missing_log_after_rotation_reads_as_empty() {
        let tmp = TempDir::new().unwrap();
        let mut s = Store::open(tmp.path()).unwrap();
        s.put_day(day("2026-09-25", 1)).unwrap();
        s.checkpoint().unwrap();
        drop(s);
        fs::remove_file(tmp.path().join(LOG)).unwrap();

        let mut s = Store::open(tmp.path()).unwrap();
        assert_eq!(s.days().len(), 1);
        assert_eq!(s.put_day(day("2026-09-26", 2)).unwrap(), 2);
    }

    #[test]
    fn named_stores_keep_separate_files() {
        let tmp = TempDir::new().unwrap();
        let small = Limits { max_log_bytes: 1 << 20, max_log_records: 3 };
        {
            let mut days = Store::open(tmp.path()).unwrap();
            let mut stretch = Store::open_named(tmp.path(), STRETCH, small).unwrap();
            days.put_day(day("2026-10-04", 1)).unwrap();
            for n in 1..=4 {
                stretch.put_day(json!({ "date": "2026-10-04", "blocks": [{ "id": n }] })).unwrap();
            }
        }
        // The stretch log checkpointed and rotated under its own name; days.log is untouched.
        assert!(tmp.path().join("stretch.snapshot").exists());
        assert!(tmp.path().join("stretch.log.3").exists());
        assert!(!tmp.path().join(SNAPSHOT).exists());
        assert_eq!(log_text(tmp.path()).lines().count(), 1);

        let days = Store::open(tmp.path()).unwrap();
        let stretch = Store::open_named(tmp.path(), STRETCH, small).unwrap();
        assert_eq!(days.days()["2026-10-04"], day("2026-10-04", 1));
        assert_eq!(stretch.days()["2026-10-04"]["blocks"][0]["id"], 4);
        assert_eq!(stretch.seq(), 4);
    }

    #[test]
    fn seq_continues_across_restarts() {
        let tmp = TempDir::new().unwrap();
        {
            let mut s = Store::open(tmp.path()).unwrap();
            s.put_day(day("2026-09-25", 1)).unwrap();
            s.put_day(day("2026-09-26", 2)).unwrap();
        }
        {
            let mut s = Store::open(tmp.path()).unwrap();
            assert_eq!(s.put_day(day("2026-09-27", 3)).unwrap(), 3);
            s.checkpoint().unwrap(); // log is now empty; seq must come from the snapshot
        }
        let mut s = Store::open(tmp.path()).unwrap();
        assert_eq!(s.seq(), 3);
        assert_eq!(s.put_day(day("2026-09-28", 4)).unwrap(), 4);
    }

    #[test]
    fn game_round_trip() {
        let tmp = TempDir::new().unwrap();
        let mut s = Store::open(tmp.path()).unwrap();
        assert_eq!(s.load_game().unwrap(), None);
        s.put_game(&json!({ "total": 10 })).unwrap();
        s.put_game(&json!({ "total": 20 })).unwrap();
        assert_eq!(s.load_game().unwrap(), Some(json!({ "total": 20 })));
        assert!(!tmp.path().join(GAME_TMP).exists());
    }

    fn seed() -> Value {
        json!({
            "exportedAt": "2026-10-03T01:40:00Z",
            "source": "test",
            "notes": "unknown keys are ignored",
            "days": { "2026-09-25": day("2026-09-25", 1), "2026-09-26": day("2026-09-26", 2) },
            "game": { "total": 8430 }
        })
    }

    #[test]
    fn migration_runs_once() {
        let tmp = TempDir::new().unwrap();
        let mut s = Store::open(tmp.path()).unwrap();
        assert!(s.needs_import());
        assert!(s.import_seed(Some(&seed())).unwrap());
        let after_first = (s.days().clone(), s.seq());
        assert!(!s.import_seed(Some(&seed())).unwrap());
        drop(s);

        let mut s = Store::open(tmp.path()).unwrap();
        assert!(!s.needs_import());
        assert!(!s.import_seed(Some(&seed())).unwrap());
        assert_eq!((s.days().clone(), s.seq()), after_first);
        assert_eq!(s.days().len(), 2);
        assert_eq!(s.load_game().unwrap(), Some(json!({ "total": 8430 })));
    }

    #[test]
    fn migration_does_not_overwrite_later_edits() {
        let tmp = TempDir::new().unwrap();
        let mut s = Store::open(tmp.path()).unwrap();
        s.import_seed(Some(&seed())).unwrap();
        s.put_day(day("2026-09-25", 99)).unwrap();
        drop(s);
        let mut s = Store::open(tmp.path()).unwrap();
        s.import_seed(Some(&seed())).unwrap();
        assert_eq!(s.days()["2026-09-25"], day("2026-09-25", 99));
    }

    #[test]
    fn interrupted_migration_is_redone() {
        let tmp = TempDir::new().unwrap();
        {
            // Crash after the first imported day: no marker, no snapshot.
            let mut s = Store::open(tmp.path()).unwrap();
            s.put_day(day("2026-09-25", 1)).unwrap();
        }
        let mut s = Store::open(tmp.path()).unwrap();
        assert!(s.needs_import());
        assert!(s.import_seed(Some(&seed())).unwrap());
        assert_eq!(s.days().len(), 2);
        assert!(!s.needs_import());
    }

    #[test]
    fn no_seed_still_marks_import_done() {
        let tmp = TempDir::new().unwrap();
        let mut s = Store::open(tmp.path()).unwrap();
        assert!(s.import_seed(None).unwrap());
        assert!(s.days().is_empty());
        drop(s);
        let mut s = Store::open(tmp.path()).unwrap();
        assert!(!s.import_seed(Some(&seed())).unwrap());
        assert!(s.days().is_empty());
    }
}
