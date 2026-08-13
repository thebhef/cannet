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
use std::net::SocketAddr;

use mdns_sd::{ServiceDaemon, ServiceInfo};

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
    /// Addresses are announced on every interface
    /// (`enable_addr_auto()`), VM and virtual adapters included — the
    /// simple default; binding only the interfaces `bind` actually
    /// serves on is not implemented.
    pub fn register(name: &str, bind: SocketAddr, version: &str) -> mdns_sd::Result<Self> {
        let info = service_info(name, bind.port(), version)?;
        let daemon = ServiceDaemon::new()?;
        daemon.register(info)?;
        Ok(Self { daemon })
    }

    /// Send the goodbye packet and block until the daemon confirms
    /// teardown is complete.
    ///
    /// RFC 6762 §10.1's goodbye/TTL=1 caching floor measured ~1 s in
    /// the Task 43 phase-1 spike; a caller that exits the process the
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
/// the DNS-SD instance, `port` as the bound port, and a single `ver`
/// TXT key. Pulled out of [`Advertisement::register`] so the assembly
/// — instance naming, TXT shape, port — is unit-testable without a
/// live daemon (registering binds real sockets).
fn service_info(name: &str, port: u16, version: &str) -> mdns_sd::Result<ServiceInfo> {
    let host = format!("{name}.local.");
    ServiceInfo::new(SERVICE_TYPE, name, &host, "", port, &[("ver", version)][..])
        .map(ServiceInfo::enable_addr_auto)
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
    use super::*;

    #[test]
    fn the_fullname_is_the_instance_under_the_cannet_service_type() {
        let info = service_info("my-host", 50051, "v0.1.0").unwrap();
        assert_eq!(info.get_fullname(), "my-host._cannet._tcp.local.");
    }

    #[test]
    fn the_port_is_the_bound_port() {
        let info = service_info("my-host", 50051, "v0.1.0").unwrap();
        assert_eq!(info.get_port(), 50051);
    }

    #[test]
    fn the_txt_record_carries_exactly_one_ver_key() {
        let info = service_info("my-host", 50051, "v0.1.0-3-gabc1234").unwrap();
        assert_eq!(info.get_properties().len(), 1, "no labels (ADR 0040)");
        assert_eq!(info.get_property_val_str("ver"), Some("v0.1.0-3-gabc1234"));
    }

    #[test]
    fn addresses_are_announced_on_every_interface_automatically() {
        let info = service_info("my-host", 50051, "v0.1.0").unwrap();
        assert!(info.is_addr_auto());
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

    /// Registers a real advertisement and browses for it in the same
    /// process, over the host's actual multicast interfaces.
    ///
    /// Binds real sockets and depends on the local network stack
    /// permitting multicast loopback, so it is excluded from the
    /// default suite. Run explicitly with
    /// `cargo test -p cannet-server --lib -- --ignored register_and_browse`.
    /// The Task 43 phase-1 spike exercised this same-host only — it is
    /// not evidence of cross-machine reachability, which additionally
    /// needs an inbound UDP 5353 firewall allow (see the README).
    #[tokio::test]
    #[ignore = "binds real multicast sockets; environment-dependent"]
    async fn register_and_browse_round_trip() {
        use std::time::{Duration, Instant};

        use mdns_sd::ServiceEvent;

        // A name unique to this process so a concurrent run (or a
        // lingering advertisement from a previous one) can't collide.
        let name = format!("cannet-discovery-test-{}", std::process::id());
        let fullname = format!("{name}.{SERVICE_TYPE}");
        let bind = "127.0.0.1:50061".parse().unwrap();

        let advertisement = Advertisement::register(&name, bind, "v0.0.0-test")
            .expect("register should succeed on a machine with a working mDNS stack");

        let browser = ServiceDaemon::new().expect("browser daemon should start");
        let events = browser.browse(SERVICE_TYPE).expect("browse should start");

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut resolved = false;
        while Instant::now() < deadline {
            if let Ok(ServiceEvent::ServiceResolved(info)) =
                events.recv_timeout(Duration::from_secs(1))
            {
                if info.get_fullname() == fullname {
                    assert_eq!(info.get_property_val_str("ver"), Some("v0.0.0-test"));
                    assert_eq!(info.get_port(), 50061);
                    resolved = true;
                    break;
                }
            }
        }
        assert!(
            resolved,
            "expected to resolve our own advertisement within 5s"
        );

        advertisement.shutdown().await;

        let deadline = Instant::now() + Duration::from_secs(3);
        let mut removed = false;
        while Instant::now() < deadline {
            if let Ok(ServiceEvent::ServiceRemoved(_, removed_fullname)) =
                events.recv_timeout(Duration::from_secs(1))
            {
                if removed_fullname == fullname {
                    removed = true;
                    break;
                }
            }
        }
        assert!(removed, "expected the goodbye's ServiceRemoved within 3s");

        let _ = browser.shutdown();
    }
}
