import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

/// The frontend session state the reset re-anchors, injected so the hook
/// stays testable and doesn't reach into `App`'s closures.
export interface SessionResetDeps {
  /// Re-anchor every trace window (bump the epoch, drop the live tail).
  invalidateCache: () => void;
  setSessionStartSeconds: (value: number | null) => void;
  setCount: (value: number) => void;
  /// Re-anchor + restart every trace/plot element at index 0.
  startAllElements: () => void;
}

export interface SessionResetOptions {
  /// Restart every trace/plot element (default `true`). New-project
  /// passes `false`: `seedDefaultLayout` already reseeded the registry,
  /// so there's nothing left to restart.
  startElements?: boolean;
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
/// frontend's derived session state (re-anchor every trace window, drop
/// the session-start clock, zero the frame count, and — unless
/// `startElements` is `false` — restart every trace/plot element).
///
/// Returns `true` if the caller should proceed, `false` if the host
/// clear rejected under an abort policy and the caller should bail. The
/// four sites' error policies differ deliberately (Clear continues,
/// Connect and BLF-map abort, New fire-and-forgets); each supplies its
/// own through {@link SessionResetOptions} instead of sharing one
/// hardcoded behaviour.
export function useSessionReset(deps: SessionResetDeps) {
  const { invalidateCache, setSessionStartSeconds, setCount, startAllElements } = deps;
  return useCallback(
    async (options: SessionResetOptions = {}): Promise<boolean> => {
      const {
        startElements = true,
        fireAndForget = false,
        onError,
        resetOnClearError = false,
      } = options;
      const resetLocal = () => {
        invalidateCache();
        setSessionStartSeconds(null);
        setCount(0);
        if (startElements) startAllElements();
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
    [invalidateCache, setSessionStartSeconds, setCount, startAllElements],
  );
}
