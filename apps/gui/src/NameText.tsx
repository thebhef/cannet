import { splitName } from "./nameEllipsis";

/// One entity name — a message, a signal, an ECU — rendered so that a
/// column too narrow for it drops the *middle* rather than the end,
/// and so the full text stays reachable as a tooltip.
///
/// A name within the classic DBC identifier limit renders as the bare
/// string it always did: no wrapper, no split, no behaviour change, so
/// this can go at every name site without churning the ones that were
/// never at risk. Past that limit the name only exists because of the
/// long-symbol extension, and it renders as a shrinkable head plus a
/// fixed tail — the head carries the ellipsis, so the tail, which is
/// where DBC symbols differ, survives whatever width the column model
/// hands it. The width is never read from the name: `.name-text` is
/// capped at its container, so one pathological signal cannot reflow a
/// panel.
///
/// Enum labels do not come here. They are prose, read front-first, and
/// keep ordinary end-ellipsis (ADR 0026).
///
/// It renders inline, so it drops into whatever cell, span or heading
/// already styles the name.
export function NameText({
  name,
  title,
}: {
  name: string;
  /// Tooltip override, for a caller whose own title says more than the
  /// name (a drag hint, say). Defaults to the full name.
  title?: string;
}) {
  const { head, tail } = splitName(name);
  if (tail === "") return <>{name}</>;
  return (
    <span className="name-text" title={title ?? name}>
      <span className="name-text-head">{head}</span>
      <span className="name-text-tail">{tail}</span>
    </span>
  );
}
