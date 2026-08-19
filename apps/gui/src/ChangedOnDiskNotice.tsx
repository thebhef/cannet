// The one statement cannet makes when a file it has open changed
// underneath it and applying the change was not safe (ADR 0053 §1): a
// persistent chip carrying the action that applies it and the action
// that ends it.
//
// Shared rather than copied per surface. The project's notice lives in
// the header and an RBS element's lives in its panel, but they are the
// same object with different words, and a per-surface copy is how the
// two drift apart.
//
// The contract this carries, beyond the markup, is that **a notice
// refers to something and goes when that something is gone** — applied,
// saved, or closed. Neither caller may leave one showing over a file it
// no longer describes:
//
// - the RBS notice is a view over host state (`rbs_view.changedOnDisk`,
//   which the load, the save and the dismiss all clear host-side), so
//   it cannot go stale;
// - the project's is frontend state (the dirty bit that decides it is
//   frontend-only), so `App` clears it at those same three points.
//
// Persistent rather than a transient flash: it is a decision waiting on
// the user, not a status message. Shaped like the cache-rebuild chip
// beside it — a statement, and the way out of it.

/// One of the notice's two buttons. `label` is the visible text for the
/// action and the *accessible* name for Dismiss (whose visible text is
/// always the word "Dismiss").
export interface NoticeAction {
  label: string;
  title: string;
  onClick: () => void;
}

export function ChangedOnDiskNotice({
  statement,
  action,
  dismiss,
}: {
  /// What happened, in the user's terms — "Project changed on disk".
  statement: string;
  /// The only thing that applies the change.
  action: NoticeAction;
  /// Keep what is in memory and stop being told about it.
  dismiss: Omit<NoticeAction, "label"> & { label: string };
}) {
  return (
    <span className="changed-on-disk">
      {statement}
      <button type="button" title={action.title} onClick={action.onClick}>
        {action.label}
      </button>
      <button
        type="button"
        aria-label={dismiss.label}
        title={dismiss.title}
        onClick={dismiss.onClick}
      >
        Dismiss
      </button>
    </span>
  );
}
