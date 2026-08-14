//! The one list of servers this machine knows about: what is
//! advertising on the subnet ([`crate::server_browse`]) merged with
//! what has been accepted here ([`crate::server_trust`], ADR 0032),
//! keyed by `host:port`.
//!
//! **The merge is a model fact, so it lives here and not in the
//! `WebView`.** Whether a row is trusted, whether the identity it is
//! presenting now is the one that was pinned, and whether it is
//! currently answering are all things only the host can say: the trust
//! store is host-side, the browse is host-side, and the observed
//! certificate only ever exists inside a connection attempt
//! ([`crate::connect_flow`]). The frontend receives finished rows and
//! renders them.
//!
//! ## What "trusted" is allowed to mean
//!
//! Exactly what [`crate::connect_flow::plan`] does with the same
//! address and entry: a row is [`TrustState::Trusted`] when the next
//! connection goes through without a question — a pin, an explicit
//! unprotected choice, or a loopback address, which is reached in the
//! clear and never asked about — and [`TrustState::New`] otherwise. A
//! stored token on its own is not trust; the connection would still
//! stop at the certificate.
//!
//! [`TrustState::FingerprintChanged`] is the one state that cannot be
//! read off the store, because it is a comparison against what a server
//! *presented*. The host learns that only by dialling, so the badge
//! follows the pending [`TrustPrompt::IdentityChanged`] the refused
//! attempt left behind — a real observation, never a guess.

use std::collections::BTreeMap;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::connect_flow::{ServerPrompts, TrustPrompt};
use crate::server_browse::{BrowseStatus, DiscoveredServer, DiscoveredServers};
use crate::server_trust::{server_key, TrustEntry};

/// Tauri event emitted whenever the merged list moves — a browse
/// change, a trust write, a new trust question, or the browse task's
/// own health. Payload is the whole snapshot: a subnet's worth of
/// servers, so there is no diff format.
pub const SERVER_LIST_CHANGED_EVENT: &str = "server-list-changed";

/// Where one server stands with this machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TrustState {
    /// Nothing stored that would carry a connection through. First
    /// contact still has to be accepted.
    New,
    /// A stored decision — a pinned fingerprint, or an explicit
    /// unprotected choice — reaches this server without asking.
    Trusted,
    /// The server presented a certificate that is not the pinned one,
    /// and the connection was refused. Someone has to look.
    FingerprintChanged,
}

/// One server, as the panel renders it.
///
/// Discovered-only fields are `None` for a row that exists purely
/// because something was accepted for it: a trusted server that is
/// switched off is still a row, greyed, so forgetting it does not
/// require waiting for it to come back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRow {
    /// The normalized `host:port` — the row's identity, its React key,
    /// and the argument every action here takes.
    pub address: String,
    /// The DNS-SD instance name (`--name`). Discovered rows only.
    pub name: Option<String>,
    /// The machine the server runs on, from the SRV target host.
    /// Discovered rows only.
    pub host: Option<String>,
    /// The server's release, from its `ver` TXT key. Discovered rows
    /// only.
    pub version: Option<String>,
    /// Whether the server is advertising right now.
    pub online: bool,
    pub trust: TrustState,
    /// The accepted fingerprint, in the `SHA256:` form the server
    /// printed — the string a user compared once and can compare again.
    pub fingerprint: Option<String>,
    /// Whether a token is stored. Never the token itself: the host
    /// presents it on the wire, so nothing in the `WebView` has a use
    /// for the value.
    pub has_token: bool,
    /// The operator accepted an unprotected connection to this address.
    pub insecure: bool,
    /// The question the host is currently waiting on for this server,
    /// if any — so the panel can put the same dialog in front of the
    /// user without asking the connection to fail again.
    pub prompt: Option<TrustPrompt>,
}

/// The panel's whole model: the merged rows and what the browse task
/// has to say about itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerList {
    pub servers: Vec<ServerRow>,
    pub browse: BrowseStatus,
}

/// Merge the three sources into the rows the panel renders. Each of
/// them can put a row in the list on its own: something stored, something
/// advertising, or a question the host is waiting on.
///
/// Keyed by [`server_key`] throughout, because that is what the trust
/// store files entries under: a browsed `192.168.1.10:50051` and an
/// accepted one are the same server, and a prompt raised against
/// `https://Bench:50051` is about the same row as `bench:50051`.
#[must_use]
pub fn merge(
    discovered: &[DiscoveredServer],
    trusted: &BTreeMap<String, TrustEntry>,
    prompts: &BTreeMap<String, TrustPrompt>,
    browse: BrowseStatus,
) -> ServerList {
    let mut rows: BTreeMap<String, ServerRow> = BTreeMap::new();

    // Every stored entry is a row, whether or not anything answers at
    // it — the store is the thing this panel manages.
    for (address, entry) in trusted {
        rows.insert(server_key(address), offline_row(address, entry));
    }
    // The browse layers the live facts over them.
    for server in discovered {
        let key = server_key(&server.address);
        let row = rows
            .entry(key.clone())
            .or_insert_with(|| offline_row(&key, &TrustEntry::default()));
        row.name = Some(server.name.clone());
        row.host.clone_from(&server.host);
        row.version.clone_from(&server.version);
        row.online = true;
    }

    // Prompts are keyed by whatever address the connection was made
    // with, so they are normalized before they can find their row.
    let by_key: BTreeMap<String, &TrustPrompt> = prompts
        .iter()
        .map(|(address, prompt)| (server_key(address), prompt))
        .collect();
    // A question the host is waiting on is a fact about a server too,
    // and for an address that was dialled by hand it is the only one:
    // nothing is stored for it yet and nothing is advertising it, so
    // without a row of its own the question could not be answered.
    for key in by_key.keys() {
        rows.entry(key.clone())
            .or_insert_with(|| offline_row(key, &TrustEntry::default()));
    }
    for (key, row) in &mut rows {
        row.prompt = by_key.get(key).map(|p| (*p).clone());
        if matches!(row.prompt, Some(TrustPrompt::IdentityChanged { .. })) {
            row.trust = TrustState::FingerprintChanged;
        }
    }

    let mut servers: Vec<ServerRow> = rows.into_values().collect();
    // Reachable servers first, then by the label the row leads with.
    // A server going offline drops to the bottom rather than leaving a
    // greyed gap in the middle of the list.
    servers
        .sort_by(|a, b| (!a.online, label(a), &a.address).cmp(&(!b.online, label(b), &b.address)));
    ServerList { servers, browse }
}

/// What the row leads with, for ordering: its instance name when it has
/// one, its address otherwise.
fn label(row: &ServerRow) -> &str {
    row.name.as_deref().unwrap_or(&row.address)
}

/// A row carrying only what the trust store knows.
fn offline_row(address: &str, entry: &TrustEntry) -> ServerRow {
    ServerRow {
        address: server_key(address),
        name: None,
        host: None,
        version: None,
        online: false,
        trust: trust_state(address, entry),
        fingerprint: entry.fingerprint.clone(),
        has_token: entry.token.is_some(),
        insecure: entry.insecure,
        prompt: None,
    }
}

/// Trusted exactly when the next connection goes through without a
/// question — [`crate::connect_flow::needs_trust`]'s answer, not a
/// second reading of the store. A pin and an accepted unprotected
/// choice are stored decisions; a loopback address needs no decision at
/// all, and a row for one must not invite a question that will never be
/// asked.
fn trust_state(address: &str, entry: &TrustEntry) -> TrustState {
    if crate::connect_flow::needs_trust(address, entry) {
        TrustState::New
    } else {
        TrustState::Trusted
    }
}

/// The current merged list. Reads the trust store from disk each time:
/// it is a handful of entries, and the alternative — a cached copy
/// host-side — is a second authority that can drift from the file.
fn build(app: &AppHandle) -> ServerList {
    let discovered = app
        .try_state::<DiscoveredServers>()
        .map_or_else(Vec::new, |s| s.snapshot());
    let browse = app
        .try_state::<DiscoveredServers>()
        .map_or_else(BrowseStatus::default, |s| s.status());
    let prompts = app
        .try_state::<ServerPrompts>()
        .map_or_else(BTreeMap::new, |p| p.snapshot());
    let trusted = crate::persisted_json::config_dir(app)
        .map(|dir| crate::server_trust::read_servers(&dir).servers)
        .unwrap_or_default();
    merge(&discovered, &trusted, &prompts, browse)
}

/// Push the merged list at the frontend. Called from every write path
/// that can move it — the browse reducer, the browse task's health, the
/// trust store's writes, and the pending-question map — so the panel
/// cannot drift from the model behind it.
pub(crate) fn changed(app: &AppHandle) {
    let _ = app.emit(SERVER_LIST_CHANGED_EVENT, build(app));
}

/// Initial-state read for a panel that just mounted; the event carries
/// every subsequent change.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn get_server_list(app: AppHandle) -> ServerList {
    build(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn discovered(name: &str, address: &str) -> DiscoveredServer {
        DiscoveredServer {
            fullname: format!("{name}._cannet._tcp.local."),
            name: name.to_string(),
            host: Some(format!("{name}.local")),
            address: address.to_string(),
            version: Some("v0.8.1".into()),
        }
    }

    fn pinned() -> TrustEntry {
        TrustEntry {
            fingerprint: Some("SHA256:aaa".into()),
            token: Some("tok".into()),
            insecure: false,
        }
    }

    fn store(entries: &[(&str, TrustEntry)]) -> BTreeMap<String, TrustEntry> {
        entries
            .iter()
            .map(|(a, e)| (server_key(a), e.clone()))
            .collect()
    }

    fn merged(
        discovered: &[DiscoveredServer],
        trusted: &BTreeMap<String, TrustEntry>,
        prompts: &BTreeMap<String, TrustPrompt>,
    ) -> Vec<ServerRow> {
        merge(discovered, trusted, prompts, BrowseStatus::Running).servers
    }

    #[test]
    fn a_discovered_server_with_nothing_stored_is_a_new_row() {
        let rows = merged(
            &[discovered("bench", "192.168.1.10:50051")],
            &BTreeMap::new(),
            &BTreeMap::new(),
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].address, "192.168.1.10:50051");
        assert_eq!(rows[0].name.as_deref(), Some("bench"));
        assert_eq!(rows[0].host.as_deref(), Some("bench.local"));
        assert_eq!(rows[0].version.as_deref(), Some("v0.8.1"));
        assert!(rows[0].online);
        assert_eq!(rows[0].trust, TrustState::New);
        assert!(!rows[0].has_token);
    }

    #[test]
    fn a_trusted_server_that_is_also_advertising_is_one_row_carrying_both() {
        // The whole point of the merge: two sources, one row, keyed by
        // `host:port`.
        let rows = merged(
            &[discovered("bench", "192.168.1.10:50051")],
            &store(&[("192.168.1.10:50051", pinned())]),
            &BTreeMap::new(),
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].trust, TrustState::Trusted);
        assert!(rows[0].online);
        assert_eq!(rows[0].name.as_deref(), Some("bench"));
        assert_eq!(rows[0].fingerprint.as_deref(), Some("SHA256:aaa"));
        assert!(rows[0].has_token);
    }

    #[test]
    fn the_stored_token_itself_never_reaches_the_row() {
        let rows = merged(&[], &store(&[("bench:50051", pinned())]), &BTreeMap::new());
        let rendered = serde_json::to_string(&rows[0]).unwrap();
        assert!(!rendered.contains("tok"), "{rendered}");
        assert!(rendered.contains("\"hasToken\":true"), "{rendered}");
    }

    #[test]
    fn a_trusted_server_that_is_not_advertising_is_still_a_row_marked_offline() {
        // Greyed, not hidden: forgetting a server must not require
        // waiting for it to come back.
        let rows = merged(&[], &store(&[("bench:50051", pinned())]), &BTreeMap::new());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].address, "bench:50051");
        assert!(!rows[0].online);
        assert_eq!(rows[0].trust, TrustState::Trusted);
        assert_eq!(rows[0].name, None, "nothing has answered to name it");
        assert_eq!(rows[0].host, None);
        assert_eq!(rows[0].version, None);
    }

    #[test]
    fn a_stored_token_on_its_own_is_not_trust() {
        // `plan` would still probe: the connection stops at the
        // certificate, so the badge must not claim otherwise.
        let entry = TrustEntry {
            token: Some("tok".into()),
            ..TrustEntry::default()
        };
        let rows = merged(
            &[discovered("bench", "192.168.1.10:50051")],
            &store(&[("192.168.1.10:50051", entry)]),
            &BTreeMap::new(),
        );
        assert_eq!(rows[0].trust, TrustState::New);
        assert!(rows[0].has_token);
    }

    #[test]
    fn a_loopback_server_is_trusted_with_nothing_stored() {
        // `plan` reaches loopback in the clear and asks nothing, so a
        // row for one must not wear a badge inviting a decision that is
        // never going to be asked for — and Connection Management must
        // be able to offer its interfaces like any other trusted
        // server's.
        let rows = merged(
            &[discovered("proxy", "127.0.0.1:50051")],
            &BTreeMap::new(),
            &BTreeMap::new(),
        );
        assert_eq!(rows[0].trust, TrustState::Trusted);
        assert_eq!(rows[0].fingerprint, None);
        assert!(!rows[0].has_token);
    }

    #[test]
    fn an_accepted_unprotected_connection_is_trusted_and_says_so() {
        let entry = TrustEntry {
            insecure: true,
            ..TrustEntry::default()
        };
        let rows = merged(&[], &store(&[("bench:50051", entry)]), &BTreeMap::new());
        assert_eq!(rows[0].trust, TrustState::Trusted);
        assert!(rows[0].insecure);
        assert_eq!(rows[0].fingerprint, None);
    }

    #[test]
    fn a_refused_certificate_badges_the_row_as_changed() {
        // The one state that cannot be read off the store — it exists
        // because a connection was attempted and refused.
        let prompts = BTreeMap::from([(
            "192.168.1.10:50051".to_string(),
            TrustPrompt::IdentityChanged {
                expected: "SHA256:aaa".into(),
                observed: "SHA256:bbb".into(),
            },
        )]);
        let rows = merged(
            &[discovered("bench", "192.168.1.10:50051")],
            &store(&[("192.168.1.10:50051", pinned())]),
            &prompts,
        );
        assert_eq!(rows[0].trust, TrustState::FingerprintChanged);
        assert_eq!(
            rows[0].prompt,
            Some(TrustPrompt::IdentityChanged {
                expected: "SHA256:aaa".into(),
                observed: "SHA256:bbb".into(),
            }),
            "the row carries the question, so the panel need not re-fail the connection",
        );
    }

    #[test]
    fn an_address_the_host_is_waiting_on_gets_a_row_of_its_own() {
        // How a server that advertises nowhere reaches the panel: it is
        // dialled by hand, the attempt is refused at the certificate, and
        // the question that leaves is the only thing anyone knows about
        // the address. Without a row there is nothing to answer it from.
        let prompts = BTreeMap::from([(
            "bench.example.com:50051".to_string(),
            TrustPrompt::AcceptIdentity {
                observed: "SHA256:bbb".into(),
            },
        )]);
        let rows = merged(&[], &BTreeMap::new(), &prompts);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].address, "bench.example.com:50051");
        assert_eq!(rows[0].trust, TrustState::New);
        assert!(!rows[0].online, "nothing is advertising it");
        assert_eq!(rows[0].name, None);
        assert_eq!(
            rows[0].prompt,
            Some(TrustPrompt::AcceptIdentity {
                observed: "SHA256:bbb".into(),
            }),
        );
        assert_eq!(rows[0].fingerprint, None, "nothing has been stored for it");
    }

    #[test]
    fn a_prompt_raised_against_a_differently_spelled_address_still_finds_its_row() {
        let prompts = BTreeMap::from([(
            "https://Bench:50051".to_string(),
            TrustPrompt::AcceptIdentity {
                observed: "SHA256:bbb".into(),
            },
        )]);
        let rows = merged(&[], &store(&[("bench:50051", pinned())]), &prompts);
        assert!(rows[0].prompt.is_some(), "scheme and case are not identity");
    }

    #[test]
    fn a_question_that_is_not_about_the_certificate_leaves_the_badge_alone() {
        // A refused token is a real pending question, but the identity
        // is still the accepted one.
        let prompts = BTreeMap::from([("bench:50051".to_string(), TrustPrompt::TokenRefused)]);
        let rows = merged(&[], &store(&[("bench:50051", pinned())]), &prompts);
        assert_eq!(rows[0].trust, TrustState::Trusted);
        assert_eq!(rows[0].prompt, Some(TrustPrompt::TokenRefused));
    }

    #[test]
    fn reachable_servers_sort_above_the_greyed_ones_and_then_by_name() {
        let rows = merged(
            &[
                discovered("rippy", "10.0.0.7:50051"),
                discovered("bench", "192.168.1.10:50051"),
            ],
            &store(&[("dead:50051", pinned()), ("gone:50051", pinned())]),
            &BTreeMap::new(),
        );
        let addresses: Vec<&str> = rows.iter().map(|r| r.address.as_str()).collect();
        assert_eq!(
            addresses,
            vec![
                "192.168.1.10:50051",
                "10.0.0.7:50051",
                "dead:50051",
                "gone:50051",
            ],
            "online first (bench before rippy), then the offline rows by address",
        );
    }

    #[test]
    fn an_empty_list_still_reports_what_the_browse_is_doing() {
        // The difference between "nothing on the subnet" and "nothing
        // is listening" — the panel cannot infer it, so the model says
        // it.
        for status in [
            BrowseStatus::Starting,
            BrowseStatus::Running,
            BrowseStatus::Stopped,
            BrowseStatus::Failed {
                detail: "address in use".into(),
            },
            BrowseStatus::Degraded {
                detail: "sending on eth0 failed".into(),
            },
        ] {
            let list = merge(&[], &BTreeMap::new(), &BTreeMap::new(), status.clone());
            assert!(list.servers.is_empty());
            assert_eq!(list.browse, status);
        }
    }

    #[test]
    fn the_wire_shape_is_what_the_panel_renders() {
        let list = merge(
            &[discovered("bench", "192.168.1.10:50051")],
            &store(&[("192.168.1.10:50051", pinned())]),
            &BTreeMap::new(),
            BrowseStatus::Failed {
                detail: "address in use".into(),
            },
        );
        let json = serde_json::to_value(&list).unwrap();
        assert_eq!(json["browse"]["state"], "failed");
        assert_eq!(json["browse"]["detail"], "address in use");
        let row = &json["servers"][0];
        assert_eq!(row["address"], "192.168.1.10:50051");
        assert_eq!(row["name"], "bench");
        assert_eq!(row["host"], "bench.local");
        assert_eq!(row["version"], "v0.8.1");
        assert_eq!(row["online"], true);
        assert_eq!(row["trust"], "trusted");
        assert_eq!(row["fingerprint"], "SHA256:aaa");
        assert_eq!(row["hasToken"], true);
        assert_eq!(row["insecure"], false);
        assert!(row["prompt"].is_null());
    }

    #[test]
    fn every_trust_state_has_a_stable_wire_name() {
        for (state, wire) in [
            (TrustState::New, "new"),
            (TrustState::Trusted, "trusted"),
            (TrustState::FingerprintChanged, "fingerprintChanged"),
        ] {
            assert_eq!(serde_json::to_value(state).unwrap(), wire);
        }
    }
}
