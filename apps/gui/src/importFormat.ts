// The trace-import format: one "Import trace…" action, two readers.
//
// Mirrors `saveFormat.ts`'s reasoning in the open direction: the file
// dialog's filter list offers both formats (plus "all supported"), but
// unlike a save dialog, an open dialog never reports which filter
// matched — only the path. So the format is read off the path's own
// extension, same as `saveFormatFor`, and travels to the host as an
// explicit argument to the format-specific scan/import command
// (`scan_blf_channels`/`open_log` or `scan_mdf_channels`/`import_mdf`)
// — the host still never sniffs the file.

import type { OpenDialogOptions } from "@tauri-apps/plugin-dialog";

/// What the frontend routes a picked path to: `scan_blf_channels` /
/// `open_log`, or `scan_mdf_channels` / `import_mdf`.
export type ImportFormat = "blf" | "mdf";

/// The Import-trace dialog's filter list, in offer order. "All
/// supported traces" first, so picking a file doesn't require knowing
/// its format ahead of time; the single-format filters stay for a user
/// who wants the dialog to hide the other kind.
export const IMPORT_TRACE_FILTERS: NonNullable<OpenDialogOptions["filters"]> = [
  { name: "All supported traces", extensions: ["blf", "mf4"] },
  { name: "Vector BLF", extensions: ["blf"] },
  { name: "ASAM MDF", extensions: ["mf4"] },
];

/// The format a picked path routes to, read off its extension. Anything
/// that isn't an MDF extension is a BLF, matching `saveFormatFor`'s
/// leniency for a hand-typed or recents-list path with no filter behind
/// it.
export function importFormatFor(path: string): ImportFormat {
  return /\.(mf4|mdf)$/i.test(path.trim()) ? "mdf" : "blf";
}
