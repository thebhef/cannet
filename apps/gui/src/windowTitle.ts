import type { LogState, RemoteStatus } from "./statusLine";

const APP_NAME = "cannet";

/// The facts the native window title is built from. All of them come
/// from state `App` already holds — the title derives nothing of its
/// own.
export interface WindowTitleInputs {
  /// Path of the open project file, or `null` for an unsaved project.
  projectPath: string | null;
  /// Unsaved changes — the same flag the project view's `●` marker and
  /// the close prompt read.
  dirty: boolean;
  /// Capture-source label from {@link captureLabel}; `null` omits the
  /// segment entirely.
  capture: string | null;
  /// The host's `app_version` (`v0.9.3`, or `v0.9.3-3-gabc1234` past a
  /// tag). Empty until the command answers, which drops the version
  /// rather than showing a placeholder.
  version: string;
}

/// The native window title: `<project> — <capture source> — cannet
/// <version>`, prefixed with `• ` while there are unsaved changes.
///
/// The project name leads because it is what distinguishes one window
/// from another where a title gets truncated — a taskbar hover, an
/// alt-tab preview. Segments with nothing to say are omitted, so a
/// fresh window is just `cannet <version>`.
///
/// Pure so it's unit-testable; `App.tsx` pushes the result to the OS
/// title bar via `getCurrentWindow().setTitle`.
export function windowTitle(inp: WindowTitleInputs): string {
  const segments: string[] = [];
  const project = projectName(inp.projectPath);
  if (project !== null) segments.push(project);
  if (inp.capture !== null && inp.capture !== "") segments.push(inp.capture);
  segments.push(inp.version === "" ? APP_NAME : `${APP_NAME} ${stripTagPrefix(inp.version)}`);
  return `${inp.dirty ? "• " : ""}${segments.join(" — ")}`;
}

/// What the window is currently showing data from: the live connection
/// while one is up, otherwise the BLF being replayed (or last
/// replayed), otherwise `null` for "nothing loaded".
///
/// Live wins over a loaded log for the same reason `splitStatus` gives
/// remote sessions priority in the status line — the user is actively
/// streaming. A session with several subscribed interfaces has no one
/// name, so it reports the count instead.
export function captureLabel(
  state: LogState,
  remoteSessions: ReadonlyMap<string, RemoteStatus>,
): string | null {
  const live: string[] = [];
  for (const session of remoteSessions.values()) {
    if (session.kind !== "running") continue;
    const names = new Map(session.result.interfaces.map((i) => [i.id, i.display_name]));
    for (const sub of session.result.subscriptions) {
      live.push(names.get(sub.interface_id) ?? sub.interface_id);
    }
  }
  if (live.length === 1) return live[0];
  if (live.length > 1) return `${live.length} interfaces`;

  switch (state.kind) {
    case "loading":
    case "running":
    case "done":
      return basename(state.result.blf_path);
    default:
      return null;
  }
}

/// The project file's basename without its extension, or `null` when no
/// project file is open.
function projectName(projectPath: string | null): string | null {
  if (projectPath === null) return null;
  const base = basename(projectPath);
  // Strip the last extension only (`.cannet_prj`, legacy `.json`) —
  // a dot elsewhere in the name is part of the name.
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function basename(path: string): string {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return sep >= 0 ? path.slice(sep + 1) : path;
}

/// `v0.9.3` → `0.9.3`. The host reports `git describe` output, which
/// carries the tag's `v` prefix; the title reads better without it.
/// Everything past the prefix is kept verbatim, so an untagged build
/// still identifies itself.
function stripTagPrefix(version: string): string {
  return /^v\d/.test(version) ? version.slice(1) : version;
}
