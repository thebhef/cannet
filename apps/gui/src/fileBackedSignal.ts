/// The one place the UI names a **file-backed signal**
/// (`docs/CONTEXT.md`): a value series imported from the capture file
/// as-is, with no bus message carrying it and no DBC decoding it.
///
/// Shared so the signal grid, the picker and anything else that lists
/// signals mark the same thing the same way — a source marking that
/// differed per surface would read as two different kinds of signal.

/// The badge text shown beside a file-backed row's channel-group label.
export const FILE_BACKED_BADGE = "file";

/// The picker path segment that stands where a DBC-backed signal shows
/// its transmitting ECU (a file-backed signal has none).
export const FILE_BACKED_LABEL = "(file-backed)";

/// Hover text explaining what the badge means.
export const FILE_BACKED_TITLE =
  "File-backed signal — imported from the capture file, not decoded from frames";
