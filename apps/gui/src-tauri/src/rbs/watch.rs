//! Filesystem watch on the `.cannet_rbs` files RBS elements have open.
//!
//! Same machinery as the DBC watcher's ([`crate::dbc_watcher`]) and the
//! project file's ([`crate::project_watch`]) — one `notify` backend, one
//! parent-directory watch set, one event-kind classification. What
//! differs is what a change *means*
//! ([ADR 0053](../../../docs/adr/0053-reload-when-it-applies-and-what-it-tells.md)
//! §1), and that is the whole of this module.
//!
//! An RBS file is an **app-owned document**, like the project file:
//! cannet writes it, and the in-memory copy can be ahead of it. Two
//! things follow.
//!
//! - **The host decides whether to apply it, because the host holds the
//!   facts.** An RBS applies silently only when the element is *clean
//!   and stopped* ([`outcome_for`]); the element's dirty flag and its
//!   Run flag both live in [`super::runtime::RbsElementState`], so the
//!   decision is made where they are. A running element is putting
//!   frames on a real bus — swapping its definitions underneath it is
//!   not a refresh but an uncommanded change of what the tool is
//!   sending — and unsaved overrides are the user's work. Either one
//!   means notify: [`super::runtime::RbsElementState::changed_on_disk`]
//!   is raised, the panel re-fetches, and the user gets *Apply anyway*.
//! - **cannet's own writes must not look like external edits.** Each
//!   element carries a [`crate::watched_file::WatchedFile`] recording
//!   the content it last exchanged with its file — read by the load
//!   path, written by Save — and an event is news only when what is on
//!   disk differs from it. Unlike the project there can be several open
//!   at once, so the record is per element, and two elements may even
//!   hold the same file ([`still_open`] is what keeps the shared watch
//!   set honest when one of them goes).
//!
//! Applying is [`super::commands::load_into_element`], the `.cannet_rbs`
//! load path itself — a reload is the existing load path, not a merge,
//! and it preserves the element's run/stopped state. Failure semantics
//! match the DBC watch: a file that will not read or will not parse
//! logs and leaves the in-memory element intact, and a deleted file is
//! reported but does not unload.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::app_state::AppState;
use crate::dbc_watcher::Reaction;
use crate::{sys_error, sys_info, sys_warn};

use super::file_model::RbsFile;
use super::runtime::RbsElementState;

/// What an external change to an element's `.cannet_rbs` calls for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Outcome {
    /// Swap it in: nothing of the user's is at risk.
    Apply,
    /// Tell the user and wait: applying would cost them something.
    Notify,
}

/// ADR 0053 §1's rule for an RBS file, as one expression: it applies
/// silently only when the element is **clean and stopped**.
///
/// Both inputs are the host's own state, which is why this decision is
/// made here rather than in the frontend (the project's, whose dirty
/// bit exists only frontend-side, is made there — same rule, different
/// answer, because the facts sit in different places).
pub(super) fn outcome_for(dirty: bool, run: bool) -> Outcome {
    if dirty || run {
        Outcome::Notify
    } else {
        Outcome::Apply
    }
}

/// Whether any element still has `path` open. Asked after an element
/// has already been removed from / re-pointed away from the map, so a
/// `true` means some *other* element is holding the watch and this one
/// must not give it up.
pub(super) fn still_open(elements: &HashMap<String, RbsElementState>, path: &Path) -> bool {
    elements.values().any(|e| e.watch.is(path))
}

/// Filesystem-event hook, called from the DBC watcher's `notify`
/// callback. An RBS file is never also a loaded DBC or the project
/// file, so the three reactions are independent.
pub(crate) fn on_event(app: &AppHandle, event: &notify::Event) {
    let hits: Vec<(String, PathBuf)> = {
        let state: State<'_, AppState> = app.state();
        let rbs = state.rbs();
        rbs.elements
            .iter()
            .filter_map(|(id, e)| {
                let path = e.watch.path()?;
                event
                    .paths
                    .iter()
                    .any(|p| p == path)
                    .then(|| (id.clone(), path.to_path_buf()))
            })
            .collect()
    };
    if hits.is_empty() {
        return;
    }
    // `true` where the DBC watch reads `dbc_auto_reload`: that setting
    // is the opt-out for a *database* swapping under an analysis, and a
    // different document is in question here.
    match crate::dbc_watcher::reaction_to(event.kind, true) {
        Reaction::Ignore => {}
        Reaction::NoteRemoval => {
            for (id, path) in hits {
                sys_warn!(
                    app,
                    "rbs-watch",
                    "RBS file removed on disk: {} (element {id} is unchanged)",
                    path.display()
                );
            }
        }
        Reaction::Reload => {
            for (id, path) in hits {
                consider(app, &id, &path);
            }
        }
    }
}

/// Re-read one element's file and, if what is on disk is not what the
/// app last exchanged with it, either apply it or say so.
///
/// The read runs under the RBS lock, which is what makes cannet's own
/// saves invisible here: `write_element` writes under that same lock
/// (see [`crate::watched_file::write_recording`]), so this either reads
/// before the write started and matches the pre-write record, or after
/// it finished and matches the post-write one — never the new file
/// against the old record.
fn consider(app: &AppHandle, element_id: &str, path: &Path) {
    let state: State<'_, AppState> = app.state();
    let outcome = {
        let mut rbs = state.rbs();
        let Some(element) = rbs.elements.get_mut(element_id) else {
            return; // unloaded between the event and this read
        };
        if !element.watch.is(path) {
            return; // re-pointed in the meantime
        }
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) => {
                sys_error!(
                    app,
                    "rbs-watch",
                    "couldn't read the RBS file after a change at {}: {e}",
                    path.display()
                );
                return;
            }
        };
        if !element.watch.is_external(&text) {
            return; // cannet's own save, or a rewrite of identical bytes
        }
        // A hand-edited file passes through syntactically broken states.
        // The in-memory element is untouched either way; announcing a
        // broken one would put an Apply in front of the user that cannot
        // succeed.
        if let Err(e) = RbsFile::parse(&text) {
            sys_error!(
                app,
                "rbs-watch",
                "couldn't parse the RBS file after a change at {}: {e}",
                path.display()
            );
            return;
        }
        let outcome = outcome_for(element.dirty, element.run);
        if outcome == Outcome::Notify {
            // Record it even though nothing is applied: the user has
            // been told about *these* bytes, and a further edit should
            // be able to tell them again.
            element.watch.record(text);
            element.changed_on_disk = true;
        }
        outcome
    };
    match outcome {
        Outcome::Apply => {
            // The existing load path, which re-reads, re-parses, keeps
            // the element's run state and re-records the watch.
            if super::commands::load_into_element(app, &state, element_id, path).is_ok() {
                sys_info!(
                    app,
                    "rbs-watch",
                    "auto-reloaded RBS config {} (element {element_id} was clean and stopped)",
                    path.display()
                );
            }
        }
        Outcome::Notify => {
            sys_info!(
                app,
                "rbs-watch",
                "RBS file changed on disk: {} (element {element_id} has unsaved edits or is running — not applied)",
                path.display()
            );
            let _ = app.emit("rbs-changed", element_id.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    //! What is testable without an `AppHandle`: the rule that decides
    //! apply-vs-notify, and the shared-file bookkeeping the watch set
    //! depends on. An `AppHandle`-driven test is out of reach here —
    //! Tauri's mock runtime fails to load the `cannet-gui` test binary
    //! on this platform (`STATUS_ENTRYPOINT_NOT_FOUND`, most likely a
    //! `WebView2` loader export the `test` feature links differently),
    //! not merely to construct one.

    use super::*;
    use crate::watched_file::WatchedFile;

    fn element(path: Option<&str>) -> RbsElementState {
        let mut watch = WatchedFile::default();
        if let Some(p) = path {
            watch.point_at(Path::new(p), String::new());
        }
        RbsElementState {
            watch,
            file: RbsFile::new(),
            dirty: false,
            run: false,
            changed_on_disk: false,
        }
    }

    #[test]
    fn a_clean_stopped_element_takes_the_change_silently() {
        assert_eq!(outcome_for(false, false), Outcome::Apply);
    }

    #[test]
    fn unsaved_overrides_are_told_about_rather_than_overwritten() {
        assert_eq!(outcome_for(true, false), Outcome::Notify);
    }

    #[test]
    fn a_transmitting_element_is_told_about_even_when_it_is_clean() {
        // The reason this is not weighed against dirtiness: a running
        // RBS is putting frames on a real bus, so swapping its
        // definitions underneath it changes what the tool is sending
        // without anyone asking for it.
        assert_eq!(outcome_for(false, true), Outcome::Notify);
    }

    #[test]
    fn a_dirty_running_element_is_told_about_too() {
        assert_eq!(outcome_for(true, true), Outcome::Notify);
    }

    #[test]
    fn a_file_a_second_element_still_has_open_keeps_its_watch() {
        // Unlike the project there can be several RBS files open, and
        // nothing stops two elements pointing at one. Giving up the
        // shared watch when the first unloads would leave the second
        // silently unwatched.
        let mut elements = HashMap::new();
        elements.insert("a".to_string(), element(Some("/p/sim.cannet_rbs")));
        elements.insert("b".to_string(), element(Some("/p/sim.cannet_rbs")));
        elements.remove("a");
        assert!(still_open(&elements, Path::new("/p/sim.cannet_rbs")));
        elements.remove("b");
        assert!(!still_open(&elements, Path::new("/p/sim.cannet_rbs")));
    }

    #[test]
    fn an_element_that_never_touched_disk_holds_no_watch() {
        let mut elements = HashMap::new();
        elements.insert("a".to_string(), element(None));
        assert!(!still_open(&elements, Path::new("/p/sim.cannet_rbs")));
    }
}
