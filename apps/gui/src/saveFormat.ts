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

/// The format the user chose, read off the extension the dialog stamped
/// on `path`. Anything that is not an MDF extension is a BLF, so a path
/// typed by hand with no extension at all still saves as something.
export function saveFormatFor(path: string): SaveFormat {
  return /\.(mf4|mdf)$/i.test(path.trim()) ? "mdf" : "blf";
}
