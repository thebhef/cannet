/// Databases a capture carries, as the project panel treats them.
///
/// An MF4 can hold the databases it was recorded against. The host
/// loads each under an identity — `<capture>#<attachment name>` — and
/// says which loaded databases are such (`DbcInfo.embedded`). They are
/// listed and assigned to buses like any other, but they belong to the
/// session: nothing reloads them from disk, and a saved project does not
/// name them.

import type { DbcRef } from "./types";

/// What to call a capture's database: the attachment's own name, which
/// is the part of its identity after the capture it came from.
export function captureDatabaseName(identity: string): string {
  return identity.slice(identity.lastIndexOf("#") + 1);
}

/// The databases a project file names: the loaded ones that are the
/// project's own, each with the buses it is assigned to.
export function projectDbcRefs(
  dbcPaths: readonly string[],
  dbcBuses: Readonly<Record<string, string[]>>,
  captureDbcs: ReadonlySet<string>,
): DbcRef[] {
  return dbcPaths
    .filter((path) => !captureDbcs.has(path))
    .map((path) => ({ path, buses: dbcBuses[path] ?? [] }));
}
