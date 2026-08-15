//! Live browse of `_cannet._tcp` — the servers advertising themselves
//! on this subnet (ADR 0040).
//!
//! The host runs one mDNS browse for the life of the app and keeps the
//! resulting list in [`DiscoveredServers`]; the frontend reads a
//! snapshot once and follows [`DISCOVERED_SERVERS_CHANGED_EVENT`]. It
//! never polls and never decides — picking a browsed server hands the
//! connect surface the same `host:port` string a user could have typed.
//!
//! **Discovery is convenience only** (ADR 0040). Nothing here is a
//! security check: an entry in this list says a machine on the subnet
//! claimed a name, and the connection layer (ADR 0041,
//! [`crate::connect_flow`]) is what decides whether to trust what
//! answers at that address.
//!
//! ## Why the list is keyed by DNS-SD fullname
//!
//! One registration produces *many* `ServiceResolved` events — one per
//! interface the responder answers on, each carrying more of the
//! address set than the last — and more than one `ServiceRemoved` for a
//! single expiry. The fullname (`<instance>._cannet._tcp.local.`) is
//! the only identity stable across all of them and across address
//! families, so [`BrowseList`] keys on it and every update is
//! idempotent: repeated resolves merge into one entry, and a repeat of
//! what is already known reports no change, so the frontend is not
//! woken for a redundant announcement.

use std::collections::{BTreeMap, BTreeSet};
use std::net::IpAddr;
use std::sync::Mutex;

use mdns_sd::{ResolvedService, ServiceDaemon, ServiceEvent};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::sys_warn;

/// DNS-SD service type the GUI browses for — the one
/// `cannet-server` registers.
pub const SERVICE_TYPE: &str = "_cannet._tcp.local.";

/// Tauri event emitted whenever the browsed-server list changes.
/// Payload is the whole snapshot (a subnet's worth of servers, so
/// there is no diff format).
pub const DISCOVERED_SERVERS_CHANGED_EVENT: &str = "discovered-servers-changed";

/// One `ServiceResolved`, reduced to what the browse list keeps.
///
/// Separate from the daemon's own resolve type so the state machine
/// below is exercisable without binding a multicast socket.
#[derive(Debug, Clone)]
pub struct Resolved {
    /// `<instance>._cannet._tcp.local.` — the entry's key.
    pub fullname: String,
    /// Port from the SRV record.
    pub port: u16,
    /// Every address this resolve reported, scope dropped.
    pub addresses: BTreeSet<IpAddr>,
    /// The `ver` TXT key, absent if the server didn't publish one.
    pub version: Option<String>,
}

/// One discovered server, as the connect surface receives it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiscoveredServer {
    /// The DNS-SD fullname — stable identity, and the list's React key.
    pub fullname: String,
    /// The instance name the server was started with (`--name`, or its
    /// hostname).
    pub name: String,
    /// `host:port`, ready to hand to the connect path verbatim.
    pub address: String,
    /// The server's release version, from the `ver` TXT key.
    pub version: Option<String>,
}

/// What the browse knows about one instance, across every resolve for
/// it seen so far.
#[derive(Debug, Default, PartialEq, Eq)]
struct Instance {
    port: u16,
    /// Accumulated across resolves: a responder reports the addresses
    /// it has answered on *so far*, so a later resolve is a superset,
    /// not a replacement.
    addresses: BTreeSet<IpAddr>,
    version: Option<String>,
}

/// The browse-list state machine: fullname → what is known about that
/// instance.
///
/// Empty is the honest starting state — nothing has answered yet — and
/// it is also where a subnet with no servers stays.
#[derive(Debug, Default)]
pub struct BrowseList {
    entries: BTreeMap<String, Instance>,
}

impl BrowseList {
    /// Fold one resolve in. Returns whether the snapshot the frontend
    /// would see actually moved — the guard that keeps a burst of
    /// interface-by-interface resolves from firing a burst of events.
    pub fn resolved(&mut self, resolved: &Resolved) -> bool {
        self.changing(|entries| {
            let entry = entries.entry(resolved.fullname.clone()).or_default();
            entry.port = resolved.port;
            entry.addresses.extend(resolved.addresses.iter().copied());
            if resolved.version.is_some() {
                entry.version.clone_from(&resolved.version);
            }
        })
    }

    /// Drop `fullname`, whichever removal signal arrived — a goodbye
    /// packet or a TTL expiry. A server that is gone is gone: there is
    /// no lingering greyed-out state, and the manual address field
    /// covers reaching one that isn't advertising.
    ///
    /// Returns whether anything was actually removed, so the duplicate
    /// `ServiceRemoved` one expiry produces costs one event, not two.
    pub fn removed(&mut self, fullname: &str) -> bool {
        self.changing(|entries| {
            entries.remove(fullname);
        })
    }

    /// The list as the frontend sees it, ordered by instance name so it
    /// doesn't reshuffle under the user's cursor as resolves arrive.
    ///
    /// An instance with no address we can dial is omitted: it is not
    /// something the user can select, and listing an unselectable row
    /// would only invite a click that cannot work.
    #[must_use]
    pub fn snapshot(&self) -> Vec<DiscoveredServer> {
        let mut out: Vec<DiscoveredServer> = self
            .entries
            .iter()
            .filter_map(|(fullname, entry)| {
                Some(DiscoveredServer {
                    fullname: fullname.clone(),
                    name: instance_name(fullname).to_string(),
                    address: dial_address(&entry.addresses, entry.port)?,
                    version: entry.version.clone(),
                })
            })
            .collect();
        out.sort_by(|a, b| (&a.name, &a.fullname).cmp(&(&b.name, &b.fullname)));
        out
    }

    /// Apply `edit` and report whether the *snapshot* moved. Comparing
    /// rendered snapshots rather than tracking dirtiness per field
    /// keeps "did the user-visible list change" exact — a resolve that
    /// only adds a worse-ranked address changes the entry but not the
    /// list.
    fn changing(&mut self, edit: impl FnOnce(&mut BTreeMap<String, Instance>)) -> bool {
        let before = self.snapshot();
        edit(&mut self.entries);
        before != self.snapshot()
    }
}

/// The instance name inside a fullname — everything before the service
/// type. A fullname that isn't ours is returned whole rather than
/// mangled.
fn instance_name(fullname: &str) -> &str {
    fullname
        .strip_suffix(SERVICE_TYPE)
        .and_then(|head| head.strip_suffix('.'))
        .unwrap_or(fullname)
}

/// The `host:port` to dial for an instance, or `None` when none of its
/// addresses can be dialled.
///
/// The ranking exists because `enable_addr_auto()` announces on every
/// interface, so a single instance arrives with loopback, VM-adapter,
/// and link-local addresses mixed in with the one that actually reaches
/// it:
///
/// - A routable IPv4 address first — the one that works from another
///   machine.
/// - Then a routable IPv6 address.
/// - Then loopback, which reaches a server on *this* machine and
///   nothing else, so it must never outrank a routable address (dialling
///   a remote server's advertised `127.0.0.1` would silently reach us
///   instead).
/// - IPv6 link-local is skipped outright: it is unusable without the
///   scope identifier, which does not survive into a `host:port` string.
///
/// Within a rank the numerically lowest address wins, so the choice is
/// stable across resolves rather than drifting with iteration order.
fn dial_address(addresses: &BTreeSet<IpAddr>, port: u16) -> Option<String> {
    let host = addresses
        .iter()
        .filter_map(|addr| dial_rank(*addr).map(|rank| (rank, *addr)))
        .min()?
        .1;
    Some(match host {
        IpAddr::V4(v4) => format!("{v4}:{port}"),
        IpAddr::V6(v6) => format!("[{v6}]:{port}"),
    })
}

/// Preference order for [`dial_address`]; `None` means unusable.
fn dial_rank(addr: IpAddr) -> Option<u8> {
    match addr {
        IpAddr::V4(v4) if v4.is_unspecified() => None,
        IpAddr::V4(v4) if v4.is_loopback() => Some(3),
        IpAddr::V4(v4) if v4.is_link_local() => Some(2),
        IpAddr::V4(_) => Some(0),
        IpAddr::V6(v6) if v6.is_unspecified() => None,
        IpAddr::V6(v6) if v6.is_loopback() => Some(4),
        // `Ipv6Addr::is_unicast_link_local` is unstable; the prefix test
        // is what it does.
        IpAddr::V6(v6) if (v6.segments()[0] & 0xffc0) == 0xfe80 => None,
        IpAddr::V6(_) => Some(1),
    }
}

/// Tauri-managed singleton holding the browse list. A mutex is enough:
/// every hot path is a map edit or a snapshot of a handful of entries.
#[derive(Default)]
pub struct DiscoveredServers {
    inner: Mutex<BrowseList>,
}

impl DiscoveredServers {
    /// Current list.
    #[must_use]
    pub fn snapshot(&self) -> Vec<DiscoveredServer> {
        self.lock().snapshot()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BrowseList> {
        self.inner
            .lock()
            .expect("discovered servers mutex poisoned")
    }
}

/// Source tag on any System Message this module emits.
const SOURCE: &str = "server-browse";

/// Start the browse. Runs for the life of the app: the list is bounded
/// by the servers on the subnet, and a browse that only ran while some
/// panel was open would show an empty list for the first second every
/// time the user went looking.
///
/// Failure to start the daemon is a warning, never a startup refusal —
/// discovery is convenience only (ADR 0040), and a machine whose mDNS
/// stack is unavailable still reaches every server by typed address.
pub(crate) fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        run_browse(&app).await;
    });
}

async fn run_browse(app: &AppHandle) {
    let daemon = match ServiceDaemon::new() {
        Ok(daemon) => daemon,
        Err(e) => {
            sys_warn!(app, SOURCE, "couldn't start the mDNS browser: {e}");
            return;
        }
    };
    let events = match daemon.browse(SERVICE_TYPE) {
        Ok(events) => events,
        Err(e) => {
            sys_warn!(app, SOURCE, "couldn't browse for {SERVICE_TYPE}: {e}");
            return;
        }
    };
    while let Ok(event) = events.recv_async().await {
        match event {
            ServiceEvent::ServiceResolved(service) => {
                let resolved = from_resolved_service(&service);
                apply(app, |list| list.resolved(&resolved));
            }
            // Both removal signals — the goodbye packet an orderly
            // shutdown sends, and the SRV record's expiry after a server
            // was killed — arrive as this one event.
            ServiceEvent::ServiceRemoved(_, fullname) => {
                apply(app, |list| list.removed(&fullname));
            }
            _ => {}
        }
    }
}

/// Apply `edit` to the managed list and push the new snapshot at the
/// frontend if it moved. The one write path, so the event and the list
/// the `get_discovered_servers` command answers with cannot drift.
fn apply(app: &AppHandle, edit: impl FnOnce(&mut BrowseList) -> bool) {
    let Some(servers) = app.try_state::<DiscoveredServers>() else {
        return;
    };
    if edit(&mut servers.lock()) {
        let _ = app.emit(DISCOVERED_SERVERS_CHANGED_EVENT, servers.snapshot());
    }
}

/// Reduce one daemon resolve to what the browse list keeps. The scope
/// identifier an IPv6 address carries is dropped here: a `host:port`
/// string has nowhere to put it, which is why
/// [`dial_rank`] treats link-local IPv6 as unusable.
fn from_resolved_service(service: &ResolvedService) -> Resolved {
    Resolved {
        fullname: service.get_fullname().to_string(),
        port: service.get_port(),
        addresses: service
            .get_addresses()
            .iter()
            .map(mdns_sd::ScopedIp::to_ip_addr)
            .collect(),
        version: service.get_property_val_str("ver").map(ToString::to_string),
    }
}

/// Initial-state read for a frontend that just mounted; the event
/// carries every subsequent change.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn get_discovered_servers(
    servers: tauri::State<'_, DiscoveredServers>,
) -> Vec<DiscoveredServer> {
    servers.snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().expect("test address parses")
    }

    fn resolve(name: &str, port: u16, addresses: &[&str], version: Option<&str>) -> Resolved {
        Resolved {
            fullname: format!("{name}.{SERVICE_TYPE}"),
            port,
            addresses: addresses.iter().map(|a| ip(a)).collect(),
            version: version.map(ToString::to_string),
        }
    }

    #[test]
    fn a_resolve_becomes_one_entry_carrying_the_name_address_and_version() {
        let mut list = BrowseList::default();
        assert!(list.resolved(&resolve("bench", 50051, &["192.168.1.10"], Some("v0.8.1"))));
        assert_eq!(
            list.snapshot(),
            vec![DiscoveredServer {
                fullname: "bench._cannet._tcp.local.".into(),
                name: "bench".into(),
                address: "192.168.1.10:50051".into(),
                version: Some("v0.8.1".into()),
            }],
        );
    }

    #[test]
    fn repeated_resolves_for_one_instance_merge_into_a_single_entry() {
        // The mechanical reason the list is keyed by fullname: one
        // registration resolves once per interface it is answered on.
        let mut list = BrowseList::default();
        list.resolved(&resolve("bench", 50051, &["192.168.1.10"], Some("v0.8.1")));
        list.resolved(&resolve("bench", 50051, &["10.0.0.4"], Some("v0.8.1")));
        list.resolved(&resolve("bench", 50051, &["192.168.1.10"], Some("v0.8.1")));
        assert_eq!(list.snapshot().len(), 1);
    }

    #[test]
    fn a_resolve_that_adds_nothing_visible_reports_no_change() {
        // What keeps a burst of eleven resolves from being eleven
        // events at the frontend.
        let mut list = BrowseList::default();
        let first = resolve("bench", 50051, &["192.168.1.10"], Some("v0.8.1"));
        assert!(list.resolved(&first));
        assert!(!list.resolved(&first));
        // A second address that ranks below the one already chosen is
        // learned, but the list the user sees is unchanged.
        assert!(!list.resolved(&resolve("bench", 50051, &["127.0.0.1"], Some("v0.8.1"))));
    }

    #[test]
    fn both_address_families_of_one_instance_are_one_row() {
        let mut list = BrowseList::default();
        list.resolved(&resolve("bench", 50051, &["192.168.1.10"], Some("v0.8.1")));
        list.resolved(&resolve("bench", 50051, &["2001:db8::5"], Some("v0.8.1")));
        let snapshot = list.snapshot();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(
            snapshot[0].address, "192.168.1.10:50051",
            "a routable IPv4 address is what reaches the server from another machine",
        );
    }

    #[test]
    fn a_later_resolve_updates_the_port_and_version() {
        let mut list = BrowseList::default();
        list.resolved(&resolve("bench", 50051, &["192.168.1.10"], Some("v0.8.1")));
        assert!(list.resolved(&resolve("bench", 50052, &["192.168.1.10"], Some("v0.9.0"))));
        assert_eq!(list.snapshot()[0].address, "192.168.1.10:50052");
        assert_eq!(list.snapshot()[0].version.as_deref(), Some("v0.9.0"));
    }

    #[test]
    fn a_server_with_no_ver_key_is_listed_without_a_version() {
        let mut list = BrowseList::default();
        list.resolved(&resolve("bench", 50051, &["192.168.1.10"], None));
        assert_eq!(list.snapshot()[0].version, None);
    }

    #[test]
    fn either_removal_signal_drops_the_entry_immediately() {
        // Goodbye packet or TTL expiry — the same event reaches us, and
        // the entry goes. No greyed-out linger.
        let mut list = BrowseList::default();
        list.resolved(&resolve("bench", 50051, &["192.168.1.10"], Some("v0.8.1")));
        assert!(list.removed("bench._cannet._tcp.local."));
        assert_eq!(list.snapshot(), vec![]);
    }

    #[test]
    fn a_duplicate_removal_reports_no_change() {
        // One expiry produced two `ServiceRemoved` events in the spike.
        let mut list = BrowseList::default();
        list.resolved(&resolve("bench", 50051, &["192.168.1.10"], Some("v0.8.1")));
        assert!(list.removed("bench._cannet._tcp.local."));
        assert!(!list.removed("bench._cannet._tcp.local."));
    }

    #[test]
    fn a_removal_for_an_instance_never_seen_changes_nothing() {
        let mut list = BrowseList::default();
        assert!(!list.removed("ghost._cannet._tcp.local."));
        list.resolved(&resolve("bench", 50051, &["192.168.1.10"], Some("v0.8.1")));
        assert!(!list.removed("ghost._cannet._tcp.local."));
        assert_eq!(list.snapshot().len(), 1);
    }

    #[test]
    fn a_re_announce_after_a_removal_re_adds_the_server() {
        let mut list = BrowseList::default();
        list.resolved(&resolve("bench", 50051, &["192.168.1.10"], Some("v0.8.1")));
        list.removed("bench._cannet._tcp.local.");
        assert!(list.resolved(&resolve("bench", 50051, &["192.168.1.10"], Some("v0.8.1"))));
        assert_eq!(list.snapshot().len(), 1);
        assert_eq!(
            list.snapshot()[0].address,
            "192.168.1.10:50051",
            "the re-added entry starts clean, not merged with the dropped one",
        );
    }

    #[test]
    fn a_restart_on_a_new_address_does_not_keep_dialling_the_old_one() {
        // The address set accumulates *within* a live registration; a
        // removal is what clears it, and a goodbye precedes an orderly
        // restart.
        let mut list = BrowseList::default();
        list.resolved(&resolve("bench", 50051, &["192.168.1.10"], Some("v0.8.1")));
        list.removed("bench._cannet._tcp.local.");
        list.resolved(&resolve("bench", 50051, &["192.168.1.99"], Some("v0.8.1")));
        assert_eq!(list.snapshot()[0].address, "192.168.1.99:50051");
    }

    #[test]
    fn interleaved_instances_stay_separate_and_sort_by_name() {
        let mut list = BrowseList::default();
        list.resolved(&resolve("rippy", 50051, &["192.168.1.20"], Some("v0.8.1")));
        list.resolved(&resolve("bench", 50051, &["192.168.1.10"], Some("v0.8.1")));
        list.resolved(&resolve("rippy", 50051, &["10.0.0.20"], Some("v0.8.1")));
        list.removed("rippy._cannet._tcp.local.");
        list.resolved(&resolve("rippy", 50051, &["192.168.1.20"], Some("v0.8.1")));
        let snapshot = list.snapshot();
        let names: Vec<&str> = snapshot.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["bench", "rippy"]);
    }

    #[test]
    fn an_instance_with_nothing_dialable_is_not_offered() {
        // A responder that has only answered on a link-local IPv6
        // address gives us nothing a `host:port` string can express.
        let mut list = BrowseList::default();
        assert!(!list.resolved(&resolve("bench", 50051, &["fe80::1"], Some("v0.8.1"))));
        assert_eq!(list.snapshot(), vec![]);
        // …and it appears the moment a usable address arrives.
        assert!(list.resolved(&resolve("bench", 50051, &["192.168.1.10"], Some("v0.8.1"))));
    }

    #[test]
    fn loopback_never_outranks_a_routable_address() {
        // `enable_addr_auto()` announces on every interface, loopback
        // included. Preferring it would silently dial *this* machine.
        let mut list = BrowseList::default();
        list.resolved(&resolve("bench", 50051, &["127.0.0.1"], Some("v0.8.1")));
        assert_eq!(list.snapshot()[0].address, "127.0.0.1:50051");
        list.resolved(&resolve("bench", 50051, &["192.168.1.10"], Some("v0.8.1")));
        assert_eq!(list.snapshot()[0].address, "192.168.1.10:50051");
    }

    #[test]
    fn a_link_local_ipv4_address_is_a_last_resort_behind_a_routable_one() {
        let mut list = BrowseList::default();
        list.resolved(&resolve(
            "bench",
            50051,
            &["169.254.7.7", "192.168.1.10"],
            Some("v0.8.1"),
        ));
        assert_eq!(list.snapshot()[0].address, "192.168.1.10:50051");
    }

    #[test]
    fn an_ipv6_only_server_is_offered_in_the_bracketed_form() {
        let mut list = BrowseList::default();
        list.resolved(&resolve("bench", 50051, &["2001:db8::5"], Some("v0.8.1")));
        assert_eq!(list.snapshot()[0].address, "[2001:db8::5]:50051");
    }

    #[test]
    fn the_instance_name_is_the_fullname_without_the_service_type() {
        assert_eq!(instance_name("bench._cannet._tcp.local."), "bench");
        assert_eq!(
            instance_name("some.other._http._tcp.local."),
            "some.other._http._tcp.local.",
            "a fullname that isn't ours is left whole rather than mangled",
        );
    }

    /// Drives the real adapter and reducer off a real advertisement,
    /// over the host's actual multicast interfaces — the one thing the
    /// synthetic sequences above cannot check, which is that a
    /// `cannet-server`-shaped registration reduces to a row the connect
    /// surface can use.
    ///
    /// Binds real sockets and depends on the local network stack
    /// permitting multicast loopback, so it is excluded from the
    /// default suite. Run explicitly with
    /// `cargo test -p cannet-gui --lib -- --ignored browse_a_live_advertisement`.
    /// Same-host only: cross-machine reachability additionally needs an
    /// inbound UDP 5353 firewall allow (see the README).
    #[test]
    #[ignore = "binds real multicast sockets; environment-dependent"]
    fn browse_a_live_advertisement() {
        use std::time::{Duration, Instant};

        use mdns_sd::ServiceInfo;

        // A name unique to this process so a concurrent run (or a
        // lingering advertisement from a previous one) can't collide.
        let name = format!("cannet-browse-test-{}", std::process::id());
        let fullname = format!("{name}.{SERVICE_TYPE}");
        // The exact shape `cannet-server` registers: instance name,
        // bound port, one `ver` TXT key, addresses on every interface.
        let info = ServiceInfo::new(
            SERVICE_TYPE,
            &name,
            &format!("{name}.local."),
            "",
            50071,
            &[("ver", "v0.0.0-test")][..],
        )
        .expect("service info assembles")
        .enable_addr_auto();
        let registrar = ServiceDaemon::new().expect("registrar daemon starts");
        registrar.register(info).expect("registration succeeds");

        let browser = ServiceDaemon::new().expect("browser daemon starts");
        let events = browser.browse(SERVICE_TYPE).expect("browse starts");

        let mut list = BrowseList::default();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            match events.recv_timeout(Duration::from_secs(1)) {
                Ok(ServiceEvent::ServiceResolved(service)) => {
                    list.resolved(&from_resolved_service(&service));
                }
                Ok(ServiceEvent::ServiceRemoved(_, gone)) => {
                    list.removed(&gone);
                }
                // Search-started / -stopped, found-before-resolve, and a
                // tick with nothing on the wire: all uninteresting here.
                Ok(_) | Err(_) => {}
            }
            if list.snapshot().iter().any(|s| s.fullname == fullname) {
                break;
            }
        }
        let found = list
            .snapshot()
            .into_iter()
            .find(|s| s.fullname == fullname)
            .expect("our own advertisement should be browsed within 5s");
        assert_eq!(found.name, name);
        assert_eq!(found.version.as_deref(), Some("v0.0.0-test"));
        assert!(
            found.address.ends_with(":50071"),
            "dialable address carries the advertised port: {}",
            found.address,
        );

        // The goodbye packet: `shutdown()` unregisters everything, and
        // the entry must go on the removal it produces.
        let done = registrar.shutdown().expect("registrar shuts down");
        let _ = done.recv_timeout(Duration::from_secs(3));
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok(ServiceEvent::ServiceRemoved(_, gone)) =
                events.recv_timeout(Duration::from_secs(1))
            {
                list.removed(&gone);
            }
            if !list.snapshot().iter().any(|s| s.fullname == fullname) {
                break;
            }
        }
        assert!(
            !list.snapshot().iter().any(|s| s.fullname == fullname),
            "the goodbye should have dropped the entry within 3s",
        );

        let _ = browser.shutdown();
    }

    #[test]
    fn the_wire_shape_is_what_the_connect_surface_renders() {
        let json = serde_json::to_value(DiscoveredServer {
            fullname: "bench._cannet._tcp.local.".into(),
            name: "bench".into(),
            address: "192.168.1.10:50051".into(),
            version: Some("v0.8.1".into()),
        })
        .unwrap();
        assert_eq!(json["fullname"], "bench._cannet._tcp.local.");
        assert_eq!(json["name"], "bench");
        assert_eq!(json["address"], "192.168.1.10:50051");
        assert_eq!(json["version"], "v0.8.1");
    }
}
