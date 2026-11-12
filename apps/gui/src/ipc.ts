// The frontend's one door to the host: every `invoke` in the product goes
// through here rather than straight to `@tauri-apps/api/core` (a test in
// `ipc.test.ts` holds that line).
//
// The reason is the hang recorder (`hangRecorderClient.ts`). When a
// window stops answering, the first question is which command it was
// waiting on, and only a single choke point can say — Tauri's own
// `__TAURI_INTERNALS__.invoke` is a non-writable property, so it cannot
// be wrapped from outside. Armed, each call is entered in a map on its
// way out and removed when it settles; the recorder reads the map's
// summary twice a second. Disarmed (every test, and any launch the
// recorder never started in) the wrapper is the core `invoke` itself.
//
// What this does not see: invokes issued inside `@tauri-apps/api`'s own
// helpers (`listen`, the dialog plugin), which call core directly.

import { invoke as coreInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";

type Entry = { cmd: string; since: number };

// In-flight calls by id, or `undefined` while tracking is off.
let pending: Map<number, Entry> | undefined;
let nextId = 0;

/// Arm (or disarm) pending-call tracking. Disarming forgets every entry.
export function armInvokeTracking(on: boolean): void {
  pending = on ? new Map() : undefined;
}

/// `invoke` from `@tauri-apps/api/core`, observed when tracking is armed.
/// Arguments are forwarded exactly as given, and the caller gets the
/// core promise itself, so resolution order and rejections are unchanged.
export function invoke<T>(
  cmd: string,
  ...rest: [args?: InvokeArgs, options?: InvokeOptions]
): Promise<T> {
  const p = coreInvoke<T>(cmd, ...rest);
  const map = pending;
  if (!map) return p;
  const id = nextId++;
  map.set(id, { cmd, since: Date.now() });
  const settle = () => {
    map.delete(id);
  };
  // A side branch: the caller's `p` is returned untouched, and this
  // branch swallows the rejection the caller is handling on its own.
  p.then(settle, settle);
  return p;
}

/// One command's outstanding calls: how many, and when the oldest began
/// (wall-clock ms).
export type PendingGroup = { cmd: string; n: number; since: number };

/// Every command with a call still outstanding, in first-seen order.
/// Empty while tracking is off.
export function pendingInvokes(): PendingGroup[] {
  if (!pending) return [];
  const groups = new Map<string, PendingGroup>();
  for (const { cmd, since } of pending.values()) {
    const g = groups.get(cmd);
    if (g) {
      g.n += 1;
      g.since = Math.min(g.since, since);
    } else {
      groups.set(cmd, { cmd, n: 1, since });
    }
  }
  return [...groups.values()];
}
