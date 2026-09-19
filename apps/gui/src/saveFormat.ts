// The capture-save format: one save gesture, two writers.
//
// `capture.save` stays a single command; the format is picked from the
// save dialog's filter list and reaches the host as an explicit argument.
// The host never sniffs the path — routing a write off a file extension
// is how a "Save as MDF" ends up producing a BLF named `.mf4`.
//
// The dialog is the OS's own, and it reports the chosen filter in exactly
// one way: it stamps that filter's extension onto the path it returns.
// So the mapping filter → format happens here, once, on a pure function
// this file's tests pin — and what crosses the wire is the format, not
// the path.

/// What the host's `save_capture` accepts for its `format` argument.
export type SaveFormat = "blf" | "mdf";

/// The save dialog's filter list, in offer order. BLF stays first: it is
/// the format the capture views were built against, and the smaller file
/// for a frames-only capture.
export const SAVE_CAPTURE_FILTERS = [
  { name: "Vector BLF", extensions: ["blf"] },
  { name: "ASAM MDF", extensions: ["mf4"] },
];

/// Default file name the dialog opens with — the first filter's.
export const DEFAULT_SAVE_CAPTURE_NAME = "capture.blf";

/// The filter list with `preferred`'s filter first.
///
/// An OS save dialog pre-selects whichever filter it is handed first,
/// and that is the only handle there is on which format it opens with —
/// so the remembered last-used format reaches the picker as filter
/// *order*. Both formats are still offered; only the default changes.
export function saveCaptureFilters(preferred: SaveFormat) {
  const wanted = saveCaptureExtension(preferred).slice(1);
  return [...SAVE_CAPTURE_FILTERS].sort((a, b) =>
    Number(b.extensions[0] === wanted) - Number(a.extensions[0] === wanted),
  );
}

/// The extension a format's file carries, dot included — what the name
/// preview appends to the resolved template, since the extension comes
/// from the chosen format and never from the template itself.
export function saveCaptureExtension(format: SaveFormat): string {
  return format === "mdf" ? ".mf4" : ".blf";
}

/// The format the user chose, read off the extension the dialog stamped
/// on `path`. Anything that is not an MDF extension is a BLF, so a path
/// typed by hand with no extension at all still saves as something.
export function saveFormatFor(path: string): SaveFormat {
  return /\.(mf4|mdf)$/i.test(path.trim()) ? "mdf" : "blf";
}

/// `folder` and `name` as one path, in `folder`'s own separator style.
///
/// Seeds the picker's file-name field *inside* the remembered folder:
/// a `defaultPath` that is a bare name opens wherever the OS last was,
/// which is exactly what the sticky folder exists to stop.
export function joinExportPath(folder: string, name: string): string {
  const sep = folder.includes("\\") ? "\\" : "/";
  return folder.endsWith("/") || folder.endsWith("\\")
    ? `${folder}${name}`
    : `${folder}${sep}${name}`;
}

/// The folder part of a path the picker returned, or `null` for a bare
/// name — "nothing remembered" rather than an empty folder, which would
/// seed the next picker with a path it cannot open.
export function exportFolderOf(path: string): string | null {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : null;
}
