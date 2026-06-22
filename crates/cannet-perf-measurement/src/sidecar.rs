//! Spawn the python-can sidecar for the full-stack mode.
//!
//! A trimmed, Tauri-free version of the GUI host's sidecar launcher
//! (`apps/gui/src-tauri/src/sidecar.rs`): run `uv --directory <pkg> run
//! cannet-python-can`, keep its stdin open (closing it is the sidecar's
//! shutdown signal), and parse the `sidecar\tlistening\t<addr>` banner
//! from stdout to learn the gRPC address. Dropping [`SidecarProcess`]
//! closes stdin and kills the child.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

/// A running sidecar child and its bound gRPC address.
pub struct SidecarProcess {
    child: Child,
    _stdin: ChildStdin,
    address: String,
}

impl SidecarProcess {
    /// Spawn the sidecar and wait (up to ~30 s) for its listening banner.
    ///
    /// # Errors
    /// Returns a message if the package dir can't be found, `uv` can't be
    /// spawned, or the banner never arrives.
    pub fn spawn() -> Result<Self, String> {
        let dir = sidecar_dir()?;
        let mut child = Command::new("uv")
            .arg("--directory")
            .arg(&dir)
            .args(["run", "cannet-python-can"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("spawning `uv run cannet-python-can`: {e}"))?;

        let stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;

        // Reader thread: drain stdout, forward the listening address once.
        let (tx, rx) = mpsc::channel::<String>();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Some(addr) = line.strip_prefix("sidecar\tlistening\t") {
                    let _ = tx.send(addr.to_string());
                }
            }
        });

        let Ok(address) = rx.recv_timeout(Duration::from_secs(30)) else {
            let _ = child.kill();
            return Err("sidecar did not report a listening address".into());
        };

        Ok(Self {
            child,
            _stdin: stdin,
            address,
        })
    }

    /// The sidecar's gRPC address (`host:port`).
    #[must_use]
    pub fn address(&self) -> &str {
        &self.address
    }
}

impl Drop for SidecarProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Locate the `cannet-python-can` package directory: `CANNET_SIDECAR_DIR`
/// if set, else the workspace path relative to this crate's manifest.
fn sidecar_dir() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("CANNET_SIDECAR_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../servers/cannet-python-can");
    if dir.join("pyproject.toml").is_file() {
        Ok(dir)
    } else {
        Err(format!(
            "sidecar package not found at {} (set CANNET_SIDECAR_DIR)",
            dir.display()
        ))
    }
}
