/// Translating the file references a project document carries between
/// their stored and their usable form.
///
/// A project file references its DBCs and `.cannet_rbs` configs by
/// path. A file that lives **inside the project directory** is stored
/// **relative to the project file's own directory**, so the directory
/// is movable and shareable as a unit; a file outside it is stored
/// absolute, because there is nothing to anchor it to.
///
/// Both directions live here. On open, `resolveProjectPath` turns the
/// relative references into absolute ones before they reach the host
/// commands, which read straight from disk. On save,
/// `relativizeProjectPath` does the reverse for the files that qualify.
/// See ADR 0030.

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

/// True for a Windows-shaped path (`C:\…` / `C:/…`), which decides
/// whether the containment test below compares case-insensitively.
function isWindowsPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p);
}

/// The inverse of `resolveProjectPath`: the form a project file should
/// *store* for `p`, given the project file's directory (ADR 0030).
///
/// A path inside `dir` becomes relative to it, with forward slashes —
/// the form that survives the project directory being copied to another
/// path or another machine. Everything else is returned unchanged: a
/// path already relative, a file genuinely outside the project directory
/// (nothing to anchor it to), or the degenerate empty cases.
///
/// Containment is a prefix test on the text, not a filesystem question —
/// this runs in the renderer, which has no filesystem. It therefore
/// deliberately does not climb out with `../`, resolve `.` segments, or
/// follow links: a reference it isn't sure about stays absolute, which
/// is always correct.
export function relativizeProjectPath(dir: string, p: string): string {
  if (p === "" || dir === "" || !isAbsolute(p)) return p;
  const prefix = `${dir.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
  const path = p.replace(/\\/g, "/");
  const head = path.slice(0, prefix.length);
  const contained = isWindowsPath(dir)
    ? head.toLowerCase() === prefix.toLowerCase()
    : head === prefix;
  const rest = path.slice(prefix.length);
  return contained && rest !== "" ? rest : p;
}
