/**
 * The one place the frontend subscribes to the host's `dbc-changed`.
 *
 * The host announces **every** change to the loaded DBC set — add,
 * reload in place, re-scope, remove, clear, the filesystem watcher's
 * reload, a capture's embedded databases (ADR 0053 §2). That event is
 * the carrier of the change; this module is the frontend's single
 * subscription to it, publishing a monotonic **DBC generation** that
 * each shared model reads:
 *
 * - the trace model's re-anchor epoch (`App`), which every windowed
 *   view and the plot's decimated source already fold into their fetch
 *   descriptors,
 * - the signal catalog (`signalCatalogContext`),
 * - the shared value-table fetch (`useValueTables`),
 * - the Database view's content snapshot.
 *
 * **No panel subscribes.** A view gets told because the shared model it
 * reads was told (ADR 0053 §3) — which is what keeps a new panel from
 * having to remember anything.
 *
 * Fan-out is coalesced, deliberately and in one place (ADR 0053 §5):
 * the announcement is per *change* while the work it triggers is per
 * *set*. One editor save is a burst of filesystem events, each of which
 * the host re-reads and re-announces; one project open is `clear_dbcs`
 * plus an `add_dbc` and a `set_dbc_buses` per database. Coalescing is
 * safe because the fan-out is idempotent and state-free — consumers
 * re-ask the host, which is authoritative, and none of them accumulates
 * across notifications.
 */
import { useSyncExternalStore } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/// Trailing-debounce window for the fan-out. Long enough to absorb one
/// editor save's burst of filesystem events; short enough to be
/// invisible, and nothing user-initiated waits on it (a frontend-driven
/// change re-anchors at its own call site, synchronously).
export const DBC_CHANGE_COALESCE_MS = 250;

let generation = 0;
const subscribers = new Set<() => void>();
let listening = false;
let unlisten: UnlistenFn | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/// Depth rather than a flag: `suppressDbcChanges` nests harmlessly.
let suppressDepth = 0;
/// A change arrived while suppressed — the batch owes exactly one
/// fan-out when it ends, however many announcements it swallowed.
let missed = false;

function fanOut(): void {
  timer = null;
  generation += 1;
  // Copy: a subscriber may unsubscribe from inside its own callback.
  for (const notify of [...subscribers]) notify();
}

function schedule(): void {
  if (suppressDepth > 0) {
    missed = true;
    return;
  }
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(fanOut, DBC_CHANGE_COALESCE_MS);
}

function subscribe(onStoreChange: () => void): () => void {
  subscribers.add(onStoreChange);
  if (!listening) {
    listening = true;
    void listen("dbc-changed", schedule).then((fn) => {
      // Torn down while the listen was in flight (the last subscriber
      // left, or React re-ran the effect) — drop it rather than leak it.
      if (listening) unlisten = fn;
      else fn();
    });
  }
  return () => {
    subscribers.delete(onStoreChange);
    if (subscribers.size > 0) return;
    listening = false;
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  return generation;
}

/// The current DBC generation, re-rendering the caller whenever the
/// host announces a change to the loaded set. A consumer folds it into
/// the identity of what it fetches (an effect dependency, a memo key) —
/// the number itself means nothing beyond "the set is not what it was".
export function useDbcGeneration(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/// Hold the fan-out for the duration of a frontend batch that is *one*
/// set change spread over several host calls — opening a project, or
/// reloading every database from disk — and release it with a single
/// fan-out if anything arrived (ADR 0053 §5). Returns the release
/// function; call it exactly once, in a `finally`.
///
/// This is not an optimisation of the debounce: it is what makes a
/// project open cost one refresh *deterministically*, rather than
/// depending on N host calls finishing inside a 250 ms window.
export function suppressDbcChanges(): () => void {
  suppressDepth += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    suppressDepth -= 1;
    if (suppressDepth === 0 && missed) {
      missed = false;
      schedule();
    }
  };
}
