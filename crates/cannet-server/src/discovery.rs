//! mDNS/DNS-SD advertisement of `_cannet._tcp` (ADR 0040).
//!
//! Bare `cannet-server` — the production hardware proxy — registers
//! one service instance so the GUI's browse can find it on the local
//! network. `debug replay` and `debug vbus` never call this module:
//! discovery is a production-server concern.
//!
//! Discovery is convenience only (ADR 0040): the connection layer is
//! the security boundary, not visibility on the network.

use std::io;
use std::net::{IpAddr, SocketAddr};

use mdns_sd::{AsIpAddrs, ServiceDaemon, ServiceInfo};

/// DNS-SD service type this crate advertises under.
const SERVICE_TYPE: &str = "_cannet._tcp.local.";

/// A registered mDNS advertisement.
///
/// Dropping this without calling [`Advertisement::shutdown`] leaves
/// the daemon's goodbye packet to its own background teardown, with
/// nothing waiting for it to reach the wire — call `shutdown` and
/// await it on any deliberate exit path (e.g. a Ctrl-C handler) so the
/// goodbye is not racing process exit.
pub struct Advertisement {
    daemon: ServiceDaemon,
}

impl Advertisement {
    /// Register `name` on `bind`'s port, advertising `version` as the
    /// sole TXT key (`ver=<version>`).
    ///
    /// The advertised addresses are the ones `bind` actually serves:
    /// exactly the bound address when it names one interface, and —
    /// only for the wildcard, which serves them all — every address of
    /// this host, kept current as interfaces come and go
    /// (`enable_addr_auto()`). A service instance must never carry an
    /// address nothing is listening on: a client that browses is told
    /// where to dial, and an address the server does not answer on is
    /// a connection failure with no explanation.
    pub fn register(name: &str, bind: SocketAddr, version: &str) -> mdns_sd::Result<Self> {
        let info = service_info(name, bind, version)?;
        let daemon = ServiceDaemon::new()?;
        daemon.register(info)?;
        Ok(Self { daemon })
    }

    /// Send the goodbye packet and block until the daemon confirms
    /// teardown is complete.
    ///
    /// RFC 6762 §10.1's goodbye/TTL=1 caching floor measured ~1 s in
    /// this crate's mDNS spike; a caller that exits the process the
    /// instant `ServiceDaemon::shutdown()` returns races that window
    /// and can lose the goodbye entirely; awaiting the receiver this
    /// returns waits for the daemon thread's own completion signal,
    /// which it sends only after the goodbye packets are written.
    pub async fn shutdown(self) {
        let Ok(receiver) = self.daemon.shutdown() else {
            return;
        };
        let _ = receiver.recv_async().await;
    }
}

/// Build the `ServiceInfo` bare `cannet-server` registers: `name` as
/// the DNS-SD instance, `bind`'s port as the port, `bind`'s addresses
/// as the addresses, and a single `ver` TXT key. Pulled out of
/// [`Advertisement::register`] so the assembly — instance naming, TXT
/// shape, port, address set — is unit-testable without a live daemon
/// (registering binds real sockets).
fn service_info(name: &str, bind: SocketAddr, version: &str) -> mdns_sd::Result<ServiceInfo> {
    let host = format!("{name}.local.");
    let addresses: Box<dyn AsIpAddrs> = match served_address(bind) {
        Some(ip) => Box::new(ip),
        None => Box::new(()),
    };
    let info = ServiceInfo::new(
        SERVICE_TYPE,
        name,
        &host,
        addresses,
        bind.port(),
        &[("ver", version)][..],
    )?;
    // Auto-detection is the truthful answer for a wildcard bind and
    // only for a wildcard bind: it publishes every address this host
    // has, including ones added after startup, which is exactly the
    // set a wildcard listener answers on.
    Ok(if served_address(bind).is_none() {
        info.enable_addr_auto()
    } else {
        info
    })
}

/// The single address `bind` serves on, or `None` when it serves every
/// interface (the wildcard `0.0.0.0` / `[::]`).
///
/// An IPv4-mapped IPv6 bind is reported as the IPv4 address it names:
/// that is the address a client dials, so it is the address to publish.
fn served_address(bind: SocketAddr) -> Option<IpAddr> {
    let ip = match bind.ip() {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4),
        v4 @ IpAddr::V4(_) => v4,
    };
    (!ip.is_unspecified()).then_some(ip)
}

/// `--name`'s resolved value: the operator's choice, or this machine's
/// hostname when none was given (RFC 6763's "no configuration
/// necessary" default).
///
/// A non-UTF-8 hostname is reported as an error rather than lossily
/// converted, so a broken advertisement fails at startup instead of
/// registering under a mangled name.
pub fn advertised_name(explicit: Option<&str>) -> io::Result<String> {
    match explicit {
        Some(name) => Ok(name.to_string()),
        None => hostname::get()?.into_string().map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "system hostname is not valid UTF-8",
            )
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::net::IpAddr;

    use super::*;

    fn addr(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    /// Every address the advertisement built for `bind` will publish,
    /// or `None` when it delegates the set to the daemon's
    /// every-interface auto-detection.
    fn advertised(bind: &str) -> Option<BTreeSet<IpAddr>> {
        let info = service_info("my-host", addr(bind), "v0.1.0").unwrap();
        if info.is_addr_auto() {
            assert!(
                info.get_addresses().is_empty(),
                "auto-detection and a fixed set are alternatives, not a union"
            );
            return None;
        }
        Some(info.get_addresses().iter().copied().collect())
    }

    fn only(ip: &str) -> BTreeSet<IpAddr> {
        BTreeSet::from([ip.parse::<IpAddr>().unwrap()])
    }

    #[test]
    fn the_fullname_is_the_instance_under_the_cannet_service_type() {
        let info = service_info("my-host", addr("0.0.0.0:50051"), "v0.1.0").unwrap();
        assert_eq!(info.get_fullname(), "my-host._cannet._tcp.local.");
    }

    #[test]
    fn the_port_is_the_bound_port() {
        let info = service_info("my-host", addr("0.0.0.0:50051"), "v0.1.0").unwrap();
        assert_eq!(info.get_port(), 50051);
    }

    #[test]
    fn the_txt_record_carries_exactly_one_ver_key() {
        let info = service_info("my-host", addr("0.0.0.0:50051"), "v0.1.0-3-gabc1234").unwrap();
        assert_eq!(info.get_properties().len(), 1, "no labels (ADR 0040)");
        assert_eq!(info.get_property_val_str("ver"), Some("v0.1.0-3-gabc1234"));
    }

    #[test]
    fn a_wildcard_bind_announces_every_interface_automatically() {
        // The wildcard is the one bind for which "every address this
        // host has" is the truthful answer, so it is the one bind that
        // delegates the set to the daemon — and it has to keep
        // delegating, because an interface that appears later is served
        // too.
        assert_eq!(advertised("0.0.0.0:50051"), None);
        assert_eq!(advertised("[::]:50051"), None);
    }

    #[test]
    fn a_loopback_bind_advertises_loopback_and_nothing_else() {
        // The defect this guards: auto-detection published this host's
        // LAN and VM-adapter addresses for a server that answers on
        // none of them, so a browsing client found it and could not
        // reach it.
        assert_eq!(advertised("127.0.0.1:50051"), Some(only("127.0.0.1")));
        assert_eq!(advertised("[::1]:50051"), Some(only("::1")));
    }

    #[test]
    fn a_bind_to_one_routable_interface_advertises_only_that_interface() {
        assert_eq!(advertised("192.168.1.10:50051"), Some(only("192.168.1.10")));
        assert_eq!(advertised("[2001:db8::1]:50051"), Some(only("2001:db8::1")));
    }

    #[test]
    fn an_ipv4_mapped_bind_is_advertised_as_the_ipv4_address_it_names() {
        // `::ffff:192.168.1.10` is a spelling of an IPv4 address, and a
        // client reaching this server dials the IPv4 one; publishing
        // the mapped form as a AAAA record would advertise an address
        // no client dials.
        assert_eq!(
            advertised("[::ffff:192.168.1.10]:50051"),
            Some(only("192.168.1.10"))
        );
        assert_eq!(
            advertised("[::ffff:127.0.0.1]:50051"),
            Some(only("127.0.0.1"))
        );
    }

    #[test]
    fn an_explicit_name_wins_and_never_touches_the_system_hostname() {
        assert_eq!(advertised_name(Some("custom-name")).unwrap(), "custom-name");
    }

    #[test]
    fn no_name_falls_back_to_the_system_hostname() {
        let name = advertised_name(None).unwrap();
        assert!(
            !name.is_empty(),
            "every host this runs on reports some hostname"
        );
    }

    // No register-and-browse round trip lives here: such a test puts a
    // real `_cannet._tcp` instance name on the LAN's multicast group,
    // which is never acceptable from an unattended run. The
    // advertised-address rules are pinned by the socket-free tests
    // above; that mdns-sd's own daemon resolves what it registers is
    // that crate's contract, not ours.
}
