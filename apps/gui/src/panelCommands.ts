// Panel-local command implementations (ADR 0018). Commands like
// `plot.fitXAxis` are registered once in `commands.ts`, but their
// behaviour lives in whichever panel instance has focus — each
// element-backed panel registers its handlers here on mount, and the
// app-level command handler routes the firing through the *focused*
// panel's element id.

import { createContext, useContext, useEffect, useRef } from "react";

/// A panel's command implementations, keyed by command id.
export type PanelCommandHandlers = Record<string, () => void>;

export interface PanelCommandRegistry {
  /// Register the handlers for an element-backed panel. `get` is
  /// called at invoke time so the registration survives handler
  /// identity churn across renders. Returns an unregister fn.
  register(elementId: string, get: () => PanelCommandHandlers): () => void;
  /// Run `elementId`'s implementation of `commandId`. False when the
  /// panel isn't mounted or doesn't implement the command.
  invoke(elementId: string, commandId: string): boolean;
}

export function createPanelCommandRegistry(): PanelCommandRegistry {
  const map = new Map<string, () => PanelCommandHandlers>();
  return {
    register(elementId, get) {
      map.set(elementId, get);
      return () => {
        // Guard against remount ordering: a late unregister from the
        // previous instance must not clobber the new registration.
        if (map.get(elementId) === get) map.delete(elementId);
      };
    },
    invoke(elementId, commandId) {
      const handler = map.get(elementId)?.()[commandId];
      if (!handler) return false;
      handler();
      return true;
    },
  };
}

export const PanelCommandsContext = createContext<PanelCommandRegistry | null>(null);

/// Register this panel instance's command implementations for the
/// element it shows. Handlers may be fresh objects every render — a
/// ref indirection keeps the registration stable. No-op outside a
/// `PanelCommandsContext` provider (component tests).
export function usePanelCommands(elementId: string, handlers: PanelCommandHandlers): void {
  const registry = useContext(PanelCommandsContext);
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    if (!registry) return;
    return registry.register(elementId, () => ref.current);
  }, [registry, elementId]);
}
