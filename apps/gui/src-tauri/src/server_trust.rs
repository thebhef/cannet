//! Per-server trust: the certificate pin, the bearer token, and any
//! explicit "connect without protection" choice the operator made —
//! machine-local UI state held host-side
//! ([ADR 0032](../../../../docs/adr/0032-machine-local-ui-state-host-side.md)),
//! and the client half of
//! [ADR 0041](../../../../docs/adr/0041-remote-connection-security.md).
//!
//! **Its own file, `servers.json`, at user scope only.** Two reasons it
//! is not a key in `state.json`: that document has a *workspace* scope
//! (`.cannet/state.json` inside the project directory, ADR 0042), and a
//! bearer token that travelled with a project directory would be a
//! credential in whatever the project is checked into; and a pin is a
//! fact about a machine's relationship with a server, not about a
//! project. Nothing here is a *setting* either, so `settings.json` (ADR
//! 0034) is equally wrong.
//!
//! **Keyed by `host:port`.** A server that moves is a different entry
//! and re-prompts — the pin says nothing about where the identity may
//! appear, so accepting one address does not vouch for another.
//!
//! **The token is stored in the clear** and must never be logged. The
//! [`TrustEntry`] `Debug` impl redacts it, so a `{:?}` in an error or a
//! tracing event cannot leak it by accident; [`TrustEntry::token`] is
//! the only way to read the value.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// File name under `app_config_dir`.
pub(crate) const SERVERS_FILE: &str = "servers.json";

/// What the host knows about one server.
///
/// A pinned server has `fingerprint`; a pinned server that also needs a
/// credential has `token` as well. `insecure` is the separate, explicit
/// per-server choice to speak plaintext to a routable address — the
/// client-side mirror of the server's own `--insecure`.
#[derive(Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TrustEntry {
    /// The accepted certificate fingerprint, in the `SHA256:` +
    /// unpadded-base64 form the server prints and the user compares.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    /// The bearer token to present on every RPC. Stored in the clear;
    /// see the module docs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    /// The operator explicitly chose to connect to this routable
    /// address without protection. Never a default and never inferred
    /// from a failure — only a stored answer to the dialog.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub insecure: bool,
}

impl TrustEntry {
    /// Whether this entry says nothing at all, and so should not be
    /// persisted.
    pub(crate) fn is_empty(&self) -> bool {
        self.fingerprint.is_none() && self.token.is_none() && !self.insecure
    }
}

/// Redacts the token. The value is a credential; a `{:?}` anywhere near
/// a log line or an error string must not carry it.
impl std::fmt::Debug for TrustEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TrustEntry")
            .field("fingerprint", &self.fingerprint)
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .field("insecure", &self.insecure)
            .finish()
    }
}

/// The persisted document: every server the host has an opinion about,
/// keyed by its normalized `host:port`.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ServersDoc {
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub servers: BTreeMap<String, TrustEntry>,
}

/// The key a server address is filed under: scheme stripped, host
/// lowercased, everything else left alone.
///
/// Case is the only normalisation. `1.2.3.4:50051` and `bench:50051`
/// stay distinct even when they name the same machine, which is the
/// point — a pin vouches for an identity *at an address*.
pub(crate) fn server_key(address: &str) -> String {
    strip_scheme(address).to_ascii_lowercase()
}

/// `address` without a leading `scheme://`.
fn strip_scheme(address: &str) -> &str {
    match address.split_once("://") {
        Some((_, rest)) => rest,
        None => address,
    }
}

/// Read `dir/servers.json`. A missing, unreadable, or malformed file
/// reads as "nothing is trusted" rather than an error — the same
/// best-effort posture the rest of the host's config files take, and the
/// safe direction: the worst case is a re-prompt.
pub(crate) fn read_servers(dir: &Path) -> ServersDoc {
    match std::fs::read_to_string(dir.join(SERVERS_FILE)) {
        Ok(text) => crate::persisted_json::parse_or_default(&text),
        Err(_) => ServersDoc::default(),
    }
}

/// Write `doc` to `dir/servers.json`, creating the directory if needed.
/// Temp-file + rename, so a crash mid-write cannot leave a file that
/// parses as "nothing is trusted" and silently re-prompts for every
/// server.
pub(crate) fn write_servers(dir: &Path, doc: &ServersDoc) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    crate::persisted_json::write_json_atomic(&dir.join(SERVERS_FILE), doc)
}

/// Apply `edit` to `address`'s entry in `dir/servers.json` and write the
/// result back. An entry the edit leaves empty is removed, so forgetting
/// a server leaves no husk behind.
pub(crate) fn update_server(
    dir: &Path,
    address: &str,
    edit: impl FnOnce(&mut TrustEntry),
) -> std::io::Result<()> {
    let mut doc = read_servers(dir);
    let key = server_key(address);
    let mut entry = doc.servers.remove(&key).unwrap_or_default();
    edit(&mut entry);
    if !entry.is_empty() {
        doc.servers.insert(key, entry);
    }
    write_servers(dir, &doc)
}

/// One trusted server as the frontend sees it.
///
/// **The token is not in this shape.** A pinned-servers list needs to
/// say *that* a credential is stored, never what it is; the host
/// presents it on the wire itself, so nothing in the `WebView` has a use
/// for the value.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedServer {
    /// The `host:port` key, as filed.
    pub address: String,
    /// The accepted fingerprint — the same `SHA256:` string the server
    /// printed and the user compared.
    pub fingerprint: Option<String>,
    /// Whether a bearer token is stored for this server.
    pub has_token: bool,
    /// Whether the operator accepted an unprotected connection here.
    pub insecure: bool,
}

/// The config directory this store lives in.
fn store_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    crate::persisted_json::config_dir(app)
}

/// What the host has stored for `address`. An unresolvable config dir,
/// a missing file and a server nobody has answered a question about all
/// read the same way: nothing is trusted, so the connection starts at
/// trust-on-first-use.
pub(crate) fn trust_for(app: &tauri::AppHandle, address: &str) -> TrustEntry {
    let Ok(dir) = store_dir(app) else {
        return TrustEntry::default();
    };
    read_servers(&dir)
        .servers
        .remove(&server_key(address))
        .unwrap_or_default()
}

/// Persist an answer to a trust question, then let the connection that
/// was waiting on it try again: the pending prompt is dropped and any
/// running interface watch for `address` restarts against the new
/// decision, so accepting an identity connects rather than leaving the
/// user to find the retry button.
fn answered(
    app: &tauri::AppHandle,
    address: &str,
    write: std::io::Result<()>,
) -> Result<(), String> {
    write.map_err(|e| format!("failed to store the trust decision for {address}: {e}"))?;
    crate::connect_flow::resolved(app, address);
    crate::interfaces::rewatch(app, address);
    Ok(())
}

/// Tauri command — every server the host has accepted something for, so
/// the settings surface can list pins, show which carry a token, and
/// offer to forget them.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn list_trusted_servers(app: tauri::AppHandle) -> Vec<TrustedServer> {
    let Ok(dir) = store_dir(&app) else {
        return Vec::new();
    };
    read_servers(&dir)
        .servers
        .into_iter()
        .map(|(address, entry)| TrustedServer {
            address,
            fingerprint: entry.fingerprint,
            has_token: entry.token.is_some(),
            insecure: entry.insecure,
        })
        .collect()
}

/// Tauri command — accept `fingerprint` for `address` and store
/// `token` alongside it.
///
/// This is the write behind both the trust-on-first-use dialog and the
/// re-accept path out of a fingerprint mismatch: in either case the
/// user has just compared the string against the one the server
/// printed, so the new value replaces whatever was pinned before.
/// Accepting an identity also clears any earlier "connect without
/// protection" choice — the server is reachable over TLS after all.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn accept_server_fingerprint(
    app: tauri::AppHandle,
    address: String,
    fingerprint: String,
    token: Option<String>,
) -> Result<(), String> {
    let dir = store_dir(&app)?;
    let write = update_server(&dir, &address, |entry| {
        entry.fingerprint = Some(fingerprint);
        entry.insecure = false;
        if let Some(token) = token {
            entry.token = Some(token);
        }
    });
    answered(&app, &address, write)
}

/// Tauri command — replace the bearer token stored for `address`, the
/// way out of a rejected credential. An empty string removes it.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn set_server_token(
    app: tauri::AppHandle,
    address: String,
    token: String,
) -> Result<(), String> {
    let dir = store_dir(&app)?;
    let write = update_server(&dir, &address, |entry| {
        entry.token = if token.is_empty() { None } else { Some(token) };
    });
    answered(&app, &address, write)
}

/// Tauri command — record that the operator chose to reach `address`
/// without protection.
///
/// The client-side mirror of the server's `--insecure`: it exists only
/// as a stored answer to an explicit question, is scoped to one server,
/// and drops any pin and token, because a credential must never ride an
/// unencrypted channel (ADR 0041).
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn accept_server_insecure(app: tauri::AppHandle, address: String) -> Result<(), String> {
    let dir = store_dir(&app)?;
    let write = update_server(&dir, &address, |entry| {
        entry.insecure = true;
        entry.fingerprint = None;
        entry.token = None;
    });
    answered(&app, &address, write)
}

/// Tauri command — forget everything stored for `address`. The next
/// connection to it starts over at trust-on-first-use.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn forget_server(app: tauri::AppHandle, address: String) -> Result<(), String> {
    let dir = store_dir(&app)?;
    let write = update_server(&dir, &address, |entry| *entry = TrustEntry::default());
    answered(&app, &address, write)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    /// What the store holds for `address` — an empty entry when nothing.
    fn stored(dir: &Path, address: &str) -> TrustEntry {
        read_servers(dir)
            .servers
            .remove(&server_key(address))
            .unwrap_or_default()
    }

    #[test]
    fn a_pin_and_a_token_round_trip_through_the_file() {
        let d = dir();
        update_server(d.path(), "bench.local:50051", |e| {
            e.fingerprint = Some("SHA256:4EMRWrqj5MtP7Lxx4DjdNGUhBPIUijAl4UZekXCJwAc".into());
            e.token = Some("KMGqFEndqRji-y-f4Ej48LJZBu7Bjg2IfmRVMv-jHZE".into());
        })
        .unwrap();

        let entry = stored(d.path(), "bench.local:50051");
        assert_eq!(
            entry.fingerprint.as_deref(),
            Some("SHA256:4EMRWrqj5MtP7Lxx4DjdNGUhBPIUijAl4UZekXCJwAc"),
        );
        assert_eq!(
            entry.token.as_deref(),
            Some("KMGqFEndqRji-y-f4Ej48LJZBu7Bjg2IfmRVMv-jHZE"),
        );
        assert!(!entry.insecure);
    }

    #[test]
    fn servers_are_keyed_by_host_and_port_so_a_moved_server_is_a_new_entry() {
        // A pin vouches for an identity at an address; the same server
        // reached on another port has not been accepted there.
        let d = dir();
        update_server(d.path(), "bench:50051", |e| {
            e.fingerprint = Some("SHA256:aaa".into());
        })
        .unwrap();
        assert_eq!(
            stored(d.path(), "bench:50051").fingerprint.as_deref(),
            Some("SHA256:aaa"),
        );
        assert_eq!(stored(d.path(), "bench:50052").fingerprint, None);
        assert_eq!(stored(d.path(), "other:50051").fingerprint, None);
    }

    #[test]
    fn the_scheme_and_host_case_do_not_split_one_server_into_two_entries() {
        let d = dir();
        update_server(d.path(), "https://Bench:50051", |e| {
            e.fingerprint = Some("SHA256:aaa".into());
        })
        .unwrap();
        assert_eq!(
            stored(d.path(), "bench:50051").fingerprint.as_deref(),
            Some("SHA256:aaa"),
        );
    }

    #[test]
    fn forgetting_a_server_removes_its_entry_entirely() {
        let d = dir();
        update_server(d.path(), "bench:50051", |e| {
            e.fingerprint = Some("SHA256:aaa".into());
            e.token = Some("t".into());
        })
        .unwrap();
        update_server(d.path(), "bench:50051", |e| *e = TrustEntry::default()).unwrap();

        assert!(
            read_servers(d.path()).servers.is_empty(),
            "an emptied entry leaves no husk behind",
        );
    }

    #[test]
    fn an_insecure_choice_is_stored_per_server_and_never_defaulted() {
        let d = dir();
        assert!(!stored(d.path(), "bench:50051").insecure);
        update_server(d.path(), "bench:50051", |e| e.insecure = true).unwrap();
        assert!(stored(d.path(), "bench:50051").insecure);
        assert!(
            !stored(d.path(), "elsewhere:50051").insecure,
            "one server's choice says nothing about another's",
        );
    }

    #[test]
    fn a_missing_or_corrupt_file_trusts_nothing_rather_than_failing() {
        let d = dir();
        assert_eq!(read_servers(d.path()), ServersDoc::default());
        std::fs::write(d.path().join(SERVERS_FILE), "not json").unwrap();
        assert_eq!(read_servers(d.path()), ServersDoc::default());
        std::fs::write(d.path().join(SERVERS_FILE), "[1,2,3]").unwrap();
        assert_eq!(read_servers(d.path()), ServersDoc::default());
    }

    #[test]
    fn the_token_is_never_rendered_by_debug() {
        // The one hygiene rule the store has to keep on its own: a
        // `{:?}` in a log line or an error must not carry the credential.
        let entry = TrustEntry {
            fingerprint: Some("SHA256:aaa".into()),
            token: Some("super-secret-token".into()),
            insecure: false,
        };
        let rendered = format!("{entry:?}");
        assert!(!rendered.contains("super-secret-token"), "{rendered}");
        assert!(rendered.contains("SHA256:aaa"), "{rendered}");
    }

    #[test]
    fn an_empty_store_serializes_to_an_empty_object() {
        assert_eq!(
            serde_json::to_string(&ServersDoc::default()).unwrap(),
            "{}",
            "a fresh install writes no keys, not a wall of nulls",
        );
    }
}
