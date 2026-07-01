import { useEffect, useRef, useState } from "react";

import type { TransientStatus } from "./statusLine";

/// Drive the header status label: show `resting` normally, but when a
/// `transient` notice appears, freeze it in the bar for `dwellMs`, call
/// `emit` once (to mirror it into the system log), then revert to
/// `resting`. A notice logs exactly once while it stays present; a
/// different notice re-fires, and an identical notice re-fires only
/// after the bar has returned to rest (`transient` went `null`).
///
/// `emit` is injected rather than calling Tauri directly so the hook is
/// pure of the IPC and unit-testable.
export function useTransientStatus(
  resting: string,
  transient: TransientStatus | null,
  emit: (t: TransientStatus) => void,
  dwellMs: number,
): string {
  const [frozen, setFrozen] = useState<string | null>(null);
  const lastKeyRef = useRef<string | null>(null);
  const emitRef = useRef(emit);
  emitRef.current = emit;
  const transientRef = useRef(transient);
  transientRef.current = transient;
  const key = transient != null ? `${transient.level} ${transient.text}` : null;
  useEffect(() => {
    if (key == null) {
      // At rest — let a later identical notice re-fire and re-log.
      lastKeyRef.current = null;
      return;
    }
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;
    const t = transientRef.current;
    if (t == null) return;
    setFrozen(t.text);
    emitRef.current(t);
    const timer = window.setTimeout(() => setFrozen(null), dwellMs);
    return () => window.clearTimeout(timer);
  }, [key, dwellMs]);
  return frozen ?? resting;
}
