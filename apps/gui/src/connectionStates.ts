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
import type { StatusChipState } from "./StatusChip";
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

/// One bus the connection chip counts: a project bus with an
/// interface binding. Unbound buses are not units — nothing was ever
/// going to connect them.
export interface ConnectionUnit {
  id: string;
  name: string;
}

/// What the connection chip shows, and what pressing it does.
export interface ConnectionSummary {
  state: StatusChipState;
  /// The chip's word.
  label: string;
  /// `connected / bound`, or `null` when the project binds nothing.
  count: string | null;
  /// Per-bus detail for the tooltip — one line per bound bus, naming
  /// what the host applied or why it failed.
  detail: string;
  /// The command pressing the chip runs, or `null` when there is
  /// nothing to press.
  action: "connect" | "disconnect" | null;
  /// How that action reads to a screen reader.
  actionLabel: string;
}

/// Aggregate the host's per-bus connection map into the one state the
/// chip shows.
///
/// Nothing here is derived from what the frontend can see arriving:
/// every bus's state is the host's (`connection_state.rs`), and the
/// only judgement made is which of them the chip counts — the project
/// buses that carry a binding.
///
/// `remoteActive` is the host's other connection fact: a session is up
/// or coming up. It matters for the gap between a session starting and
/// the first bus reporting, where there is no per-bus state to read
/// and "not connected" would be wrong.
export function summarizeConnection(
  bound: readonly ConnectionUnit[],
  states: BusConnStates,
  remoteActive: boolean,
): ConnectionSummary {
  if (bound.length === 0) {
    return {
      state: "idle",
      label: "Not connected",
      count: null,
      detail: "No interface bindings — add one in the project panel first.",
      action: null,
      actionLabel: "Connect",
    };
  }
  const detail = bound
    .map((b) => `${b.name}: ${describeBusConnState(states[b.id], true).detail}`)
    .join("\n");
  const entries = bound.map((b) => states[b.id]);
  const connected = entries.filter((s) => s?.kind === "connected").length;
  const connecting = entries.filter((s) => s?.kind === "connecting").length;
  const errored = entries.filter((s) => s?.kind === "error").length;
  const count = `${connected} / ${bound.length}`;
  // An attempt still in flight outranks whatever has already landed:
  // the aggregate is not settled until every bus has answered.
  if (connecting > 0 || (remoteActive && connected + errored === 0)) {
    // Pressing during a connect disconnects — a connect that never
    // lands must still be escapable, and there is no other way out of
    // it.
    return {
      state: "connecting",
      label: "Connecting…",
      count,
      detail,
      action: "disconnect",
      actionLabel: "Disconnect",
    };
  }
  if (connected === bound.length) {
    return {
      state: "connected",
      label: "Connected",
      count,
      detail,
      action: "disconnect",
      actionLabel: "Disconnect",
    };
  }
  if (connected > 0) {
    return {
      state: "degraded",
      label: "Connected",
      count,
      detail,
      action: "disconnect",
      actionLabel: "Disconnect",
    };
  }
  if (errored > 0) {
    return {
      state: "failed",
      label: "Failed",
      count,
      detail,
      action: "connect",
      actionLabel: "Retry",
    };
  }
  return {
    state: "idle",
    label: "Not connected",
    count,
    detail,
    action: remoteActive ? "disconnect" : "connect",
    actionLabel: remoteActive ? "Disconnect" : "Connect",
  };
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
