import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

import {
  SIDECAR_STATUS_EVENT,
  type SidecarStatus,
} from "./types";
import { useHostMirror } from "./useHostMirror";

/// Where a host that cannot answer leaves us — an older build or a dev
/// shell with no `get_sidecar_status`.
const OFFLINE: SidecarStatus = { phase: "offline", address: null };

const fetchSidecarStatus = () =>
  invoke<SidecarStatus>("get_sidecar_status").then((s) => s ?? OFFLINE);

/// React hook that subscribes to the python-can sidecar's published
/// status. Returns the latest {@link SidecarStatus}; defaults to
/// `{ phase: "offline", address: null }` until the host responds.
///
/// The shared host-mirror pattern, with the status event carrying the
/// whole new status rather than a nudge to re-read it: a
/// `get_sidecar_status` snapshot on mount, then the event, then a
/// second snapshot once the listener is attached.
///
/// That second snapshot is not belt-and-braces: `listen` is async, and
/// the sidecar publishes its bound address about a second after
/// launch — right in the gap between the first snapshot and the
/// listener being registered. An event emitted into that gap reaches
/// nobody, and since a healthy sidecar then never transitions again,
/// the app would believe it is still starting for the rest of the
/// session (a `--connect-on-start` run sat at "sidecar not ready"
/// until its readiness timeout while the host had been listening for
/// 30 s).
export function useSidecarStatus(): SidecarStatus {
  const fetch = useCallback(fetchSidecarStatus, []);
  return useHostMirror<SidecarStatus, SidecarStatus>({
    fetch,
    fallback: OFFLINE,
    event: SIDECAR_STATUS_EVENT,
    fromPayload: (payload) => payload ?? OFFLINE,
  }).value;
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
