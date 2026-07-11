/// The native window title for a given project state: the project
/// file's basename without its extension, suffixed with the app name
/// (`Bench Rig — cannet`), or the bare app name when no project is
/// open. Pure so it's unit-testable; `App.tsx` pushes the result to
/// the OS title bar via `getCurrentWindow().setTitle`.
export function windowTitle(projectPath: string | null): string {
  if (projectPath === null) return "cannet";
  const sep = Math.max(projectPath.lastIndexOf("/"), projectPath.lastIndexOf("\\"));
  const base = sep >= 0 ? projectPath.slice(sep + 1) : projectPath;
  // Strip the last extension only (`.cannet_prj`, legacy `.json`) —
  // a dot elsewhere in the name is part of the name.
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `${stem} — cannet`;
}
