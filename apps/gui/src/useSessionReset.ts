import { useCallback } from "react";
import { invoke } from "./ipc";

/// The frontend session state the reset re-anchors, injected so the hook
/// stays testable and doesn't reach into `App`'s closures.
export interface SessionResetDeps {
  /// Drop the paged views' cache (bump the epoch, drop the live tail).
  invalidateCache: () => void;
  setSessionStartSeconds: (value: number | null) => void;
  setCount: (value: number) => void;
}

export interface SessionResetOptions {
  /// Fire-and-forget the host clear — don't await it, swallow any
  /// failure, and run the frontend reset synchronously (the New-project
  /// policy, which must not block on or surface a clear error).
  /// `onError` / `resetOnClearError` are ignored in this mode.
  fireAndForget?: boolean;
  /// Per-site handler for a host-clear rejection — e.g. show the error,
  /// drop the just-added recent-file entry. Skipped in `fireAndForget`.
  onError?: (err: unknown) => void;
  /// On a host-clear rejection, reset the session anyway (Clear's
  /// "continue" policy) rather than aborting. Default `false` (abort —
  /// Connect and BLF-map).
  resetOnClearError?: boolean;
}

/// The shared session (re)start step behind Clear, Connect, BLF-map
/// confirm, and New project: clear the host trace store, then reset the
/// frontend's derived session state (drop the paged views' cache, the
/// session-start clock and the frame count). The host's clear also runs
/// every element's trace window from 0; the registry hears that through
/// its trace-window mirror, not from here.
///
/// Returns `true` if the caller should proceed, `false` if the host
/// clear rejected under an abort policy and the caller should bail. The
/// four sites' error policies differ deliberately (Clear continues,
/// Connect and BLF-map abort, New fire-and-forgets); each supplies its
/// own through {@link SessionResetOptions} instead of sharing one
/// hardcoded behaviour.
export function useSessionReset(deps: SessionResetDeps) {
  const { invalidateCache, setSessionStartSeconds, setCount } = deps;
  return useCallback(
    async (options: SessionResetOptions = {}): Promise<boolean> => {
      const { fireAndForget = false, onError, resetOnClearError = false } = options;
      const resetLocal = () => {
        invalidateCache();
        setSessionStartSeconds(null);
        setCount(0);
      };
      if (fireAndForget) {
        void invoke("clear_trace_store").catch(() => {});
        resetLocal();
        return true;
      }
      try {
        await invoke("clear_trace_store");
      } catch (err) {
        onError?.(err);
        if (!resetOnClearError) return false;
      }
      resetLocal();
      return true;
    },
    [invalidateCache, setSessionStartSeconds, setCount],
  );
}
