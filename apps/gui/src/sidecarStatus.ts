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
/// flow in without polling, then snapshot once more.
///
/// The second snapshot is not belt-and-braces: `listen` is async, and
/// the sidecar publishes its bound address about a second after
/// launch — right in the gap between the first snapshot and the
/// listener being registered. An event emitted into that gap reaches
/// nobody, and since a healthy sidecar then never transitions again,
/// the app would believe it is still starting for the rest of the
/// session (a `--connect-on-start` run sat at "sidecar not ready"
/// until its readiness timeout while the host had been listening for
/// 30 s). Same post-listener refetch `useHostMirror` does.
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

    const snapshot = async () => {
      try {
        const current = await invoke<SidecarStatus>("get_sidecar_status");
        if (!cancelled && current) setStatus(current);
      } catch {
        // Host has no sidecar command (older build, dev shell) —
        // fall through to listening for events; if none come we
        // stay on the OFFLINE default.
      }
    };

    void (async () => {
      await snapshot();
      try {
        unlisten = await listen<SidecarStatus>(SIDECAR_STATUS_EVENT, (e) => {
          if (!cancelled) setStatus(e.payload);
        });
      } catch {
        // Same fallback as above: stay on OFFLINE.
        return;
      }
      // The listener is live now, so re-read: anything published while
      // it was being registered was delivered to nobody.
      await snapshot();
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
