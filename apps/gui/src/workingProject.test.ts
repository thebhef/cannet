import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWorkingProjectPusher, sameElements, type WorkingProjectPush } from "./workingProject";
import type { Project } from "./types";

function doc(name: string): Project {
  return {
    schema_version: 7,
    layout: { grid: {}, panels: {} },
    elements: [],
    buses: [{ id: "b1", name }],
    interface_bindings: [],
    dbcs: [],
    remote_address: null,
    local_virtual_buses: [],
    signal_colors: {},
  } as unknown as Project;
}

describe("createWorkingProjectPusher", () => {
  let current: WorkingProjectPush | null;
  let sent: WorkingProjectPush[];
  const read = () => current;
  const send = (p: WorkingProjectPush) => {
    sent.push(p);
    return Promise.resolve();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    current = { document: doc("A"), dirty: false };
    sent = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces a burst of edits into one push of the latest document", () => {
    const p = createWorkingProjectPusher(read, send, 300);
    p.schedule();
    current = { document: doc("B"), dirty: true };
    p.schedule();
    vi.advanceTimersByTime(299);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([{ document: doc("B"), dirty: true }]);
  });

  it("does not re-push a document that has not changed", () => {
    const p = createWorkingProjectPusher(read, send, 300);
    p.schedule();
    vi.advanceTimersByTime(300);
    p.schedule();
    vi.advanceTimersByTime(300);
    expect(sent.length).toBe(1);
    // The dirty flag is part of what is pushed.
    current = { document: doc("A"), dirty: true };
    p.schedule();
    vi.advanceTimersByTime(300);
    expect(sent.length).toBe(2);
  });

  it("pushes nothing while the reader has no document (the boot has not settled)", () => {
    current = null;
    const p = createWorkingProjectPusher(read, send, 300);
    p.schedule();
    vi.advanceTimersByTime(300);
    p.flush();
    expect(sent).toEqual([]);
  });

  it("flush sends a pending push at once, and is a no-op with nothing pending", () => {
    const p = createWorkingProjectPusher(read, send, 300);
    p.flush();
    expect(sent).toEqual([]);
    p.schedule();
    p.flush();
    expect(sent.length).toBe(1);
    vi.advanceTimersByTime(300);
    expect(sent.length).toBe(1);
  });

  it("a failed push is retried by the next schedule even if unchanged", async () => {
    let fail = true;
    const p = createWorkingProjectPusher(
      read,
      (x) => {
        sent.push(x);
        return fail ? Promise.reject(new Error("no host")) : Promise.resolve();
      },
      300,
    );
    p.schedule();
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();
    fail = false;
    p.schedule();
    vi.advanceTimersByTime(300);
    expect(sent.length).toBe(2);
  });

  it("dispose drops a pending push", () => {
    const p = createWorkingProjectPusher(read, send, 300);
    p.schedule();
    p.dispose();
    vi.advanceTimersByTime(300);
    expect(sent).toEqual([]);
  });
});

describe("sameElements", () => {
  it("is true only for the same element objects in the same order", () => {
    const a = { kind: "trace", id: "a" };
    const b = { kind: "plot", id: "b" };
    expect(sameElements([a, b], [a, b])).toBe(true);
    expect(sameElements([a, b], [b, a])).toBe(false);
    expect(sameElements([a], [a, b])).toBe(false);
    expect(sameElements([{ ...a }], [a])).toBe(false);
  });
});
