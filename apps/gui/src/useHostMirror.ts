/// Host-mirror pattern, shared by `TransmitPanel` and `RbsPanel`: fetch
/// a snapshot from the host, re-fetch on a host change-event, and
/// (optionally) poll at a display cadence while some live condition
/// holds (calculated fields the host mutates without emitting the
/// change-event, e.g. counter/CRC ticks).
///
/// A consumer whose event carries the whole new state rather than a
/// nudge to re-read it passes `fromPayload`: the listener then applies
/// the payload directly and the fetches are only the snapshot pair
/// around registration.
///
/// `listen` (Tauri) is async, so a change the host emits in the gap
/// between the initial snapshot fetch and the listener actually being
/// registered would otherwise be lost until the next event or poll
/// tick — a real launch race. `RbsPanel` already guarded against it
/// with a second fetch once the listener attaches; `TransmitPanel`
/// didn't. Both now go through this hook, which always does the
/// post-listener refetch.

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { useSetting } from "./hostSettings";

export interface UseHostMirrorOptions<T, P = unknown> {
  /// Fetch one snapshot from the host. Memoize this (`useCallback`) —
  /// its identity gates the listener-registration effect, so a fresh
  /// closure every render would re-subscribe every render.
  fetch: () => Promise<T>;
  /// Value to fall back to when `fetch` rejects.
  fallback: T;
  /// Host event name that signals a change worth re-fetching.
  event: string;
  /// Only refetch when the event's payload matches (e.g. an
  /// element-scoped event: `payload === elementId || payload === "*"`).
  /// Omit to always refetch on `event`.
  matches?: (payload: P) => boolean;
  /// Read the new snapshot straight out of the event instead of
  /// re-fetching it. For the host events that publish the whole state
  /// rather than a nudge to re-read — the per-bus connection map, the
  /// sidecar's status. The snapshot pair around listener registration
  /// still runs: a payload only reaches a listener that exists, so it
  /// is the fetches, not the event, that close the launch race.
  fromPayload?: (payload: P) => T;
  /// Re-fetch every poll interval while this returns true for the
  /// latest snapshot (e.g. "some entry is running"). Evaluated fresh
  /// each render but only its boolean *result* gates the poll
  /// effect's dependency, so the interval isn't torn down and rebuilt
  /// on every tick — only when the result actually flips.
  pollWhile?: (value: T) => boolean;
  /// Spacing between poll ticks. Defaults to the app-wide view refresh
  /// cadence (`view_refresh_interval_ms`) — a host mirror going stale
  /// in place is the same "keep up with the host" job the paged views
  /// do, and it used to carry its own separate number for it.
  pollIntervalMs?: number;
}

export interface UseHostMirrorResult<T> {
  value: T;
  refresh: () => void;
}

export function useHostMirror<T, P = unknown>({
  fetch,
  fallback,
  event,
  matches,
  fromPayload,
  pollWhile,
  pollIntervalMs,
}: UseHostMirrorOptions<T, P>): UseHostMirrorResult<T> {
  const configuredPollMs = useSetting("view_refresh_interval_ms");
  const pollMs = pollIntervalMs ?? configuredPollMs;
  const [value, setValue] = useState<T>(fallback);

  // `fallback`/`matches` are read through refs rather than made
  // dependencies of `refresh`/the listener effect: callers commonly
  // pass an inline `[]`/arrow literal, and reacting to those would
  // re-subscribe the listener on every render.
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const matchesRef = useRef(matches);
  matchesRef.current = matches;
  const fromPayloadRef = useRef(fromPayload);
  fromPayloadRef.current = fromPayload;

  const refresh = useCallback(() => {
    void fetch()
      .then(setValue)
      .catch(() => setValue(fallbackRef.current));
  }, [fetch]);

  useEffect(() => {
    let active = true;
    // Paint fast from whatever the host already has…
    refresh();
    const un = listen<P>(event, (e) => {
      if (matchesRef.current && !matchesRef.current(e.payload)) return;
      const read = fromPayloadRef.current;
      if (read) setValue(read(e.payload));
      else refresh();
    });
    // …and fetch again once the listener is attached: `listen` is
    // async, so a change emitted in the gap before registration would
    // otherwise be lost until the next matching event.
    void un.then(() => {
      if (active) refresh();
    });
    return () => {
      active = false;
      void un.then((off) => off());
    };
  }, [refresh, event]);

  const pollWhileRef = useRef(pollWhile);
  pollWhileRef.current = pollWhile;
  const shouldPoll = pollWhileRef.current?.(value) ?? false;
  useEffect(() => {
    if (!shouldPoll) return;
    const timer = window.setInterval(refresh, pollMs);
    return () => window.clearInterval(timer);
  }, [shouldPoll, pollMs, refresh]);

  return { value, refresh };
}
