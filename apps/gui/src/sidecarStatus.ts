import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  SIDECAR_STATUS_EVENT,
  type SidecarStatus,
} from "./types";

const OFFLINE: SidecarStatus = { phase: "offline", address: null };

/// React hook that subscribes to the python-can sidecar's published
/// status. Returns the latest {@link SidecarStatus}; defaults to
/// `{ phase: "offline", address: null }` until the host responds.
///
/// On mount: snapshot the current status via the `get_sidecar_status`
/// Tauri command, then listen for `sidecar-status-changed` so later
/// transitions (sidecar comes up, crashes, restarts on a new port)
/// flow in without polling.
///
/// Connection-panel rendering is the only consumer today; pulled into
/// its own hook so a future second consumer (a status pill in the
/// toolbar, say) shares the same subscription wiring instead of
/// double-listening.
export function useSidecarStatus(): SidecarStatus {
  const [status, setStatus] = useState<SidecarStatus>(OFFLINE);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;

    void (async () => {
      try {
        const initial = await invoke<SidecarStatus>("get_sidecar_status");
        if (!cancelled) setStatus(initial);
      } catch {
        // Host has no sidecar command (older build, dev shell) —
        // fall through to listening for events; if none come we
        // stay on the OFFLINE default.
      }
      try {
        unlisten = await listen<SidecarStatus>(SIDECAR_STATUS_EVENT, (e) => {
          if (!cancelled) setStatus(e.payload);
        });
      } catch {
        // Same fallback as above: stay on OFFLINE.
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  return status;
}

/// Format a {@link SidecarStatus} for the Connection panel's "Local
/// sidecar" row. Pulled out of the component so the wording can be
/// unit-tested without rendering React.
export function describeSidecarStatus(s: SidecarStatus): string {
  switch (s.phase) {
    case "ready":
      return s.address ? `listening on ${s.address}` : "listening (address unknown)";
    case "starting":
      return "starting…";
    case "offline":
      return "offline";
  }
}
