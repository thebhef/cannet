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

use cannet_client::clock::{ClockProbeStatus, ClockRecord};

use crate::connect_flow::{ServerPrompts, TrustPrompt};
use crate::server_browse::{BrowseStatus, DiscoveredServer, DiscoveredServers};
use crate::server_trust::{server_key, TrustEntry};

/// Above this measured offset the row and the session-start / transition
/// log lines read as a warning rather than routine health (owner-ruled
/// 2026-08-13). Shared between the row's `warn` flag and
/// [`crate::clock_status`]'s log latch so the two can never disagree
/// about where the line is.
pub(crate) const CLOCK_WARN_THRESHOLD_NS: i64 = 100_000_000;

/// The clock-offset summary one server row carries — the read side of a
/// session's [`ClockRecord`], reduced to what a row renders.
///
/// Deliberately narrower than `ClockRecord`: the row shows the
/// *measured* offset (the slew's target), not the currently applied one
/// — the two differ only while a correction is converging, and a
/// viewer comparing this machine's clock to the server's wants what was
/// found, not where the correction has gotten to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerClock {
    /// θ — the server's clock minus ours, nanoseconds. Positive means
    /// the server is ahead.
    pub offset_ns: i64,
    /// `|offset_ns| > `[`CLOCK_WARN_THRESHOLD_NS`].
    pub warn: bool,
    /// The measurement is stale: the peer answered before but has gone
    /// quiet on the current re-probe cadence, so this is the last good
    /// number rather than a fresh one ([`ClockRecord::silent_rounds`]).
    pub stale: bool,
}

/// Reduce a session's clock record to what a row shows, or `None` when
/// there is nothing to show: no round has settled yet
/// ([`ClockProbeStatus::Pending`]), or the peer never answered at all
/// ([`ClockProbeStatus::Unsupported`]) — both render as an absent badge,
/// never an error.
#[must_use]
pub(crate) fn server_clock_from_record(record: &ClockRecord) -> Option<ServerClock> {
    if !matches!(record.status, ClockProbeStatus::Measured(_)) {
        return None;
    }
    let offset_ns = record.measured_offset_ns?;
    Some(ServerClock {
        offset_ns,
        warn: offset_ns.abs() > CLOCK_WARN_THRESHOLD_NS,
        stale: record.silent_rounds > 0,
    })
}

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
// The flags are independent facts about one server — reachable, has a
// token, unprotected, added by hand — and this is the JSON the panel
// renders. Folding them into enums would invent states the model does
// not have and change the wire shape to hide them.
#[allow(clippy::struct_excessive_bools)]
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
    /// The operator put this address in the list by hand. Not a trust
    /// decision — it is only what keeps a server nothing advertises in
    /// the list, and what the panel offers to take back out again.
    pub manual: bool,
    /// The question the host is currently waiting on for this server,
    /// if any — so the panel can put the same dialog in front of the
    /// user without asking the connection to fail again.
    pub prompt: Option<TrustPrompt>,
    /// This server's measured clock offset for the live session against
    /// it, if any. `None` for an unconnected server, a peer that
    /// doesn't support the probe, or a session whose first measurement
    /// hasn't settled yet — all of which render as no badge at all,
    /// never an error.
    pub clock: Option<ServerClock>,
}

/// The panel's whole model: the merged rows and what the browse task
/// has to say about itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerList {
    pub servers: Vec<ServerRow>,
    pub browse: BrowseStatus,
}

/// Merge the sources into the rows the panel renders. A row comes from
/// something stored or something advertising — the list is what this
/// machine has accepted plus what is on the subnet, and nothing else.
///
/// A pending question is a fact *about* a row, never what holds one: a
/// refused attempt stores nothing, so an address dialled by hand and
/// left unanswered is in neither source and has no row. Dismissing the
/// question leaves nothing behind; the address is typed again to retry.
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
    clocks: &BTreeMap<String, ServerClock>,
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
    // A live session's clock record is a fact about a server too, and
    // can be the only thing known about an address dialled by hand
    // before its first `ListInterfaces` answers.
    for key in clocks.keys() {
        rows.entry(key.clone())
            .or_insert_with(|| offline_row(key, &TrustEntry::default()));
    }
    for (key, row) in &mut rows {
        row.prompt = by_key.get(key).map(|p| (*p).clone());
        if matches!(row.prompt, Some(TrustPrompt::IdentityChanged { .. })) {
            row.trust = TrustState::FingerprintChanged;
        }
        row.clock = clocks.get(key).copied();
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
        manual: entry.manual,
        prompt: None,
        clock: None,
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
    merge(&discovered, &trusted, &prompts, &live_clocks(app), browse)
}

/// Every active session's clock summary, keyed by [`server_key`] —
/// [`crate::clock_status`]'s poll is what notices a summary moved and
/// calls [`changed`]; this is the read half, folding the live
/// `AppState::remote_sessions` map into what [`merge`] needs. A session
/// with no [`crate::session::RemoteSession::clock`] (the in-process vbus
/// backend) and one whose first round hasn't settled both contribute
/// nothing, same as a peer that never answers.
fn live_clocks(app: &AppHandle) -> BTreeMap<String, ServerClock> {
    let Some(state) = app.try_state::<crate::app_state::AppState>() else {
        return BTreeMap::new();
    };
    let sessions = state.remote_sessions();
    sessions
        .iter()
        .filter_map(|(address, session)| {
            let clock = session.clock.as_ref()?;
            let summary = server_clock_from_record(&clock.record())?;
            Some((server_key(address), summary))
        })
        .collect()
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

/// The `host:port` an added address has to be, in the form the store
/// files it under.
///
/// A shape check, not a reachability one — whether anything answers
/// there is what dialling it finds out. It is the host's to make because
/// the shape is the connection layer's: an address without a port has
/// nothing to dial, and a bare IPv6 literal is ambiguous about where the
/// port starts.
fn checked_address(input: &str) -> Result<String, String> {
    const SHAPE: &str = "A server address is host:port, for example bench.local:50051.";
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(format!("Enter the server's address. {SHAPE}"));
    }
    let key = server_key(trimmed);
    if key.contains(char::is_whitespace) {
        return Err(format!("\"{trimmed}\" has a space in it. {SHAPE}"));
    }
    let (host, port) = split_host_port(&key).ok_or_else(|| {
        if key.matches(':').count() > 1 {
            format!("\"{trimmed}\" is an IPv6 address without brackets — write it as [{key}]:port.")
        } else {
            format!("\"{trimmed}\" has no port. {SHAPE}")
        }
    })?;
    if host.is_empty() {
        return Err(format!("\"{trimmed}\" has no host. {SHAPE}"));
    }
    match port.parse::<u16>() {
        Ok(port) if port > 0 => Ok(key),
        _ => Err(format!("\"{port}\" is not a port number. {SHAPE}")),
    }
}

/// Split `address` into its host and port halves, `None` when it has no
/// port to split off. The bracketed IPv6 form is handled first, because
/// only the brackets say which colon is the separator.
fn split_host_port(address: &str) -> Option<(&str, &str)> {
    if let Some(rest) = address.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        return after.strip_prefix(':').map(|port| (host, port));
    }
    let (host, port) = address.split_once(':')?;
    if port.contains(':') {
        return None;
    }
    Some((host, port))
}

/// Tauri command — put a server in the list that discovery cannot
/// produce: one on another subnet, or one started `--no-mdns`.
///
/// The same act a browsed row's *Trust…* is, for an address that has no
/// row yet: the address is checked here, then dialled through
/// [`crate::interfaces::refresh_interfaces`], so first contact goes
/// through [`crate::connect_flow`] exactly as it does for a discovered
/// server — refused at the certificate, with the question left against
/// the address this returns.
///
/// **A refused attempt stores nothing, and leaves no row.** The pin the
/// operator accepts in the dialog is the store's first record of the
/// server, and what puts it in the list; a question they wave away
/// leaves the address in nothing at all, and reaching it is typing it
/// again. The one exception is a server that is reached with no
/// question asked — a loopback proxy — which is recorded as
/// [`crate::server_trust::TrustEntry::manual`], because nothing else
/// would keep it in the list.
#[tauri::command]
pub async fn add_server(app: AppHandle, address: String) -> Result<String, String> {
    let address = checked_address(&address)?;
    match crate::interfaces::refresh_interfaces(app.clone(), address.clone()).await {
        Ok(_) => {
            let dir = crate::persisted_json::config_dir(&app)?;
            crate::server_trust::update_server(&dir, &address, |entry| entry.manual = true)
                .map_err(|e| format!("failed to record {address}: {e}"))?;
            changed(&app);
        }
        // A refusal that raised a question is what first contact looks
        // like; the question is the outcome, and it is on the row.
        // Anything else failed with nothing to ask about, so it is
        // reported instead.
        Err(detail) => {
            if !crate::connect_flow::waiting_on(&app, &address) {
                return Err(detail);
            }
        }
    }
    Ok(address)
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
            manual: false,
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
        merge(
            discovered,
            trusted,
            prompts,
            &BTreeMap::new(),
            BrowseStatus::Running,
        )
        .servers
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
    fn a_server_added_by_hand_is_a_row_that_can_be_dropped_again() {
        // A loopback proxy that advertises nowhere: nothing is ever
        // asked about it, so nothing else would keep it in the list —
        // and Connection Management can only offer what is in the list.
        let entry = TrustEntry {
            manual: true,
            ..TrustEntry::default()
        };
        let rows = merged(
            &[],
            &store(&[("127.0.0.1:50052", entry.clone())]),
            &BTreeMap::new(),
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].trust, TrustState::Trusted);
        assert!(rows[0].manual, "so the row can be taken back out again");

        // A routable one added the same way still has to be accepted.
        let rows = merged(&[], &store(&[("bench:50051", entry)]), &BTreeMap::new());
        assert_eq!(rows[0].trust, TrustState::New);
        assert!(rows[0].manual);
    }

    #[test]
    fn an_address_typed_by_hand_is_checked_before_anything_is_dialled() {
        for bad in [
            "",
            "   ",
            "bench.example.com",
            "bench.example.com:",
            ":50051",
            "bench:0",
            "bench:70000",
            "bench:fifty",
            "ben ch:50051",
            "2001:db8::1:50051",
        ] {
            assert!(checked_address(bad).is_err(), "{bad:?} is not an address");
        }
    }

    #[test]
    fn a_checked_address_comes_back_in_the_form_the_store_files_it_under() {
        for (input, key) in [
            (
                " https://Bench.Example.com:50051 ",
                "bench.example.com:50051",
            ),
            ("127.0.0.1:50051", "127.0.0.1:50051"),
            ("[2001:db8::1]:50051", "[2001:db8::1]:50051"),
        ] {
            assert_eq!(checked_address(input).unwrap(), key, "{input:?}");
        }
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
    fn an_unanswered_question_is_not_a_row() {
        // The list is what is advertising plus what has been accepted
        // here. An address dialled by hand and refused at the
        // certificate is neither: nothing is stored for it until the
        // operator accepts the identity, and a question they wave away
        // leaves nothing behind — the address is typed again to retry.
        let prompts = BTreeMap::from([(
            "bench.example.com:50051".to_string(),
            TrustPrompt::AcceptIdentity {
                observed: "SHA256:bbb".into(),
            },
        )]);
        let rows = merged(&[], &BTreeMap::new(), &prompts);
        assert!(rows.is_empty(), "{rows:?}");
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
            let list = merge(
                &[],
                &BTreeMap::new(),
                &BTreeMap::new(),
                &BTreeMap::new(),
                status.clone(),
            );
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
        assert!(row["clock"].is_null(), "no session, nothing to show");
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

    // ---------- clock offset ----------

    fn measured(offset_ns: i64, silent_rounds: u32) -> ClockRecord {
        ClockRecord {
            status: ClockProbeStatus::Measured(cannet_client::clock::ClockOffset {
                offset_ns,
                delay_ns: 1_000_000,
                samples: 4,
            }),
            start_offset_ns: Some(offset_ns),
            measured_offset_ns: Some(offset_ns),
            applied_offset_ns: offset_ns,
            delay_ns: Some(1_000_000),
            samples: 4,
            rounds: silent_rounds + 1,
            silent_rounds,
            measured_at_ns: Some(0),
        }
    }

    fn pending() -> ClockRecord {
        ClockRecord {
            status: ClockProbeStatus::Pending,
            start_offset_ns: None,
            measured_offset_ns: None,
            applied_offset_ns: 0,
            delay_ns: None,
            samples: 0,
            rounds: 0,
            silent_rounds: 0,
            measured_at_ns: None,
        }
    }

    fn unsupported() -> ClockRecord {
        ClockRecord {
            status: ClockProbeStatus::Unsupported,
            ..pending()
        }
    }

    #[test]
    fn a_measured_offset_under_threshold_shows_without_warning() {
        let clock = server_clock_from_record(&measured(42_000_000, 0)).unwrap();
        assert_eq!(clock.offset_ns, 42_000_000);
        assert!(!clock.warn);
        assert!(!clock.stale);
    }

    #[test]
    fn a_measured_offset_over_threshold_warns() {
        let clock = server_clock_from_record(&measured(150_000_000, 0)).unwrap();
        assert!(clock.warn);
        // A server *behind* by the same margin warns too — it's the
        // magnitude that matters, not the sign.
        let behind = server_clock_from_record(&measured(-150_000_000, 0)).unwrap();
        assert!(behind.warn);
    }

    #[test]
    fn a_stale_measurement_is_flagged_but_keeps_the_last_good_number() {
        let clock = server_clock_from_record(&measured(5_000_000, 3)).unwrap();
        assert_eq!(clock.offset_ns, 5_000_000, "stale is not absent");
        assert!(clock.stale);
    }

    #[test]
    fn pending_and_unsupported_render_nothing() {
        assert!(server_clock_from_record(&pending()).is_none());
        assert!(server_clock_from_record(&unsupported()).is_none());
    }

    #[test]
    fn a_connected_servers_measured_offset_reaches_its_row() {
        let clocks = BTreeMap::from([(
            "192.168.1.10:50051".to_string(),
            server_clock_from_record(&measured(4_200_000_000, 0)).unwrap(),
        )]);
        let rows = merge(
            &[discovered("bench", "192.168.1.10:50051")],
            &store(&[("192.168.1.10:50051", pinned())]),
            &BTreeMap::new(),
            &clocks,
            BrowseStatus::Running,
        )
        .servers;
        let clock = rows[0]
            .clock
            .expect("a live session's clock reaches the row");
        assert_eq!(clock.offset_ns, 4_200_000_000);
        assert!(clock.warn);
    }

    #[test]
    fn a_session_against_an_address_dialled_by_hand_still_gets_a_row() {
        // Same shape as a pending trust prompt: the clock record may be
        // the only thing known about an address before anything else
        // (discovery, the trust store) has a row for it.
        let clocks = BTreeMap::from([(
            "bench.example.com:50051".to_string(),
            server_clock_from_record(&measured(10_000_000, 0)).unwrap(),
        )]);
        let rows = merge(
            &[],
            &BTreeMap::new(),
            &BTreeMap::new(),
            &clocks,
            BrowseStatus::Running,
        )
        .servers;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].address, "bench.example.com:50051");
        assert!(rows[0].clock.is_some());
    }

    #[test]
    fn a_live_session_against_a_loopback_sidecar_mints_a_trusted_row_storing_nothing() {
        // The row a user never asked for. The GUI spawns its own
        // python-can sidecar, which binds `127.0.0.1:<ephemeral>`, and
        // connecting a bus to local hardware dials it — so the session's
        // clock record is the only source that knows the address. What
        // comes out is trusted (loopback is reached in the clear, so no
        // question will ever be asked about it), unnamed (nothing
        // advertises a sidecar), and empty of everything the trust store
        // would put on a row. The address changes on every launch,
        // because the port does.
        let clocks = BTreeMap::from([(
            "127.0.0.1:65476".to_string(),
            server_clock_from_record(&measured(739_200_000, 0)).unwrap(),
        )]);
        let rows = merge(
            &[],
            &BTreeMap::new(),
            &BTreeMap::new(),
            &clocks,
            BrowseStatus::Running,
        )
        .servers;
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.address, "127.0.0.1:65476");
        assert_eq!(row.trust, TrustState::Trusted);
        assert_eq!(row.name, None, "a sidecar advertises nowhere");
        assert!(!row.online);
        assert_eq!(row.fingerprint, None);
        assert!(!row.has_token);
        assert!(!row.insecure);
        assert!(!row.manual, "nobody typed this address in");
        assert!(
            row.clock.is_some(),
            "the session is the only thing holding it"
        );
    }

    #[test]
    fn the_clock_wire_shape_carries_offset_warn_and_stale() {
        let clock = ServerClock {
            offset_ns: -150_000_000,
            warn: true,
            stale: true,
        };
        let json = serde_json::to_value(clock).unwrap();
        assert_eq!(json["offsetNs"], -150_000_000_i64);
        assert_eq!(json["warn"], true);
        assert_eq!(json["stale"], true);
    }
}
