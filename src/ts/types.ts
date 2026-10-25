// The records the page writes, and the bridge it writes them through. Rust treats every record
// as opaque JSON and reads only `date` (docs/storage.md), so these types are the schema of the
// log: a record in stretch.log is a DayRecord or the LabelsRecord.

// A task block, as stored. Times are ms since the epoch; `plan` is in minutes.
export interface BlockRecord {
  id: number;
  task: string;           // a typed name from before labels; old blocks still show it
  x: number;              // px: the block's left edge in the lane
  span: number;           // width in narrowest-block units, 1–4: how much attention it takes
  start: number;
  plan: number;
  created: number;
  end: number | null;     // set by Done, or frozen by tick when the next block in its queue began
  color: number;          // index into the palette
  label: number | null;   // a Label id
  note: string;
  bubbleY: number | null; // px: where the badge sits below the block's top; null for the default
  todo: number | null;    // a TodoRecord id on the same day: the TODO this block works on
}

// Something to finish that day: a small bright bubble whose tail's tip is on a spot in the lane.
// Blocks point at it by id (BlockRecord.todo). One with no text is never written.
export interface TodoRecord {
  id: number;
  x: number;              // px: the tail's tip, from the lane's left
  at: number;             // the tail's tip in time, ms
  text: string;
  color: number;          // index into the TODO palette
  done: boolean;
}

// 2–3 running blocks time-sliced on one core (switching.ts). `to` is null while it's on.
export interface SwitchGroup {
  id: number;
  blocks: number[];
  from: number;
  to: number | null;
}

// One logical day (4:30 am to 4:30 am; day.ts), keyed by `date`, "YYYY-MM-DD".
export interface DayRecord {
  date: string;
  blocks: BlockRecord[];
  switches: SwitchGroup[];
  todos: TodoRecord[];
  wake: number | null;    // when she got out of bed
  sleep: number | null;   // when she went to bed
  updatedAt: number;
}

export interface Label {
  id: number;
  name: string;
  archived: boolean;      // left out of the menu; blocks that wear it keep it
}

// The global label list, logged like a day under the date "labels".
export interface LabelsRecord {
  date: "labels";
  labels: Label[];
  updatedAt: number;
}

export type StretchRecord = DayRecord | LabelsRecord;

// What load() can return: everything ever written, including days from before a field existed.
// Blocks once had a `slot` index, or before that a `track` id into the day's `tracks`, instead
// of `x`; older fields may be missing.
export interface StoredBlock extends Partial<BlockRecord> {
  id: number;
  start: number;
  plan: number;
  created: number;
  slot?: number;
  track?: number;
}
export interface StoredDay extends Partial<Omit<DayRecord, "blocks" | "todos">> {
  blocks?: StoredBlock[];
  todos?: (Partial<TodoRecord> & { id: number; x: number; at: number })[];
  tracks?: { id: number }[];
}
export interface StoredLabels {
  date: "labels";
  labels?: Partial<Label>[];
}
export type StoredDays = Partial<Record<string, StoredDay | StoredLabels>>;

// window.stretch: the page's only connection to the platform it runs on.
export interface StretchBridge {
  load(): Promise<StoredDays>;
  putDay(record: StretchRecord): Promise<number>;   // resolves with the record's seq once durable
  panelVisible: boolean;
}

declare global {
  interface Window {
    stretch: StretchBridge;
  }
  interface DocumentEventMap {
    "stretch:visibility": CustomEvent<boolean>;
  }
}
