// Per-logical-bus connection state: a view over the host's model.
//
// The host owns the state (`connection_state.rs`); this module only
// subscribes to it and formats it for a dense row. Nothing here
// derives connection state from anything the frontend knows — the one
// thing it adds is "this bus has no binding at all", which is a
// project fact, not a connection fact.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { formatBitrate } from "./busHardwareConfig";
import type { BusConnState, BusConnStates } from "./types";

/// Tauri event the host fires whenever any bus's connection state
/// moves. Must match `connection_state::CONNECTION_STATES_CHANGED_EVENT`
/// host-side.
export const CONNECTION_STATES_CHANGED_EVENT = "connection-states-changed";

/// Subscribe to the host's per-bus connection states. Same
/// pull-then-follow shape as {@link useSidecarStatus} and the interface
/// cache (ADR 0016): one `get_connection_states` snapshot on mount,
/// then the change event. No polling, and nothing accumulates — the
/// payload is the whole map, bounded by the project's bus count.
export function useConnectionStates(): BusConnStates {
  const [states, setStates] = useState<BusConnStates>({});

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;

    void (async () => {
      try {
        const initial = await invoke<BusConnStates>("get_connection_states");
        if (!cancelled && initial) setStates(initial);
      } catch {
        // Host without the command (older build, dev shell): fall
        // through to the listener and stay empty if none comes.
      }
      try {
        unlisten = await listen<BusConnStates>(
          CONNECTION_STATES_CHANGED_EVENT,
          (e) => {
            if (!cancelled) setStates(e.payload ?? {});
          },
        );
      } catch {
        // Same fallback: stay on whatever snapshot we have.
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  return states;
}

/// How a row should paint a connection state. `tone` maps onto the
/// classes `project-bus-state` already carries for the sidecar and
/// remote-server rows, so all four state indicators read the same.
export interface BusConnDisplay {
  text: string;
  tone: "connected" | "errored" | "muted";
  /// Long-form detail for the row's `title`. Same as `text` when there
  /// is nothing more to say.
  detail: string;
}

/// Format one bus's state for its row.
///
/// `state` is the host's entry (absent = the host has no session for
/// this bus); `hasBinding` is the project fact that separates "unbound"
/// from "bound but not connected".
export function describeBusConnState(
  state: BusConnState | undefined,
  hasBinding: boolean,
): BusConnDisplay {
  if (!state) {
    return hasBinding
      ? { text: "not connected", tone: "muted", detail: "not connected" }
      : {
          text: "unbound",
          tone: "muted",
          detail: "no interface bound — pick one in the combo above",
        };
  }
  switch (state.kind) {
    case "connecting":
      return { text: "connecting…", tone: "muted", detail: "connecting…" };
    case "connected": {
      const applied = describeAppliedConfig(state.applied ?? null);
      return {
        text: "connected",
        tone: "connected",
        detail: applied === null ? "connected" : `connected — ${applied}`,
      };
    }
    case "error":
      return {
        text: `error: ${state.reason}`,
        tone: "errored",
        detail: state.reason,
      };
  }
}

/// One-line rendering of what the host actually put on the wire for a
/// connected bus, or `null` when there is nothing to say (an
/// in-process virtual bus has no controller to configure).
///
/// This is deliberately not the value in the input box. `speedBps:
/// null` means **no** `ConfigureBus` was sent — the driver's own
/// default is what the controller is running, and the host does not
/// know what that is, so the row says so rather than echoing the
/// placeholder.
export function describeAppliedConfig(
  applied: { speedBps: number | null; fdEnabled: boolean; fdDataSpeedBps: number | null } | null,
): string | null {
  if (!applied) return null;
  if (applied.speedBps === null) return "driver default (nothing sent)";
  // A wire `0` is "unset" to the sidecar — it happens when FD is
  // ticked but no bitrate was typed. Saying "0" would be a lie.
  const parts = [
    applied.speedBps === 0 ? "driver default" : formatBitrate(applied.speedBps),
  ];
  if (applied.fdEnabled) {
    parts.push(
      applied.fdDataSpeedBps === null || applied.fdDataSpeedBps === 0
        ? "FD"
        : `FD data ${formatBitrate(applied.fdDataSpeedBps)}`,
    );
  }
  return parts.join(" · ");
}
