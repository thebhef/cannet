//! The production proxy against the **real** `cannet-python-can`
//! sidecar (ADR 0040) — the one thing `tests/proxy.rs` cannot show,
//! because it stands an in-process server in for the sidecar.
//!
//! Ignored by default: it launches a Python process (through `uv`, or
//! the frozen launcher if one is unpacked beside the binary) and
//! enumerates whatever CAN hardware the machine has. Run it
//! deliberately:
//!
//! ```sh
//! cargo test -p cannet-server --test proxy_sidecar -- --ignored
//! ```

use std::net::{SocketAddr, TcpListener};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use cannet_wire::proto::{cannet_server_client::CannetServerClient, ListInterfacesRequest};

/// How long the sidecar gets to start and report its bound port. A
/// cold `uv run` resolves the environment first, so this is generous.
const STARTUP_BUDGET: Duration = Duration::from_secs(90);

/// Kills the server on the way out — and with it, through the closed
/// stdin pipe, the sidecar it supervises.
struct ServerProcess(std::process::Child);

impl Drop for ServerProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn free_port() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "spawns the real python-can sidecar; keeps the default suite Python-free"]
async fn the_production_proxy_serves_the_supervised_sidecars_interfaces() {
    let bind = free_port();
    let server = ServerProcess(
        Command::new(env!("CARGO_BIN_EXE_cannet-server"))
            .arg("--bind")
            .arg(bind.to_string())
            .stdin(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("cannet-server should be spawnable"),
    );

    // Until the sidecar reports a bound port the proxy has no upstream
    // and says so; the interesting assertion is that this resolves on
    // its own, with nothing but the server process running.
    let deadline = Instant::now() + STARTUP_BUDGET;
    let mut last = String::new();
    loop {
        assert!(
            Instant::now() < deadline,
            "the proxy never got an upstream: {last}"
        );
        match CannetServerClient::connect(format!("http://{bind}")).await {
            Ok(mut client) => match client.list_interfaces(ListInterfacesRequest {}).await {
                Ok(response) => {
                    // The interface set depends on the hardware present,
                    // so the assertion is that the enumeration crossed
                    // the proxy at all — not what it found.
                    eprintln!("proxied interfaces: {:?}", response.into_inner());
                    break;
                }
                Err(status) => last = format!("{status}"),
            },
            Err(e) => last = format!("{e}"),
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    drop(server);
}
