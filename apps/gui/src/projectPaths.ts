/// Resolving the file references a project document carries.
///
/// A project file references its DBCs and `.cannet_rbs` configs by
/// path. Those paths may be **relative to the project file's own
/// directory** (so a checked-in example opens from any clone location)
/// or absolute (what the GUI writes when you add a file through the
/// picker). On open, the relative ones are resolved against the
/// directory the project was loaded from before they reach the host
/// commands, which read straight from disk. See ADR 0030.

/// Directory portion of a project-file path, native separators
/// preserved (no trailing separator). `""` if the path has none.
export function projectDir(projectFilePath: string): string {
  const idx = Math.max(
    projectFilePath.lastIndexOf("/"),
    projectFilePath.lastIndexOf("\\"),
  );
  return idx >= 0 ? projectFilePath.slice(0, idx) : "";
}

/// True for an absolute path: a POSIX root (`/…`), a Windows drive
/// (`C:\…` / `C:/…`), or a UNC / drive-relative leading separator.
function isAbsolute(p: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(p);
}

/// Resolve a project-referenced path against the project file's
/// directory (ADR 0030). Absolute paths — and the empty string — pass
/// through unchanged; a relative path is joined onto `dir` using the
/// separator `dir` already uses. With no directory (`dir === ""`) the
/// path is returned as-is.
export function resolveProjectPath(dir: string, p: string): string {
  if (p === "" || dir === "" || isAbsolute(p)) return p;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir}${sep}${p}`;
}
