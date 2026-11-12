// The hang recorder's worker-side logic, kept free of the Worker and OPFS
// APIs so it runs under test: a bounded record store over a byte file,
// and the state machine that turns the main thread's pings into records.
// `hangRecorder.worker.ts` binds it to origin-private storage and a timer;
// `hangRecorderClient.ts` is the main-thread side.
//
// Why a worker: the host's only frontend-liveness evidence is the 1 Hz
// heartbeat (`report_js_heap`, `crash.rs`), and its absence cannot say
// whether the renderer's main thread stopped sending or the host's IPC
// thread stopped answering. A worker has its own thread and its own
// timer, so it keeps recording through a main-thread stall, and it writes
// to storage the host does not have to be alive to receive. The two
// hangs read differently in what it leaves:
//
// - main thread blocked → the pings stop: `stall-start` … `stall-end`;
// - host IPC thread blocked → the pings continue and say the heartbeat
//   is going unanswered: `ack-lost` … `ack-resumed`.
//
// Each record is one line, `<UTC ISO-8601 ms> <LEVEL> <kind>: <text>`,
// the stamp spelled as `cannet.log` spells its own, so the two files
// line up by eye. The store is handed to the host while the app is
// healthy and written to `frontend.log`; a hang ended by a kill is
// handed over by the next launch, which first closes any episode the
// dead process left open.

/// Worker timer period: stall detection and resize-burst flushing.
export const TICK_MS = 500;
/// How often the main thread pings the worker.
export const PING_MS = 500;
/// Main-thread silence that opens a stall. Above the ~1 s lag a loaded
/// but healthy capture shows, below the host's own 5 s verdict.
export const STALL_MS = 2_000;
/// Oldest unanswered heartbeat at which the host counts as not
/// acknowledging. The heartbeat is 1 Hz and answered in well under that.
export const ACK_LOST_MS = 3_000;
/// An invoke outstanding longer than this is listed by name in a ping.
export const PENDING_REPORT_MS = 1_000;
/// Quiet time that ends a resize burst.
export const RESIZE_QUIET_MS = 500;
/// The store's size bound. A record is ~100–300 bytes, so this holds a
/// thousand or more — days of a healthy session's few records, and many
/// handovers' worth if the host stops taking them.
export const STORE_CAP_BYTES = 256 * 1024;

/// One command's outstanding calls (see `ipc.ts`).
export type PendingGroup = { cmd: string; n: number; since: number };

/// Main thread → worker.
export type ToWorker =
  | { t: "hello"; w: number; h: number; dpr: number; visibility: string }
  | { t: "ping"; ackWaitMs: number; pending: PendingGroup[] }
  | { t: "resize"; w: number; h: number }
  | { t: "dpr"; dpr: number }
  | { t: "visibility"; state: string }
  | { t: "drain" }
  | { t: "commit"; bytes: number; gen: number };

/// Worker → main thread.
export type FromWorker =
  | { t: "ready" }
  | { t: "unavailable"; reason: string }
  | { t: "drained"; text: string; bytes: number; gen: number };

/// The slice of an OPFS `FileSystemSyncAccessHandle` the store uses.
export interface ByteFile {
  getSize(): number;
  read(buf: Uint8Array, opts: { at: number }): number;
  write(buf: Uint8Array, opts: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
}

const iso = (ms: number) => new Date(ms).toISOString();

/// One record line.
export function formatRecord(at: number, level: "INFO" | "WARN", kind: string, text: string): string {
  return `${iso(at)} ${level} ${kind}: ${text}\n`;
}

function describePending(groups: PendingGroup[]): string {
  if (groups.length === 0) return "none";
  return groups.map((g) => `${g.cmd} x${g.n} since ${iso(g.since)}`).join(", ");
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/// A size-bounded, append-only log of records over a byte file. Every
/// append is flushed, so what a kill leaves is what was written.
///
/// Handover is two steps so a failed one loses nothing: `drain` reads the
/// whole store, and `commit` removes that prefix once the host has it.
/// Trimming at the cap rewrites the file, which invalidates an
/// outstanding drain (`gen`); its commit is then ignored and the records
/// go again, so the host may see a few twice but never loses one.
export class RecordStore {
  private gen = 0;

  constructor(
    private readonly file: ByteFile,
    private readonly cap: number,
    private readonly now: () => number,
  ) {}

  append(record: string): void {
    const bytes = encoder.encode(record);
    if (this.file.getSize() + bytes.length > this.cap) this.trim(bytes.length);
    this.file.write(bytes, { at: this.file.getSize() });
    this.file.flush();
  }

  readAll(): string {
    return decoder.decode(this.readFrom(0));
  }

  drain(): FromWorker & { t: "drained" } {
    const bytes = this.readFrom(0);
    return { t: "drained", text: decoder.decode(bytes), bytes: bytes.length, gen: this.gen };
  }

  commit(bytes: number, gen: number): void {
    if (gen !== this.gen) return;
    this.rewrite(this.readFrom(bytes));
  }

  private readFrom(at: number): Uint8Array {
    const buf = new Uint8Array(Math.max(0, this.file.getSize() - at));
    this.file.read(buf, { at });
    return buf;
  }

  private rewrite(bytes: Uint8Array): void {
    this.file.truncate(0);
    this.file.write(bytes, { at: 0 });
    this.file.flush();
  }

  /// Drop the oldest whole records until the store and an `incoming`
  /// record fit in three quarters of the cap (so a full store trims once
  /// per many appends, not on every one), and say so in the store.
  private trim(incoming: number): void {
    const lines = this.readAll().split("\n").filter(Boolean);
    const budget = Math.floor((this.cap * 3) / 4) - incoming;
    let size = lines.reduce((sum, l) => sum + encoder.encode(l).length + 1, 0);
    let dropped = 0;
    // Room for the note itself, which names the count.
    const noteSize = () =>
      encoder.encode(formatRecord(this.now(), "WARN", "recorder", `store full, dropped ${dropped} oldest records`)).length;
    while (dropped < lines.length && size + noteSize() > budget) {
      size -= encoder.encode(lines[dropped]).length + 1;
      dropped += 1;
    }
    const note = formatRecord(this.now(), "WARN", "recorder", `store full, dropped ${dropped} oldest records`);
    const kept = lines.slice(dropped).map((l) => `${l}\n`).join("");
    this.rewrite(encoder.encode(note + kept));
    this.gen += 1;
  }
}

/// The closing records for any episode a previous process left open —
/// a stall or an ack loss it never saw the end of, because it was killed
/// (or crashed) inside it.
export function closeOpenEpisodes(text: string, now: number): string[] {
  let stall: string | undefined;
  let ack: string | undefined;
  for (const line of text.split("\n")) {
    const m = /^(\S+) \S+ ([\w-]+):/.exec(line);
    if (!m) continue;
    const [, at, kind] = m;
    if (kind === "stall-start") stall = at;
    else if (kind === "stall-end") stall = undefined;
    else if (kind === "ack-lost") ack = at;
    else if (kind === "ack-resumed") ack = undefined;
  }
  const out: string[] = [];
  const ended = "never seen — the process ended (killed or crashed) during the";
  if (stall) {
    out.push(formatRecord(now, "WARN", "stall-end", `${ended} stall recorded at ${stall}; recorded at the next launch`));
  }
  if (ack) {
    out.push(formatRecord(now, "WARN", "ack-resumed", `${ended} ack loss recorded at ${ack}; recorded at the next launch`));
  }
  return out;
}

/// The worker's state machine. `handle` takes each message from the main
/// thread (any message is proof that thread is turning), `tick` runs on
/// the worker's own timer.
export class RecorderCore {
  private readonly store: RecordStore;
  /// When the main thread was last heard from; `null` before it ever was.
  private lastHeard: number | null = null;
  private lastPing: { ackWaitMs: number; pending: PendingGroup[] } = { ackWaitMs: 0, pending: [] };
  /// The `lastHeard` an open stall began at.
  private stallSince: number | null = null;
  /// When the oldest unanswered heartbeat of an open ack loss was sent.
  private ackLostSince: number | null = null;
  private visible = true;
  private resize: { count: number; first: number; last: number; w: number; h: number } | null = null;

  constructor(
    file: ByteFile,
    private readonly now: () => number,
    cap = STORE_CAP_BYTES,
  ) {
    this.store = new RecordStore(file, cap, now);
    const t = now();
    for (const r of closeOpenEpisodes(this.store.readAll(), t)) this.store.append(r);
  }

  handle(msg: ToWorker): FromWorker | undefined {
    const now = this.now();
    if (this.stallSince !== null) {
      this.record(now, "INFO", "stall-end", `main thread back after ${now - this.stallSince} ms (silent since ${iso(this.stallSince)})`);
      this.stallSince = null;
    }
    this.lastHeard = now;
    switch (msg.t) {
      case "hello":
        this.visible = msg.visibility !== "hidden";
        this.record(now, "INFO", "start", `recorder armed; window ${msg.w}x${msg.h}, dpr ${msg.dpr}, ${msg.visibility}`);
        return undefined;
      case "ping":
        this.lastPing = { ackWaitMs: msg.ackWaitMs, pending: msg.pending };
        if (msg.ackWaitMs >= ACK_LOST_MS && this.ackLostSince === null) {
          this.ackLostSince = now - msg.ackWaitMs;
          this.record(
            now,
            "WARN",
            "ack-lost",
            `host has not acknowledged a heartbeat for ${msg.ackWaitMs} ms while the main thread runs; ` +
              `pending >1s: ${describePending(msg.pending)}`,
          );
        } else if (msg.ackWaitMs < ACK_LOST_MS && this.ackLostSince !== null) {
          this.record(now, "INFO", "ack-resumed", `host acknowledging again after ${now - this.ackLostSince} ms`);
          this.ackLostSince = null;
        }
        return undefined;
      case "resize":
        if (this.resize) {
          this.resize.count += 1;
          Object.assign(this.resize, { last: now, w: msg.w, h: msg.h });
        } else {
          this.resize = { count: 1, first: now, last: now, w: msg.w, h: msg.h };
        }
        return undefined;
      case "dpr":
        this.record(now, "INFO", "dpr", `devicePixelRatio ${msg.dpr}`);
        return undefined;
      case "visibility":
        this.visible = msg.state !== "hidden";
        this.record(now, "INFO", "visibility", msg.state);
        return undefined;
      case "drain":
        return this.store.drain();
      case "commit":
        this.store.commit(msg.bytes, msg.gen);
        return undefined;
    }
  }

  tick(): void {
    const now = this.now();
    const burst = this.resize;
    if (burst && now - burst.last >= RESIZE_QUIET_MS) {
      this.record(now, "INFO", "resize", `${burst.count} events from ${iso(burst.first)}, final ${burst.w}x${burst.h}`);
      this.resize = null;
    }
    // A hidden page's timers are throttled by the browser (to once a
    // minute after a while), so its silence is not a stall.
    if (this.lastHeard === null || this.stallSince !== null || !this.visible) return;
    if (now - this.lastHeard < STALL_MS) return;
    this.stallSince = this.lastHeard;
    const { ackWaitMs, pending } = this.lastPing;
    const acks = ackWaitMs >= ACK_LOST_MS ? `lost for ${ackWaitMs} ms` : "current";
    this.record(
      now,
      "WARN",
      "stall-start",
      `main thread silent since ${iso(this.lastHeard)}; host acks at last ping: ${acks}; ` +
        `pending >1s: ${describePending(pending)}`,
    );
  }

  private record(at: number, level: "INFO" | "WARN", kind: string, text: string): void {
    this.store.append(formatRecord(at, level, kind, text));
  }
}
