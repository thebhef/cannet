import { useEffect, useState } from "react";

import logoUrl from "./assets/logo.svg";

/// Floor on how long the splash stays up. Long enough that the safety
/// disclaimer is read rather than blinked past, and it is the whole
/// wait on a machine whose boot beats it.
export const SPLASH_MIN_MS = 5000;

/**
 * Whether the startup splash is still showing. It drops at
 * `max(SPLASH_MIN_MS, boot settled)`: the floor gives the disclaimer a
 * readable dwell, and `bootSettled` — the boot project-open — keeps it
 * up until the app is usable. The prior capture's history is *not* part
 * of that wait: it loads in the background and appears when it is ready
 * (ADR 0002 DS-7), so a large cache no longer holds the splash up.
 * Every settling of the boot counts, failures included; nothing here can
 * outlast a boot that errored.
 */
export function useSplashVisible(bootSettled: boolean): boolean {
  const [floorElapsed, setFloorElapsed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setFloorElapsed(true), SPLASH_MIN_MS);
    return () => clearTimeout(t);
  }, []);
  return !(floorElapsed && bootSettled);
}

/**
 * Full-window startup overlay: the app's identity, the safety
 * disclaimer, and the fact that it is still loading. Shown on every
 * launch — it is a notice, not an acknowledgement, so there is no
 * "continue" button and no remembered dismissal.
 */
export function SplashOverlay() {
  return (
    <div className="splash-overlay" role="status" data-testid="splash-overlay">
      <div className="splash-card">
        <img className="splash-logo" src={logoUrl} alt="" />
        <h1 className="splash-title">cannet</h1>
        <p className="splash-warning">
          <strong>Warning:</strong> make sure the system you are connecting to is
          in a safe state to have its CAN traffic disrupted. Cannet can make
          unsafe changes to network traffic.
        </p>
        <p className="splash-loading">Starting up…</p>
      </div>
    </div>
  );
}
