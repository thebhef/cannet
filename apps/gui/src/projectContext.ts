import { createContext, useContext } from "react";

/**
 * The current project + bus/DBC configuration and the actions that
 * change them, shared so the project panel (a dockview panel, not a
 * child of `App`) can drive them. The toolbar uses the same callbacks.
 *
 * "Bus" here is whatever single source is configured — a remote
 * `cannet-server` (the usual case) and/or a loaded BLF replay. Plural
 * buses, the per-interface subscription set, and per-bus DBC
 * association are later project-file steps; for now every loaded DBC
 * applies to the one interface.
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
  /// The configured remote-server address (`host:port`).
  remoteAddress: string;
  /// True while a remote session is connecting or running.
  remoteConnected: boolean;
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
