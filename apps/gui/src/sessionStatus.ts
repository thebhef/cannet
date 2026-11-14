// What the host's session holds — the boot's first question (ADR 0063).
//
// The frontend may be reloaded at any time without changing host or
// project state. So the boot asks the host first (`session_status.rs`):
// a host that already holds a project is *rejoined* — its working
// document applied, its trace windows mirrored, its session facts read
// back from here — and only a host holding nothing (a process launch)
// takes the fresh open path. The frontend compares nothing: the host
// says what it holds.

import { invoke } from "./ipc";
import type { RemoteStatus } from "./statusLine";
import type {
  DbcInfo,
  ImportMdfResult,
  OpenLogResult,
  Project,
  RemoteSessionResult,
  TraceGrew,
} from "./types";

/// One binding a session was connected with, as `connect_remote_server`
/// was given it.
export interface JoinedBinding {
  interface: string;
  busId: string;
  speedBps: number | null;
  fd: boolean | null;
  fdDataSpeedBps: number | null;
}

/// One connected session: the connect's own answer and its bindings.
export interface SessionJoin {
  result: RemoteSessionResult;
  bindings: JoinedBinding[];
}

/// `session_status`'s answer.
export interface SessionStatus {
  /// Whether the host holds a project. `false` only on a process launch.
  held: boolean;
  /// The project file, or `null` for a project never saved.
  path: string | null;
  /// The working document in the form Save writes it, or `null` for a
  /// project the frontend has not pushed yet (a fresh New project).
  document: Project | null;
  dirty: boolean;
  /// The session buffer, as a `trace-grew` would describe it now.
  trace: TraceGrew;
  sessions: SessionJoin[];
  /// The loaded DBC set, in priority order.
  dbcs: DbcInfo[];
  pyramids_rebuilding: boolean;
  /// The file an import is reading right now, if one is.
  importing: OpenLogResult | ImportMdfResult | null;
}

/// Ask the host what it holds. `null` when it cannot answer (no host),
/// which the boot reads as "holds nothing".
export function fetchSessionStatus(): Promise<SessionStatus | null> {
  return invoke<SessionStatus | null>("session_status")
    .then((s) => (s != null && typeof s === "object" ? s : null))
    .catch(() => null);
}

/// The App's per-address session map, as each connect answered.
export function remoteSessionsOf(
  status: SessionStatus,
): Map<string, RemoteStatus> {
  return new Map(
    status.sessions.map((s) => [
      s.result.address,
      { kind: "running", result: s.result },
    ]),
  );
}

/// The hardware configuration each connected bus was connected with —
/// what the pending-change banner compares the project's buses against.
export function busConfigOf(
  status: SessionStatus,
): Map<
  string,
  {
    speed_bps: number | null;
    fd: boolean | null;
    fd_data_speed_bps: number | null;
  }
> {
  const out = new Map<
    string,
    {
      speed_bps: number | null;
      fd: boolean | null;
      fd_data_speed_bps: number | null;
    }
  >();
  for (const s of status.sessions) {
    for (const b of s.bindings) {
      out.set(b.busId, {
        speed_bps: b.speedBps ?? null,
        fd: b.fd ?? null,
        fd_data_speed_bps: b.fdDataSpeedBps ?? null,
      });
    }
  }
  return out;
}
