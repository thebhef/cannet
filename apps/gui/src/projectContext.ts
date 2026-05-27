import { createContext, useContext } from "react";

import type { Bus, InterfaceBinding } from "./types";

/**
 * The current project + bus/DBC configuration and the actions that
 * change them, shared so the project panel (a dockview panel, not a
 * child of `App`) can drive them. The toolbar and the project graph
 * view use the same callbacks.
 *
 * Phase 6: a project owns a list of logical {@link Bus}es and a list
 * of {@link InterfaceBinding}s mapping `(server, interface)` pairs to
 * buses. DBCs gain per-bus scoping (`dbcBuses[path]` is the bus ids a
 * DBC decodes for; empty = "all buses"). Server addresses live on
 * bindings; Connect iterates the unique servers in
 * {@link interfaceBindings} and opens one session per server, surfacing
 * per-server status via {@link connectedAddresses}.
 */
export interface ProjectContextValue {
  /// Path of the open project file, or `null` if none has been saved /
  /// opened yet (an "unsaved" workspace).
  projectPath: string | null;
  /// True when the workspace has changed since it was last saved /
  /// opened (an unsaved-changes indicator; also drives the
  /// save-before-quit prompt).
  dirty: boolean;
  /// Paths of the loaded DBCs, in priority order (first match wins).
  dbcPaths: string[];
  /// Phase 6: per-DBC bus scoping. `dbcBuses[path]` is the bus ids
  /// that DBC decodes for; an empty list / missing entry is "all
  /// buses".
  dbcBuses: Record<string, string[]>;
  /// Phase 6: logical buses the project owns.
  buses: Bus[];
  /// Phase 6: interface → bus bindings.
  interfaceBindings: InterfaceBinding[];
  /// Addresses with a currently-running remote session.
  connectedAddresses: string[];
  /// True if any remote session is currently connecting or running.
  remoteConnected: boolean;
  /// Bus ids whose interface binding points at a server with a
  /// currently-running session. The transmit panel uses this to gate
  /// send / cyclic actions — transmit is a no-op for a bus whose
  /// session isn't up. Computed from {@link interfaceBindings} +
  /// {@link connectedAddresses} + the resolved sidecar address.
  connectedBusIds: string[];
  /// Path of a loaded BLF replay, if one is the active source.
  blfPath: string | null;

  onNewProject: () => void;
  onOpenProject: () => void;
  /// Write to the open project's path, or prompt if there isn't one.
  onSaveProject: () => void;
  onSaveProjectAs: () => void;
  /// Pick one or more DBC files and add them to the loaded set.
  onAddDbc: () => void;
  /// Unload the DBC with this path.
  onRemoveDbc: (path: string) => void;
  /// Re-read every loaded DBC from disk (no-op if none are loaded).
  onReloadDbc: () => void;
  /// Phase 6: set the bus scoping for a single DBC.
  onSetDbcBuses: (path: string, buses: string[]) => void;
  /// Phase 6: bus list ops.
  onAddBus: (bus: Bus) => void;
  onRemoveBus: (id: string) => void;
  onRenameBus: (id: string, name: string) => void;
  /// Set a bus's graph colour (`#rrggbb`).
  onSetBusColor: (id: string, color: string) => void;
  /// Phase 6: interface-binding ops.
  onAddBinding: (binding: InterfaceBinding) => void;
  onRemoveBinding: (server: string, iface: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

export const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProjectContext(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) {
    throw new Error("useProjectContext must be used inside a ProjectContext provider");
  }
  return ctx;
}
