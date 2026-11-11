// The hang recorder's worker-side logic: the bounded record store and the
// state machine that turns the main thread's pings into stall, ack and
// suspect-event records. Run here over an in-memory file and a fake
// clock — the worker entry (`hangRecorder.worker.ts`) only binds these to
// origin-private storage and a timer.
//
// The two hangs this exists to tell apart read differently in the file:
// a blocked renderer stops the pings (`stall-start` / `stall-end`); a
// blocked host IPC thread leaves the pings running while the heartbeat
// goes unanswered (`ack-lost` / `ack-resumed`).

import { describe, expect, it } from "vitest";

import {
  ACK_LOST_MS,
  type ByteFile,
  RecorderCore,
  RecordStore,
  STALL_MS,
  type ToWorker,
} from "./hangRecorder";

/// An in-memory stand-in for an OPFS `FileSystemSyncAccessHandle`.
class MemFile implements ByteFile {
  bytes = new Uint8Array(0);
  flushes = 0;
  getSize(): number {
    return this.bytes.length;
  }
  read(buf: Uint8Array, { at }: { at: number }): number {
    const part = this.bytes.subarray(at, at + buf.length);
    buf.set(part);
    return part.length;
  }
  write(buf: Uint8Array, { at }: { at: number }): number {
    const size = Math.max(this.bytes.length, at + buf.length);
    const next = new Uint8Array(size);
    next.set(this.bytes);
    next.set(buf, at);
    this.bytes = next;
    return buf.length;
  }
  truncate(size: number): void {
    this.bytes = this.bytes.slice(0, size);
  }
  flush(): void {
    this.flushes += 1;
  }
  text(): string {
    return new TextDecoder().decode(this.bytes);
  }
}

const T0 = Date.UTC(2026, 10, 11, 19, 39, 0);
const iso = (ms: number) => new Date(ms).toISOString();

/// A core over `file` whose clock the test moves by hand.
function rig(file = new MemFile()) {
  let now = T0;
  const core = new RecorderCore(file, () => now);
  return {
    file,
    core,
    at(ms: number) {
      now = T0 + ms;
    },
    send(msg: ToWorker) {
      return core.handle(msg);
    },
    lines: () => file.text().split("\n").filter(Boolean),
  };
}

const ping = (ackWaitMs = 0, pending: { cmd: string; n: number; since: number }[] = []) =>
  ({ t: "ping", ackWaitMs, pending }) as const;

describe("RecordStore", () => {
  it("appends and flushes each record", () => {
    const file = new MemFile();
    const store = new RecordStore(file, 1024, () => T0);
    store.append("a\n");
    store.append("b\n");
    expect(store.readAll()).toBe("a\nb\n");
    expect(file.flushes).toBe(2);
  });

  it("drops the oldest whole records at the cap and says so", () => {
    const file = new MemFile();
    const store = new RecordStore(file, 100, () => T0);
    for (let i = 0; i < 20; i++) store.append(`record ${String(i).padStart(2, "0")}\n`);
    const text = store.readAll();
    expect(file.getSize()).toBeLessThanOrEqual(100);
    expect(text).toMatch(/record 19\n$/);
    expect(text).not.toMatch(/record 00/);
    expect(text).toMatch(/WARN recorder: store full, dropped \d+ oldest records/);
    // Whole lines only: nothing is left half-cut.
    expect(text.split("\n").filter(Boolean).every((l) => /^(record \d\d|\S+ WARN recorder:.*)$/.test(l))).toBe(true);
  });

  it("removes only what a drain handed over, keeping what arrived after", () => {
    const store = new RecordStore(new MemFile(), 1024, () => T0);
    store.append("one\n");
    const d = store.drain();
    expect(d).toMatchObject({ t: "drained", text: "one\n", bytes: 4 });
    store.append("two\n");
    store.commit(d.bytes, d.gen);
    expect(store.readAll()).toBe("two\n");
  });

  it("ignores a commit made stale by a trim, rather than cutting the wrong bytes", () => {
    const store = new RecordStore(new MemFile(), 60, () => T0);
    store.append("aaaaaaaaaa\n");
    const d = store.drain();
    for (let i = 0; i < 10; i++) store.append(`bbbbbbbbb${i}\n`);
    const before = store.readAll();
    store.commit(d.bytes, d.gen);
    expect(store.readAll()).toBe(before);
  });
});

describe("RecorderCore", () => {
  it("records a blocked main thread as a stall with its start, end and outstanding invokes", () => {
    const r = rig();
    r.send({ t: "hello", w: 1920, h: 1080, dpr: 1.25, visibility: "visible" });
    r.at(500);
    r.send(ping());
    r.at(1_000);
    r.send(ping(200, [{ cmd: "sample_signals", n: 3, since: T0 + 0 }]));
    // Pings stop. The worker's own timer keeps turning.
    r.at(1_000 + STALL_MS - 1);
    r.core.tick();
    expect(r.lines().some((l) => l.includes("stall-start"))).toBe(false);
    r.at(1_000 + STALL_MS + 500);
    r.core.tick();
    r.at(7_000);
    r.core.tick();
    r.send(ping());
    const lines = r.lines();
    expect(lines[0]).toBe(`${iso(T0)} INFO start: recorder armed; window 1920x1080, dpr 1.25, visible`);
    expect(lines).toContain(
      `${iso(T0 + 3_500)} WARN stall-start: main thread silent since ${iso(T0 + 1_000)}; ` +
        `host acks at last ping: current; pending >1s: sample_signals x3 since ${iso(T0)}`,
    );
    expect(lines).toContain(
      `${iso(T0 + 7_000)} INFO stall-end: main thread back after 6000 ms (silent since ${iso(T0 + 1_000)})`,
    );
    expect(lines.filter((l) => l.includes("stall-start"))).toHaveLength(1);
  });

  it("records a blocked host IPC thread as lost acks while the pings keep coming", () => {
    const r = rig();
    for (let t = 0; t <= 10_000; t += 500) {
      r.at(t);
      // The host stops answering at t = 2000: every beat since is pending.
      const wait = t > 2_000 ? t - 2_000 : 0;
      r.send(
        ping(wait, [
          { cmd: "save_project", n: 1, since: T0 + 1_900 },
          ...(wait > 0 ? [{ cmd: "report_js_heap", n: Math.floor(wait / 1000), since: T0 + 2_000 }] : []),
        ]),
      );
      r.core.tick();
    }
    r.at(10_500);
    r.send(ping(0));
    const lines = r.lines();
    expect(lines.some((l) => l.includes("stall-start"))).toBe(false);
    expect(lines).toContain(
      `${iso(T0 + 2_000 + ACK_LOST_MS)} WARN ack-lost: host has not acknowledged a heartbeat for ` +
        `${ACK_LOST_MS} ms while the main thread runs; pending >1s: save_project x1 since ` +
        `${iso(T0 + 1_900)}, report_js_heap x3 since ${iso(T0 + 2_000)}`,
    );
    expect(lines).toContain(
      `${iso(T0 + 10_500)} INFO ack-resumed: host acknowledging again after 8500 ms`,
    );
  });

  it("closes a stall left open by a killed process at the next launch", () => {
    const first = rig();
    first.send(ping());
    first.at(STALL_MS + 100);
    first.core.tick();
    // Killed here: no stall-end. The next launch opens the same file.
    const second = rig(first.file);
    const lines = second.lines();
    expect(lines.slice(-1)[0]).toBe(
      `${iso(T0)} WARN stall-end: never seen — the process ended (killed or crashed) during the ` +
        `stall recorded at ${iso(T0 + STALL_MS + 100)}; recorded at the next launch`,
    );
    // And it is in the first handover the new session makes.
    const drained = second.send({ t: "drain" });
    expect(drained && drained.t === "drained" && drained.text).toMatch(/stall-start[\s\S]*stall-end: never seen/);
  });

  it("closes an ack loss left open by a killed process at the next launch", () => {
    const first = rig();
    first.send(ping(ACK_LOST_MS));
    const second = rig(first.file);
    expect(second.lines().slice(-1)[0]).toMatch(/WARN ack-resumed: never seen — the process ended/);
  });

  it("leaves a cleanly closed episode alone at the next launch", () => {
    const first = rig();
    first.send(ping());
    first.at(STALL_MS + 100);
    first.core.tick();
    first.send(ping());
    const before = first.lines().length;
    expect(rig(first.file).lines()).toHaveLength(before);
  });

  it("coalesces a resize burst into one record, and records a burst cut off by a stall before the stall", () => {
    const r = rig();
    r.send(ping());
    for (let i = 0; i < 30; i++) {
      r.at(100 + i * 10);
      r.send({ t: "resize", w: 800 + i, h: 600 });
    }
    r.at(1_000);
    r.core.tick();
    expect(r.lines().filter((l) => l.includes(" resize:"))).toEqual([
      `${iso(T0 + 1_000)} INFO resize: 30 events from ${iso(T0 + 100)}, final 829x600`,
    ]);
    // A burst the main thread never finishes still lands, ahead of the stall.
    r.send({ t: "resize", w: 900, h: 700 });
    r.at(1_000 + STALL_MS);
    r.core.tick();
    const tail = r.lines().slice(-2);
    expect(tail[0]).toMatch(/INFO resize: 1 events from .*, final 900x700$/);
    expect(tail[1]).toMatch(/WARN stall-start:/);
  });

  it("records dpr and visibility changes, and opens no stall while hidden", () => {
    const r = rig();
    r.send(ping());
    r.send({ t: "dpr", dpr: 1.5 });
    r.send({ t: "visibility", state: "hidden" });
    // A hidden page's timers are throttled; silent pings are expected.
    r.at(60_000);
    r.core.tick();
    r.send({ t: "visibility", state: "visible" });
    r.at(60_500);
    r.core.tick();
    const lines = r.lines();
    expect(lines.some((l) => l.includes("stall-start"))).toBe(false);
    expect(lines).toContain(`${iso(T0)} INFO dpr: devicePixelRatio 1.5`);
    expect(lines).toContain(`${iso(T0)} INFO visibility: hidden`);
    expect(lines).toContain(`${iso(T0 + 60_000)} INFO visibility: visible`);
  });
});
