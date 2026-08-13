//! Where the hardware-peak mode dials for frames: the python-can sidecar
//! spawned directly, or a locally spawned production `cannet-server`
//! ([ADR 0040](../../../docs/adr/0040-production-cannet-server.md))
//! proxying the sidecar it supervises itself.
//!
//! Both arms hand back a `host:port` the mode dials with the same client,
//! and both produce the same report shape, so the two runs differ by the
//! proxy hop and nothing else — which is what makes proxy overhead
//! measurable by comparing them.

use std::net::{SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use crate::sidecar::SidecarProcess;

/// How long the server gets to come up, supervise its sidecar, and answer
/// an enumeration. A cold `uv run` resolves the environment first, so this
/// is generous — the same budget the server's own sidecar test allows.
const SERVER_READY_BUDGET: Duration = Duration::from_secs(90);

/// Which upstream a hardware-peak run measures through.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpstreamSpec {
    /// Spawn the python-can sidecar and dial it directly.
    Sidecar,
    /// Spawn this `cannet-server` binary bare — production mode, where it
    /// supervises its own sidecar — and dial its `--bind` address.
    Server(PathBuf),
}

impl UpstreamSpec {
    /// A server binary selects the proxy path; its absence keeps the
    /// direct one, which is what the baseline and the gate run.
    #[must_use]
    pub fn from_server_binary(binary: Option<PathBuf>) -> Self {
        binary.map_or(Self::Sidecar, Self::Server)
    }

    /// The `mode` tag the report carries, so a proxied run's numbers can't
    /// be mistaken for a direct run's.
    #[must_use]
    pub fn mode(&self) -> &'static str {
        match self {
            Self::Sidecar => "hardware-peak",
            Self::Server(_) => "hardware-peak-proxy",
        }
    }
}

/// A spawned upstream, alive until dropped.
pub enum Upstream {
    Sidecar(SidecarProcess),
    Server(ServerProcess),
}

impl Upstream {
    /// Spawn the upstream `spec` names and wait until it can be dialled.
    ///
    /// # Errors
    /// Returns a message if the child can't be spawned or never becomes
    /// reachable.
    pub fn spawn(spec: &UpstreamSpec) -> Result<Self, String> {
        match spec {
            UpstreamSpec::Sidecar => SidecarProcess::spawn().map(Self::Sidecar),
            UpstreamSpec::Server(binary) => ServerProcess::spawn(binary).map(Self::Server),
        }
    }

    /// The gRPC address (`host:port`) to dial.
    #[must_use]
    pub fn address(&self) -> &str {
        match self {
            Self::Sidecar(s) => s.address(),
            Self::Server(s) => s.address(),
        }
    }
}

/// A running `cannet-server` and the address it proxies on. Dropping it
/// kills the server — and with it, through the closed stdin pipe, the
/// sidecar it supervises.
pub struct ServerProcess {
    child: Child,
    address: String,
}

impl ServerProcess {
    /// Spawn `binary` bare on a free loopback port and wait until an
    /// enumeration crosses the proxy (i.e. its supervised sidecar is up).
    ///
    /// # Errors
    /// Returns a message if the binary can't be spawned, exits early, or
    /// never answers within [`SERVER_READY_BUDGET`].
    pub fn spawn(binary: &Path) -> Result<Self, String> {
        let bind = free_local_port()?;
        let child = server_command(binary, bind)
            .spawn()
            .map_err(|e| format!("spawning {}: {e}", binary.display()))?;
        let mut server = Self {
            child,
            address: bind.to_string(),
        };
        server.wait_until_reachable()?;
        Ok(server)
    }

    /// The proxy's gRPC address (`host:port`).
    #[must_use]
    pub fn address(&self) -> &str {
        &self.address
    }

    /// Poll `ListInterfaces` until the proxy has an upstream to answer
    /// from. Until the supervised sidecar reports its port the proxy is up
    /// but has nothing behind it, and says so.
    fn wait_until_reachable(&mut self) -> Result<(), String> {
        let rt = tokio::runtime::Runtime::new().map_err(|e| format!("tokio runtime: {e}"))?;
        let deadline = Instant::now() + SERVER_READY_BUDGET;
        loop {
            if let Ok(Some(status)) = self.child.try_wait() {
                return Err(format!("cannet-server exited early ({status})"));
            }
            match rt.block_on(cannet_client::list_interfaces(
                &cannet_client::ConnectConfig::plaintext(&self.address),
            )) {
                Ok(_) => return Ok(()),
                Err(e) if Instant::now() >= deadline => {
                    return Err(format!(
                        "cannet-server never answered on {}: {e}",
                        self.address
                    ))
                }
                Err(_) => std::thread::sleep(Duration::from_millis(250)),
            }
        }
    }
}

impl Drop for ServerProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The bare (production-mode) server invocation: no subcommand, one
/// `--bind`. stdin is piped rather than inherited because the server
/// passes that lifetime on to the sidecar it supervises.
fn server_command(binary: &Path, bind: SocketAddr) -> Command {
    let mut cmd = Command::new(binary);
    cmd.arg("--bind")
        .arg(bind.to_string())
        .stdin(Stdio::piped())
        .stderr(Stdio::inherit());
    cmd
}

/// A free loopback port, taken by binding and releasing it.
fn free_local_port() -> Result<SocketAddr, String> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("reserving a port: {e}"))?;
    listener
        .local_addr()
        .map_err(|e| format!("reading the reserved port: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_server_binary_keeps_the_direct_sidecar_path() {
        assert_eq!(
            UpstreamSpec::from_server_binary(None),
            UpstreamSpec::Sidecar
        );
    }

    #[test]
    fn a_server_binary_selects_the_proxy_path() {
        let binary = PathBuf::from("/opt/cannet/cannet-server");
        assert_eq!(
            UpstreamSpec::from_server_binary(Some(binary.clone())),
            UpstreamSpec::Server(binary)
        );
    }

    #[test]
    fn each_path_tags_its_report_with_its_own_mode() {
        assert_eq!(UpstreamSpec::Sidecar.mode(), "hardware-peak");
        assert_eq!(
            UpstreamSpec::Server(PathBuf::from("cannet-server")).mode(),
            "hardware-peak-proxy"
        );
    }

    #[test]
    fn the_server_is_spawned_bare_on_the_address_the_harness_dials() {
        let cmd = server_command(
            Path::new("/opt/cannet/cannet-server"),
            "127.0.0.1:50123".parse().unwrap(),
        );
        assert_eq!(cmd.get_program(), "/opt/cannet/cannet-server");
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        // Bare — no subcommand; `debug replay` / `debug vbus` would each
        // measure something else entirely.
        assert_eq!(args, ["--bind", "127.0.0.1:50123"]);
    }

    #[test]
    fn a_reserved_port_is_loopback_and_nonzero() {
        let addr = free_local_port().expect("a loopback port should be reservable");
        assert!(addr.ip().is_loopback());
        assert_ne!(addr.port(), 0);
    }
}
