// @vitest-environment jsdom
//
// The main-thread half of the hang recorder: it pings the worker with
// what the host owes it (the oldest unanswered heartbeat, every invoke
// outstanding past a second), forwards the suspect window events, and
// hands the worker's records to the host for `frontend.log` while the
// app is healthy. Run against a fake worker; the real one is a thin
// binding of `hangRecorder.ts` (tested on its own) to OPFS.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

import { ACK_LOST_MS, type FromWorker, PING_MS, type ToWorker } from "./hangRecorder";
import { HANDOFF_MS, startHangRecorder, type WorkerPort } from "./hangRecorderClient";
import { invoke as ipcInvoke } from "./ipc";

class FakeWorker implements WorkerPort {
  posted: ToWorker[] = [];
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminate = vi.fn();
  postMessage(m: ToWorker): void {
    this.posted.push(m);
  }
  deliver(m: FromWorker): void {
    this.onmessage?.({ data: m } as MessageEvent<FromWorker>);
  }
  of<K extends ToWorker["t"]>(t: K): Extract<ToWorker, { t: K }>[] {
    return this.posted.filter((m): m is Extract<ToWorker, { t: K }> => m.t === t);
  }
}

const calls = (cmd: string) => vi.mocked(invoke).mock.calls.filter((c) => c[0] === cmd);

let stop: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.mocked(invoke).mockImplementation(async () => undefined);
  window.matchMedia = vi.fn(
    () => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList,
  );
});

afterEach(() => {
  stop();
  vi.useRealTimers();
  vi.mocked(invoke).mockReset();
});

describe("startHangRecorder", () => {
  it("greets the worker once it is ready, then pings with what the host owes", () => {
    const w = new FakeWorker();
    stop = startHangRecorder(() => w);
    expect(w.of("hello")).toEqual([]);
    w.deliver({ t: "ready" });
    expect(w.of("hello")).toEqual([
      { t: "hello", w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, visibility: document.visibilityState },
    ]);
    // A heartbeat the host never answers, and a slow command beside it.
    vi.mocked(invoke).mockImplementation(() => new Promise(() => {}));
    void ipcInvoke("report_js_heap", { bytes: 0 });
    void ipcInvoke("save_project");
    vi.advanceTimersByTime(PING_MS);
    // Under a second old: owed, but not yet worth naming.
    expect(w.of("ping").slice(-1)[0]).toEqual({ t: "ping", ackWaitMs: PING_MS, pending: [] });
    vi.advanceTimersByTime(ACK_LOST_MS);
    expect(w.of("ping").slice(-1)[0]).toEqual({
      t: "ping",
      ackWaitMs: PING_MS + ACK_LOST_MS,
      pending: [
        { cmd: "report_js_heap", n: 1, since: 1_000_000 },
        { cmd: "save_project", n: 1, since: 1_000_000 },
      ],
    });
  });

  it("hands the records to the host at launch and commits only once it has them", async () => {
    const w = new FakeWorker();
    stop = startHangRecorder(() => w);
    w.deliver({ t: "ready" });
    expect(w.of("drain")).toHaveLength(1);
    w.deliver({ t: "drained", text: "line\n", bytes: 5, gen: 0 });
    expect(calls("append_frontend_log")).toEqual([["append_frontend_log", { text: "line\n" }]]);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.of("commit")).toEqual([{ t: "commit", bytes: 5, gen: 0 }]);
    // And again on the period.
    await vi.advanceTimersByTimeAsync(HANDOFF_MS);
    expect(w.of("drain")).toHaveLength(2);
  });

  it("commits nothing when the host refuses, and sends nothing for an empty store", async () => {
    const w = new FakeWorker();
    stop = startHangRecorder(() => w);
    w.deliver({ t: "ready" });
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "append_frontend_log") throw new Error("disk full");
    });
    w.deliver({ t: "drained", text: "line\n", bytes: 5, gen: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(w.of("commit")).toEqual([]);
    await vi.advanceTimersByTimeAsync(HANDOFF_MS);
    w.deliver({ t: "drained", text: "", bytes: 0, gen: 0 });
    expect(calls("append_frontend_log")).toHaveLength(1);
  });

  it("does not try a handover while the host is not acknowledging", async () => {
    const w = new FakeWorker();
    stop = startHangRecorder(() => w);
    w.deliver({ t: "ready" });
    w.deliver({ t: "drained", text: "", bytes: 0, gen: 0 });
    vi.mocked(invoke).mockImplementation(() => new Promise(() => {}));
    void ipcInvoke("report_js_heap", { bytes: 0 });
    await vi.advanceTimersByTimeAsync(HANDOFF_MS);
    expect(w.of("drain")).toHaveLength(1);
  });

  it("forwards resize and visibility changes", () => {
    const w = new FakeWorker();
    stop = startHangRecorder(() => w);
    w.deliver({ t: "ready" });
    window.dispatchEvent(new Event("resize"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(w.of("resize")).toEqual([{ t: "resize", w: window.innerWidth, h: window.innerHeight }]);
    expect(w.of("visibility")).toEqual([{ t: "visibility", state: document.visibilityState }]);
  });

  it("says once in the host log when the worker cannot record, and stops", () => {
    const w = new FakeWorker();
    stop = startHangRecorder(() => w);
    w.deliver({ t: "unavailable", reason: "no OPFS" });
    expect(calls("gui_emit_system_log")).toEqual([
      [
        "gui_emit_system_log",
        { level: "warn", source: "frontend", message: "hang recorder off: no OPFS" },
      ],
    ]);
    expect(w.terminate).toHaveBeenCalled();
    vi.advanceTimersByTime(PING_MS * 4);
    expect(w.of("ping")).toEqual([]);
  });

  it("says so when no worker can be made at all", () => {
    stop = startHangRecorder(() => {
      throw new Error("Worker is not defined");
    });
    expect(calls("gui_emit_system_log")[0][1]).toMatchObject({
      level: "warn",
      message: "hang recorder off: Error: Worker is not defined",
    });
  });
});
