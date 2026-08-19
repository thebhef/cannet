//! The record that tells cannet's own write of an **app-owned
//! document** from someone else's edit of it, plus the two operations
//! every such watch needs: moving the shared watch set, and writing
//! under the record's lock.
//!
//! Shared by the open project file's watch ([`crate::project_watch`])
//! and the RBS elements' ([`crate::rbs::watch`]) — the two file kinds
//! [ADR 0053](../../../docs/adr/0053-reload-when-it-applies-and-what-it-tells.md)
//! §1 calls app-owned. A DBC needs none of this: cannet never writes
//! one, so every event on it is unambiguously news.
//!
//! The problem this solves is that cannet's own Save raises exactly the
//! filesystem events an external editor's would. So the record holds
//! the content the app last **exchanged** with the file — what a load
//! read, what a save wrote — and an event is news only when what is on
//! disk differs from it.

use std::path::{Path, PathBuf};

use crate::app_state::AppState;

/// One app-owned file the session has open, plus the content the app
/// last exchanged with it.
///
/// `content` is `None` for a document that has never touched disk (a
/// fresh RBS element), which makes the first thing found there news —
/// the honest answer when the app has nothing to compare against.
#[derive(Debug, Default)]
pub struct WatchedFile {
    path: Option<PathBuf>,
    content: Option<String>,
}

impl WatchedFile {
    /// The watched file's path, if the document has one.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// The path as the IPC surfaces carry it.
    pub fn path_string(&self) -> Option<String> {
        self.path.as_ref().map(|p| p.display().to_string())
    }

    /// Whether this record is pointing at `path`.
    pub fn is(&self, path: &Path) -> bool {
        self.path.as_deref() == Some(path)
    }

    /// Whether `text` — what is on disk now — differs from the content
    /// the app last exchanged with the file, i.e. whether this is news.
    pub fn is_external(&self, text: &str) -> bool {
        self.content.as_deref() != Some(text)
    }

    /// Record `text` as the content the app has for the file, leaving
    /// the record pointing where it already points.
    pub fn record(&mut self, text: String) {
        self.content = Some(text);
    }

    /// Point the record at `path`, holding `text` as its content.
    /// Returns the path it was pointing at when that was a *different*
    /// file — what the caller has to move the watch off.
    pub fn point_at(&mut self, path: &Path, text: String) -> Option<PathBuf> {
        let previous = self.path.replace(path.to_path_buf());
        self.content = Some(text);
        previous.filter(|p| p != path)
    }

    /// Forget the file — the project was closed, the element unloaded.
    /// Returns the path that was being watched.
    pub fn forget(&mut self) -> Option<PathBuf> {
        self.content = None;
        self.path.take()
    }
}

/// Move the shared watch set ([`crate::dbc_watcher`]) off `old` and on
/// to `new`. Both app-owned watches ride that same set — there is one
/// `notify` backend in the app, not one per file kind.
pub(crate) fn move_watch(state: &AppState, old: Option<&Path>, new: Option<&Path>) {
    if old == new {
        return;
    }
    let mut watcher = state.dbc_watcher();
    let Some(watcher) = watcher.as_mut() else {
        return;
    };
    if let Some(old) = old {
        watcher.unwatch_file(old);
    }
    if let Some(new) = new {
        watcher.watch_file(new);
    }
}

/// Perform cannet's own write of `path` and record what landed on disk
/// as the content the app has for it.
///
/// Taking `record` by `&mut` is the point: the caller is holding the
/// watch record's lock, and the write runs **under** it. That is what
/// makes the record race-free — the event path reads the file under the
/// same lock, so it either reads before the write started (and matches
/// the pre-write record) or after it finished (and matches the
/// post-write one), never the new file against the old record.
///
/// Returns the path the record was pointing at when the write moved it
/// (Save As), so the caller can move the watch.
pub(crate) fn write_recording<F>(
    record: &mut WatchedFile,
    path: &Path,
    write: F,
) -> std::io::Result<Option<PathBuf>>
where
    F: FnOnce() -> std::io::Result<()>,
{
    write()?;
    // Read back rather than keeping what the serializer produced: the
    // bytes on disk are what an event will be compared against.
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(record.point_at(path, text)),
        Err(_) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recorded(path: &str, content: &str) -> WatchedFile {
        let mut f = WatchedFile::default();
        f.point_at(Path::new(path), content.to_string());
        f
    }

    #[test]
    fn a_file_holding_what_the_app_last_exchanged_with_it_is_not_news() {
        // The reason this record exists: cannet writes these files, and
        // a Save raises the same events an editor's would.
        assert!(!recorded("/p/x.cannet_prj", "{\"a\":1}").is_external("{\"a\":1}"));
    }

    #[test]
    fn a_file_holding_anything_else_is_news() {
        assert!(recorded("/p/x.cannet_prj", "{\"a\":1}").is_external("{\"a\":2}"));
    }

    #[test]
    fn a_document_the_app_has_never_read_is_news() {
        // No recorded content — a watch installed without an exchange
        // has nothing to compare against, so the honest answer is
        // "changed".
        assert!(WatchedFile::default().is_external("{}"));
    }

    #[test]
    fn re_recording_the_same_file_names_no_path_to_unwatch() {
        // Every save re-records; only a *move* (Save As, opening a
        // different file) has an old watch to give up.
        let mut f = recorded("/p/x.cannet_prj", "{}");
        assert_eq!(
            f.point_at(Path::new("/p/x.cannet_prj"), "{\"a\":1}".into()),
            None
        );
    }

    #[test]
    fn moving_to_another_file_names_the_one_it_left() {
        let mut f = recorded("/p/x.cannet_prj", "{}");
        assert_eq!(
            f.point_at(Path::new("/p/y.cannet_prj"), "{}".into()),
            Some(PathBuf::from("/p/x.cannet_prj")),
        );
    }
}
