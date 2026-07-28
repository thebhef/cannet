/// Toggle `key`'s membership in `set`, returning a new `Set` — never
/// mutates the input. The React state-update shape (`setX((prev) =>
/// toggleInSet(prev, key))`) was hand-rolled at six call sites
/// (expand/collapse tracking in TraceView, TracePanel, DbcPanel ×2,
/// RbsPanel ×2 — verbatim twice over in RbsPanel alone).
export function toggleInSet<T>(set: ReadonlySet<T>, key: T): Set<T> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
