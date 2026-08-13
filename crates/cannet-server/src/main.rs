//! `cannet-server` CLI.
//!
//! Bare invocation is the production hardware proxy (ADR 0040): it
//! supervises the `cannet-python-can` sidecar on loopback and relays
//! the sidecar's interfaces, under their real identities, to one
//! network endpoint. That endpoint terminates TLS on request
//! (ADR 0041), under the server's own generated certificate or
//! operator-supplied material. Unless `--no-mdns` is given, it also
//! advertises `_cannet._tcp` so the GUI's browse can find it, and a
//! Ctrl-C waits for the mDNS goodbye packet before the process exits.
//!
//! `debug replay <blf>` and `debug vbus` are the prior BLF-replay and
//! `--virtual-bus` modes, kept as explicitly dev/test tooling: replay
//! serves a BLF file on a loop over the gRPC wire protocol defined in
//! `cannet-wire`, and vbus (ADR 0021) hosts a multi-client virtual CAN
//! bus. Neither advertises — discovery is a production-server concern.

use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use cannet_core::BusConfig;
use cannet_server::{
    auth, discovery, identity, install_crypto_provider, AccessToken, CannetServerImpl,
    IdentityError, LoopingBlfReplay, ProxyServerImpl, ServerIdentity, VirtualBusServerImpl,
    VIRTUAL_BUS_FACTORY_ID,
};
use cannet_sidecar::{
    LogLevel, SidecarConfig, SidecarHost, SidecarPhase, SidecarStatus, SidecarSupervisor, SOURCE,
};
use clap::{Args, Parser, Subcommand};
use tonic::transport::Server;

#[derive(Parser, Debug)]
#[command(version, about = "cannet gRPC server")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
    #[command(flatten)]
    proxy: ProxyArgs,
}

/// Options for the bare invocation — the production hardware proxy.
/// Ignored when a `debug` subcommand is given.
#[derive(Args, Debug)]
struct ProxyArgs {
    /// Address to bind the gRPC service on. The default is loopback:
    /// serving the network is an explicit choice, and an unprotected
    /// non-loopback bind is refused (ADR 0041).
    #[arg(long, default_value = "127.0.0.1:50051")]
    bind: SocketAddr,
    /// The supervised sidecar's own `--log-level`, which governs how
    /// much it writes to stderr — and so how much of this server's log
    /// is the sidecar talking.
    #[arg(long, default_value = "info")]
    sidecar_log_level: String,
    /// How many times a crashing sidecar is restarted automatically
    /// before this server gives up and says so.
    #[arg(long, default_value_t = 3)]
    sidecar_restart_budget: u64,
    /// Terminate TLS on the bound endpoint, using the server's own
    /// certificate — generated and persisted in the per-user data
    /// directory on first use, so its fingerprint survives restarts.
    /// Implied by `--cert`.
    #[arg(long)]
    tls: bool,
    /// PEM certificate (or chain) to present instead of the generated
    /// one. Requires `--key`. Renewing this certificate changes the
    /// fingerprint, so every pinned client has to accept it again.
    #[arg(long, value_name = "PATH", requires = "key")]
    cert: Option<PathBuf>,
    /// PEM private key for `--cert`.
    #[arg(long, value_name = "PATH", requires = "cert")]
    key: Option<PathBuf>,
    /// Accept this bearer token from clients for this run, instead of
    /// the one generated and persisted beside the certificate. Nothing
    /// is written. Note that a command line is visible to anyone who
    /// can list this machine's processes; `CANNET_TOKEN` carries the
    /// same value without that exposure.
    #[arg(long, value_name = "VALUE")]
    token: Option<String>,
    /// Allow an unprotected endpoint to be bound to a routable address.
    /// Suppresses the startup refusal and nothing else — TLS that is
    /// configured stays on.
    #[arg(long)]
    insecure: bool,
    /// Instance name to advertise via mDNS/DNS-SD (`_cannet._tcp`).
    /// Defaults to this machine's hostname. Ignored with `--no-mdns`.
    #[arg(long, value_name = "NAME")]
    name: Option<String>,
    /// Disable mDNS/DNS-SD advertisement entirely (ADR 0040 —
    /// discovery is convenience only; the manual `host:port` field
    /// still reaches an unadvertised server).
    #[arg(long)]
    no_mdns: bool,
}

impl ProxyArgs {
    /// The TLS identity this invocation serves with, or `None` when it
    /// serves plaintext. Operator material wins over the generated
    /// identity; `--tls` alone reaches for the generated one.
    fn identity(&self) -> Result<Option<ServerIdentity>, IdentityError> {
        match (&self.cert, &self.key) {
            (Some(cert), Some(key)) => ServerIdentity::from_files(cert, key).map(Some),
            // clap's `requires` rejects one without the other, so the
            // remaining cases are "neither".
            _ if self.tls => {
                ServerIdentity::load_or_generate(&identity::default_identity_dir()?).map(Some)
            }
            _ => Ok(None),
        }
    }

    /// The token this invocation accepts from clients. `--token` wins
    /// over `CANNET_TOKEN`, and either wins over — and leaves
    /// untouched — the one persisted in `dir`.
    fn access_token(
        &self,
        dir: &Path,
        from_env: Option<&str>,
    ) -> Result<AccessToken, auth::TokenError> {
        match self.token.as_deref().or(from_env) {
            Some(value) => AccessToken::from_value(value),
            None => AccessToken::load_or_generate(dir),
        }
    }

    /// True when the operator named a token themselves, by either
    /// route. Distinguishes "no token was asked for" from "a token was
    /// asked for and this endpoint cannot carry one".
    fn token_was_supplied(&self, from_env: Option<&str>) -> bool {
        self.token.is_some() || from_env.is_some()
    }
}

/// The environment variable a token may arrive in, for operators who
/// would rather keep it out of the process list.
const TOKEN_ENV: &str = "CANNET_TOKEN";

/// The build's version string: `git describe --tags` as captured by
/// `build.rs` (vergen), e.g. `v0.1.0` on a release tag or
/// `v0.1.0-3-gabc1234` for a build a few commits past one. Falls back
/// to the Cargo crate version when the binary was built outside a git
/// checkout (no `VERGEN_GIT_DESCRIBE` set) — the same fallback
/// `apps/gui/src-tauri` uses. This is the value advertised as the
/// mDNS TXT record's `ver` key.
fn build_version() -> &'static str {
    match option_env!("VERGEN_GIT_DESCRIBE") {
        Some(v) if !v.is_empty() && v != "VERGEN_IDEMPOTENT_OUTPUT" => v,
        _ => env!("CARGO_PKG_VERSION"),
    }
}

/// What protects a bound endpoint, one field per requirement.
///
/// The guard reads this rather than a bare `bool` so that adding a
/// requirement is a field here and a line in [`Self::missing`] — not a
/// new argument at each of the three `--bind` sites.
#[derive(Debug, Clone, Copy, Default)]
struct Protections {
    /// The endpoint terminates TLS.
    tls: bool,
    /// The endpoint requires a bearer token on every RPC.
    token: bool,
}

impl Protections {
    /// The requirements this endpoint fails to meet, phrased as the
    /// flags that would satisfy them.
    fn missing(self) -> Vec<&'static str> {
        let mut missing = Vec::new();
        if !self.tls {
            missing.push("TLS (--tls, or --cert with --key)");
        }
        if !self.token {
            // In practice this travels with the line above: a token is
            // derived whenever TLS is on, because it may not ride a
            // plaintext channel. The requirement is still listed on its
            // own, so the refusal never claims more protection than the
            // endpoint actually has.
            missing.push("client authentication");
        }
        missing
    }
}

/// True when `ip` names this machine's loopback interface, including
/// the IPv4-mapped IPv6 spelling of it (`::ffff:127.0.0.1`), which
/// [`std::net::Ipv6Addr::is_loopback`] alone does not recognise.
fn is_loopback(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map_or_else(|| v6.is_loopback(), |v4| v4.is_loopback()),
    }
}

/// Refuse to bind an unprotected endpoint to anything but loopback
/// (ADR 0041).
///
/// A loopback bind is the operator's own machine and stays plaintext by
/// default. Anything routable exposes control of physical CAN hardware
/// to whoever can reach the port, so it has to be protected — or the
/// operator has to say `--insecure` out loud. `--insecure` suppresses
/// this error and nothing else: it never turns off protection that is
/// configured.
fn guard_bind(
    bind: SocketAddr,
    protections: Protections,
    insecure: bool,
) -> Result<(), UnprotectedBind> {
    let missing = protections.missing();
    if insecure || missing.is_empty() || is_loopback(bind.ip()) {
        return Ok(());
    }
    Err(UnprotectedBind { bind, missing })
}

/// A non-loopback bind that nothing protects, refused at startup.
#[derive(Debug)]
struct UnprotectedBind {
    bind: SocketAddr,
    missing: Vec<&'static str>,
}

impl std::fmt::Display for UnprotectedBind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "refusing to bind {}: reachable from the network without {}. \
             Add it, bind loopback instead, or pass --insecure to serve \
             the hardware in the clear anyway.",
            self.bind,
            self.missing.join(" and without ")
        )
    }
}

impl std::error::Error for UnprotectedBind {}

#[derive(Subcommand, Debug)]
enum Command {
    /// Dev/test tooling: BLF replay or a virtual bus, in place of the
    /// production hardware proxy.
    #[command(subcommand)]
    Debug(DebugCommand),
}

#[derive(Subcommand, Debug)]
enum DebugCommand {
    /// Load a BLF file and replay it on a loop over the gRPC wire
    /// protocol. Dev/test tooling.
    Replay {
        /// Path to the BLF file to load and replay on a loop.
        blf: PathBuf,
        /// Address to bind the gRPC service on. Dev/test tooling takes
        /// no certificate, so leaving loopback needs `--insecure`.
        #[arg(long, default_value = "127.0.0.1:50051")]
        bind: SocketAddr,
        /// Allow this unprotected endpoint to be bound to a routable
        /// address.
        #[arg(long)]
        insecure: bool,
        /// Replay rate multiplier. `1.0` plays the BLF back at its
        /// recorded cadence (real-time emulation); `100.0` would play
        /// it 100× faster; `0.0` (the default) disables pacing
        /// entirely and streams frames as fast as the consumer
        /// drains, which is useful for development, tests, and
        /// stress-testing clients but does not resemble the cadence
        /// of any real CAN bus.
        #[arg(long, default_value_t = 0.0)]
        rate: f64,
    },
    /// Host a multi-client virtual CAN bus (ADR 0021): one factory
    /// interface (`virtual:bus0`). Any number of concurrent clients
    /// may connect; each `Subscribe` allocates a fresh participant
    /// whose transmissions fan out to every other participant.
    /// Dev/test tooling.
    Vbus {
        /// Address to bind the gRPC service on. Dev/test tooling takes
        /// no certificate, so leaving loopback needs `--insecure`.
        #[arg(long, default_value = "127.0.0.1:50051")]
        bind: SocketAddr,
        /// Allow this unprotected endpoint to be bound to a routable
        /// address.
        #[arg(long)]
        insecure: bool,
        /// Arbitration-phase bit rate (bits per second) for the
        /// virtual bus's initial configuration.
        #[arg(long, default_value_t = 500_000)]
        speed_bps: u64,
        /// Data-phase bit rate (bits per second) for CAN FD frames
        /// with BRS set. `0` (default) leaves the virtual bus
        /// classic-only.
        #[arg(long, default_value_t = 0)]
        fd_data_speed_bps: u64,
    },
}

async fn run_replay(
    blf: PathBuf,
    bind: SocketAddr,
    rate: f64,
    insecure: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    guard_bind(bind, Protections::default(), insecure)?;
    let replay = Arc::new(LoopingBlfReplay::open(&blf)?);

    eprintln!(
        "loaded {} interface(s) from {}",
        replay.interfaces().len(),
        blf.display()
    );
    for iface in replay.interfaces() {
        eprintln!(
            "  {} ({}) {}",
            iface.id,
            iface.display_name,
            if iface.fd_capable { "[fd]" } else { "" }
        );
    }
    eprintln!(
        "listening on {} (rate = {})",
        bind,
        if rate == 0.0 {
            "unbounded".to_string()
        } else {
            format!("{rate}×")
        }
    );

    let service = CannetServerImpl::new(replay, rate).into_service();
    Server::builder().add_service(service).serve(bind).await?;
    Ok(())
}

async fn run_vbus(
    bind: SocketAddr,
    speed_bps: u64,
    fd_data_speed_bps: u64,
    insecure: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    guard_bind(bind, Protections::default(), insecure)?;
    let fd_enabled = fd_data_speed_bps > 0;
    let config = BusConfig {
        speed_bps,
        fd_data_speed_bps: if fd_enabled {
            Some(fd_data_speed_bps)
        } else {
            None
        },
        fd_enabled,
    };
    eprintln!(
        "virtual-bus mode: factory {VIRTUAL_BUS_FACTORY_ID} \
         (speed {} bit/s, fd data {})",
        config.speed_bps,
        config
            .fd_data_speed_bps
            .map_or_else(|| "off".to_string(), |v| format!("{v} bit/s"))
    );
    eprintln!("listening on {bind}");
    let service = VirtualBusServerImpl::new(config).into_service();
    Server::builder().add_service(service).serve(bind).await?;
    Ok(())
}

/// The name of the frozen sidecar's onedir, as
/// `scripts/build-sidecar.py` emits it. A distribution archive unpacks
/// it beside the server binary.
const FROZEN_SIDECAR_DIR: &str = "cannet-python-can";

/// The frozen sidecar launcher inside `dir`, or `None` when it isn't
/// there — the developer flow, where the shared crate falls back to
/// running the sidecar's source tree through `uv`.
fn frozen_launcher_in(dir: &Path) -> Option<PathBuf> {
    let launcher = dir
        .join(FROZEN_SIDECAR_DIR)
        .join(cannet_sidecar::frozen_launcher_name());
    launcher.is_file().then_some(launcher)
}

/// This CLI as the sidecar supervisor's host. A headless server has no
/// settings file and no message ring, so the two halves the trait asks
/// about are its own flags on the way in and its stderr on the way out.
struct CliSidecarHost {
    log_level: String,
    restart_budget: u64,
    /// The runtime the wait loop's thread is taken from. Captured
    /// rather than looked up per call so a restart dispatched from
    /// inside the wait loop's own blocking thread cannot depend on
    /// that thread carrying the runtime context.
    runtime: tokio::runtime::Handle,
}

impl SidecarHost for CliSidecarHost {
    fn config(&self) -> SidecarConfig {
        SidecarConfig {
            frozen_launcher: std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().and_then(frozen_launcher_in)),
            // A debug build is a developer running `cargo run`, where
            // edits to the sidecar source tree must win over any frozen
            // artifact that happens to be lying beside the binary
            // (ADR 0036).
            prefer_source_tree: cfg!(debug_assertions),
            sidecar_dir: std::env::var_os(cannet_sidecar::SIDECAR_DIR_ENV),
            log_level: self.log_level.clone(),
            // No `--log-file`: a headless server's log *is* its stderr,
            // and everything the sidecar writes is already on it.
            log_file: None,
            // Nothing to forward: the child inherits this process's
            // environment, so a driver-module override set for the
            // server reaches the sidecar untouched.
            driver_module: None,
        }
    }

    fn log(&self, level: LogLevel, message: String) {
        let level = match level {
            LogLevel::Debug => "debug",
            LogLevel::Info => "info",
            LogLevel::Warn => "warn",
            LogLevel::Error => "error",
        };
        eprintln!("[{level}] {SOURCE}: {message}");
    }

    fn restart_budget(&self) -> u64 {
        self.restart_budget
    }

    fn status_changed(&self, _previous: &SidecarStatus, current: &SidecarStatus) {
        // The proxy reads the same status per RPC, so this line is
        // purely the operator's view of why the endpoint is (or isn't)
        // answering yet.
        match (current.phase, current.address.as_deref()) {
            (SidecarPhase::Ready, Some(address)) => {
                eprintln!("[info] {SOURCE}: upstream ready on {address}");
            }
            (SidecarPhase::Starting, _) => eprintln!("[info] {SOURCE}: starting"),
            (SidecarPhase::Offline, _) => {
                eprintln!("[warn] {SOURCE}: offline; sessions are unavailable until it returns");
            }
            (SidecarPhase::Ready, None) => {}
        }
    }

    fn spawn_blocking(&self, task: Box<dyn FnOnce() + Send + 'static>) {
        self.runtime.spawn_blocking(task);
    }
}

/// The production role (ADR 0040): supervise one sidecar on loopback
/// and proxy it at `bind`. The sidecar picks an ephemeral port and
/// reports it on its banner, so the proxy asks the supervisor for the
/// current address per RPC rather than capturing one at startup — a
/// restart re-binds a different port.
async fn run_proxy(args: ProxyArgs) -> Result<(), Box<dyn std::error::Error>> {
    let identity = args.identity()?;
    let from_env = std::env::var(TOKEN_ENV).ok();
    // The token is enforced exactly when TLS is (ADR 0041): presenting
    // a bearer token on a plaintext channel hands it to the path, so an
    // endpoint that cannot protect it does not ask for it.
    let token = if identity.is_some() {
        Some(args.access_token(&identity::default_identity_dir()?, from_env.as_deref())?)
    } else {
        None
    };
    let token_was_supplied = args.token_was_supplied(from_env.as_deref());
    guard_bind(
        args.bind,
        Protections {
            tls: identity.is_some(),
            token: token.is_some(),
        },
        args.insecure,
    )?;

    // Convenience only (ADR 0040): a failed advertisement is a
    // warning, not a startup refusal — the manual `host:port` field
    // still reaches this server either way.
    let mdns = if args.no_mdns {
        None
    } else {
        let name = discovery::advertised_name(args.name.as_deref())?;
        let version = build_version();
        match discovery::Advertisement::register(&name, args.bind, version) {
            Ok(advertisement) => {
                eprintln!(
                    "hardware proxy: advertising \"{name}\" ({version}) via mDNS (_cannet._tcp)"
                );
                Some(advertisement)
            }
            Err(e) => {
                eprintln!(
                    "hardware proxy: warning: mDNS advertisement failed: {e}; \
                     continuing without it (--no-mdns silences this warning)"
                );
                None
            }
        }
    };

    let supervisor = Arc::new(SidecarSupervisor::default());
    let host: Arc<dyn SidecarHost> = Arc::new(CliSidecarHost {
        log_level: args.sidecar_log_level,
        restart_budget: args.sidecar_restart_budget,
        runtime: tokio::runtime::Handle::current(),
    });
    supervisor.spawn(&host);

    let mut builder = Server::builder();
    if let Some(identity) = &identity {
        builder = builder.tls_config(identity.tls_config())?;
        // Straight to stderr, never through `tracing`: these are the
        // strings the operator reads off the console and carries to the
        // client, so they must not be filterable by a log level — and
        // the token in particular must not reach a log file at all.
        eprintln!(
            "hardware proxy: certificate fingerprint {}",
            identity.fingerprint()
        );
    }
    if let Some(token) = &token {
        eprintln!("hardware proxy: client token {}", token.as_str());
    } else if token_was_supplied {
        // Saying nothing here would let an operator believe they had
        // configured authentication when the endpoint cannot carry it.
        eprintln!(
            "hardware proxy: warning: the token given is not enforced on a plaintext \
             endpoint, because a bearer token must not ride an unencrypted channel. \
             Add --tls (or --cert with --key)."
        );
    }
    eprintln!(
        "hardware proxy: listening on {} ({})",
        args.bind,
        if identity.is_some() {
            "tls"
        } else {
            "plaintext"
        }
    );

    let upstream = Arc::clone(&supervisor);
    let service = ProxyServerImpl::new(move || upstream.status().address).into_service();
    // A server-wide layer rather than a per-service interceptor: every
    // RPC this endpoint answers is gated by construction, including any
    // service added later.
    let serve = builder
        .layer(tonic::service::interceptor(auth::token_gate(token)))
        .add_service(service)
        .serve(args.bind);

    // Ctrl-C is the graceful path: it races the server future so a
    // held connection can't block the goodbye. Whichever way this
    // exits, the mDNS shutdown below waits for the goodbye packet to
    // reach the wire before the process does (see `Advertisement::
    // shutdown`) — a bare `shutdown()` with no wait can lose it.
    let outcome = tokio::select! {
        result = serve => Some(result),
        _ = tokio::signal::ctrl_c() => {
            eprintln!("hardware proxy: shutting down");
            None
        }
    };
    if let Some(advertisement) = mdns {
        advertisement.shutdown().await;
    }
    if let Some(result) = outcome {
        result?;
    }
    Ok(())
}

/// Print the error the way it was written to read and exit non-zero.
///
/// Returning `Result` from `main` renders the error with `Debug`, so
/// the bind guard's carefully worded sentence reached the operator as
/// `UnprotectedBind { bind: 0.0.0.0:50051, missing: [...] }`. The
/// operator gets the `Display` form; nothing else changes.
#[tokio::main]
async fn main() -> std::process::ExitCode {
    match run().await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{}", fatal_message(e.as_ref()));
            std::process::ExitCode::FAILURE
        }
    }
}

/// The line a fatal startup error is printed on. `Display`, never
/// `Debug` — the whole point of the bind guard's sentence is that the
/// operator can read it.
fn fatal_message(error: &(dyn std::error::Error + 'static)) -> String {
    format!("error: {error}")
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    // Before any TLS configuration is built: rustls picks its crypto
    // backend from the process default, and we name ours rather than
    // let the dependency graph decide.
    install_crypto_provider();
    let cli = Cli::parse();
    match cli.command {
        Some(Command::Debug(DebugCommand::Replay {
            blf,
            bind,
            rate,
            insecure,
        })) => run_replay(blf, bind, rate, insecure).await,
        Some(Command::Debug(DebugCommand::Vbus {
            bind,
            speed_bps,
            fd_data_speed_bps,
            insecure,
        })) => run_vbus(bind, speed_bps, fd_data_speed_bps, insecure).await,
        None => run_proxy(cli.proxy).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_invocation_is_the_proxy_with_a_loopback_default() {
        // Loopback by default: exposing the hardware to the network is
        // an explicit `--bind`, never something a bare launch does.
        let cli = Cli::try_parse_from(["cannet-server"]).expect("bare invocation should parse");
        assert!(cli.command.is_none());
        assert_eq!(
            cli.proxy.bind,
            "127.0.0.1:50051".parse::<SocketAddr>().unwrap()
        );
        assert_eq!(cli.proxy.sidecar_log_level, "info");
        assert_eq!(cli.proxy.sidecar_restart_budget, 3);
        // Plaintext by default: a loopback endpoint is the dev and
        // local-GUI path (ADR 0041).
        assert!(!cli.proxy.tls);
        assert!(cli.proxy.identity().unwrap().is_none());
        assert!(cli.proxy.token.is_none());
    }

    #[test]
    fn a_token_on_the_command_line_is_used_and_persisted_nowhere() {
        let dir = tempfile::tempdir().unwrap();
        let cli = Cli::try_parse_from(["cannet-server", "--tls", "--token", "operator-chosen"])
            .expect("--token should parse");
        let token = cli.proxy.access_token(dir.path(), None).unwrap();
        assert_eq!(token.as_str(), "operator-chosen");
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            0,
            "an operator's own token is theirs to keep; the server writes nothing"
        );
    }

    #[test]
    fn the_environment_carries_a_token_when_the_flag_does_not() {
        // The non-persisting path for operators who would rather not
        // put a secret in argv, where every process lister can read it.
        let dir = tempfile::tempdir().unwrap();
        let cli = Cli::try_parse_from(["cannet-server", "--tls"]).unwrap();
        let token = cli
            .proxy
            .access_token(dir.path(), Some("from-the-environment"))
            .unwrap();
        assert_eq!(token.as_str(), "from-the-environment");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn the_flag_wins_over_the_environment() {
        let dir = tempfile::tempdir().unwrap();
        let cli =
            Cli::try_parse_from(["cannet-server", "--tls", "--token", "from-the-flag"]).unwrap();
        let token = cli
            .proxy
            .access_token(dir.path(), Some("from-the-environment"))
            .unwrap();
        assert_eq!(token.as_str(), "from-the-flag");
    }

    #[test]
    fn without_either_the_persisted_token_is_reloaded() {
        // The default flow: the token is minted once and reprinted on
        // every later start, so a client that stored it keeps working.
        let dir = tempfile::tempdir().unwrap();
        let cli = Cli::try_parse_from(["cannet-server", "--tls"]).unwrap();
        let first = cli.proxy.access_token(dir.path(), None).unwrap();
        let second = cli.proxy.access_token(dir.path(), None).unwrap();
        assert_eq!(first.as_str(), second.as_str());
        assert_eq!(first.as_str().len(), 43);
    }

    #[test]
    fn cert_and_key_come_as_a_pair() {
        Cli::try_parse_from(["cannet-server", "--cert", "server.pem"])
            .expect_err("--cert without --key should not parse");
        Cli::try_parse_from(["cannet-server", "--key", "server.key"])
            .expect_err("--key without --cert should not parse");
        Cli::try_parse_from([
            "cannet-server",
            "--cert",
            "server.pem",
            "--key",
            "server.key",
        ])
        .expect("--cert with --key should parse");
    }

    #[test]
    fn operator_material_is_served_instead_of_the_generated_identity() {
        // Stand-in for an operator's PEM files: material generated
        // somewhere other than the per-user data directory, named on
        // the command line.
        let dir = tempfile::tempdir().unwrap();
        let generated = ServerIdentity::load_or_generate(dir.path()).unwrap();
        let cli = Cli::try_parse_from([
            "cannet-server",
            "--cert",
            dir.path().join("server-cert.pem").to_str().unwrap(),
            "--key",
            dir.path().join("server-key.pem").to_str().unwrap(),
        ])
        .expect("--cert/--key should parse");
        let identity = cli
            .proxy
            .identity()
            .unwrap()
            .expect("operator material means TLS, with or without --tls");
        assert_eq!(identity.fingerprint(), generated.fingerprint());
    }

    #[test]
    fn the_proxy_accepts_bind_and_the_sidecar_options() {
        let cli = Cli::try_parse_from([
            "cannet-server",
            "--bind",
            "0.0.0.0:9000",
            "--sidecar-log-level",
            "debug",
            "--sidecar-restart-budget",
            "10",
        ])
        .expect("the proxy's flags should parse");
        assert!(cli.command.is_none());
        assert_eq!(
            cli.proxy.bind,
            "0.0.0.0:9000".parse::<SocketAddr>().unwrap()
        );
        assert_eq!(cli.proxy.sidecar_log_level, "debug");
        assert_eq!(cli.proxy.sidecar_restart_budget, 10);
    }

    #[test]
    fn no_name_and_no_no_mdns_is_the_default() {
        // Bare invocation: no instance name override, advertisement on.
        let cli = Cli::try_parse_from(["cannet-server"]).unwrap();
        assert!(cli.proxy.name.is_none());
        assert!(!cli.proxy.no_mdns);
    }

    #[test]
    fn name_and_no_mdns_parse() {
        let cli = Cli::try_parse_from(["cannet-server", "--name", "bench-rig-3"]).unwrap();
        assert_eq!(cli.proxy.name.as_deref(), Some("bench-rig-3"));
        assert!(!cli.proxy.no_mdns);

        let cli = Cli::try_parse_from(["cannet-server", "--no-mdns"]).unwrap();
        assert!(cli.proxy.name.is_none());
        assert!(cli.proxy.no_mdns);
    }

    #[test]
    fn a_frozen_launcher_beside_the_binary_is_found() {
        // The distribution archive's layout: the onedir unpacks next to
        // the server binary, under the name the freeze script emits.
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            frozen_launcher_in(dir.path()),
            None,
            "an unpacked-from-source tree has no frozen sidecar"
        );

        let onedir = dir.path().join(FROZEN_SIDECAR_DIR);
        std::fs::create_dir(&onedir).unwrap();
        let launcher = onedir.join(cannet_sidecar::frozen_launcher_name());
        std::fs::write(&launcher, b"").unwrap();
        assert_eq!(frozen_launcher_in(dir.path()), Some(launcher));
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn debug_replay_parses_positional_blf_with_defaults() {
        let cli = Cli::try_parse_from(["cannet-server", "debug", "replay", "capture.blf"])
            .expect("debug replay <blf> should parse");
        let Some(Command::Debug(DebugCommand::Replay {
            blf,
            bind,
            rate,
            insecure: _,
        })) = cli.command
        else {
            panic!("expected Debug(Replay), got {:?}", cli.command);
        };
        assert_eq!(blf, PathBuf::from("capture.blf"));
        assert_eq!(bind, "127.0.0.1:50051".parse::<SocketAddr>().unwrap());
        assert_eq!(rate, 0.0);
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn debug_replay_accepts_bind_and_rate() {
        let cli = Cli::try_parse_from([
            "cannet-server",
            "debug",
            "replay",
            "capture.blf",
            "--bind",
            "0.0.0.0:9000",
            "--rate",
            "1.5",
        ])
        .expect("debug replay with flags should parse");
        let Some(Command::Debug(DebugCommand::Replay {
            blf,
            bind,
            rate,
            insecure: _,
        })) = cli.command
        else {
            panic!("expected Debug(Replay), got {:?}", cli.command);
        };
        assert_eq!(blf, PathBuf::from("capture.blf"));
        assert_eq!(bind, "0.0.0.0:9000".parse::<SocketAddr>().unwrap());
        assert_eq!(rate, 1.5);
    }

    #[test]
    fn debug_replay_requires_a_blf_path() {
        Cli::try_parse_from(["cannet-server", "debug", "replay"])
            .expect_err("debug replay with no BLF path should fail to parse");
    }

    #[test]
    fn debug_vbus_parses_with_defaults() {
        let cli = Cli::try_parse_from(["cannet-server", "debug", "vbus"])
            .expect("debug vbus should parse");
        let Some(Command::Debug(DebugCommand::Vbus {
            bind,
            speed_bps,
            fd_data_speed_bps,
            insecure: _,
        })) = cli.command
        else {
            panic!("expected Debug(Vbus), got {:?}", cli.command);
        };
        assert_eq!(bind, "127.0.0.1:50051".parse::<SocketAddr>().unwrap());
        assert_eq!(speed_bps, 500_000);
        assert_eq!(fd_data_speed_bps, 0);
    }

    #[test]
    fn debug_vbus_accepts_speed_and_fd_data_speed() {
        let cli = Cli::try_parse_from([
            "cannet-server",
            "debug",
            "vbus",
            "--speed-bps",
            "250000",
            "--fd-data-speed-bps",
            "2000000",
        ])
        .expect("debug vbus with flags should parse");
        let Some(Command::Debug(DebugCommand::Vbus {
            bind: _,
            speed_bps,
            fd_data_speed_bps,
            insecure: _,
        })) = cli.command
        else {
            panic!("expected Debug(Vbus), got {:?}", cli.command);
        };
        assert_eq!(speed_bps, 250_000);
        assert_eq!(fd_data_speed_bps, 2_000_000);
    }

    fn addr(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    #[test]
    fn an_unprotected_loopback_bind_is_allowed() {
        // The operator's own machine: plaintext there is the dev flow
        // and the GUI's local path, and no one else can reach it.
        for loopback in ["127.0.0.1:50051", "127.0.0.53:50051", "[::1]:50051"] {
            guard_bind(addr(loopback), Protections::default(), false)
                .unwrap_or_else(|e| panic!("{loopback} should be allowed unprotected: {e}"));
        }
    }

    #[test]
    fn an_ipv4_mapped_loopback_bind_is_loopback() {
        // `Ipv6Addr::is_loopback` is false for `::ffff:127.0.0.1`, so
        // the guard has to unwrap the mapping itself — otherwise this
        // spelling of localhost would be refused.
        guard_bind(
            addr("[::ffff:127.0.0.1]:50051"),
            Protections::default(),
            false,
        )
        .expect("an IPv4-mapped loopback address is still loopback");
    }

    #[test]
    fn an_unprotected_routable_bind_is_refused_and_names_the_escape_hatch() {
        let err = guard_bind(addr("0.0.0.0:50051"), Protections::default(), false)
            .expect_err("an unprotected routable bind must be refused");
        let message = err.to_string();
        assert!(message.contains("0.0.0.0:50051"), "{message}");
        assert!(message.contains("TLS"), "{message}");
        assert!(
            message.contains("--insecure"),
            "the refusal must name the flag that overrides it: {message}"
        );
    }

    #[test]
    fn a_refusal_reaches_the_operator_as_the_sentence_it_was_written_as() {
        // Returning `Result` from `main` renders the error with `Debug`,
        // so the refusal used to arrive as
        // `UnprotectedBind { bind: .., missing: [..] }`.
        let err = guard_bind(addr("0.0.0.0:50051"), Protections::default(), false)
            .expect_err("an unprotected routable bind must be refused");
        let printed = fatal_message(&err);
        assert!(printed.contains("refusing to bind"), "{printed}");
        assert!(
            !printed.contains("UnprotectedBind {"),
            "the operator must not be shown the struct: {printed}"
        );
    }

    #[test]
    fn a_protected_routable_bind_is_allowed() {
        let protected = Protections {
            tls: true,
            token: true,
        };
        guard_bind(addr("0.0.0.0:50051"), protected, false)
            .expect("TLS and a token are what make a routable bind acceptable");
        guard_bind(addr("[2001:db8::1]:50051"), protected, false).expect("the same holds for IPv6");
    }

    #[test]
    fn an_encrypted_but_unauthenticated_routable_bind_is_still_refused() {
        // Encryption alone protects the traffic, not the hardware: ADR
        // 0041's primary risk is an unauthorized *connection*, so a
        // routable endpoint anyone may open a session on is refused
        // even with TLS on it.
        let err = guard_bind(
            addr("0.0.0.0:50051"),
            Protections {
                tls: true,
                token: false,
            },
            false,
        )
        .expect_err("TLS without client authentication is not enough");
        let message = err.to_string();
        assert!(message.contains("client authentication"), "{message}");
        assert!(
            !message.contains("TLS"),
            "TLS is not what is missing: {message}"
        );
    }

    #[test]
    fn insecure_allows_an_unprotected_routable_bind() {
        guard_bind(addr("0.0.0.0:50051"), Protections::default(), true)
            .expect("--insecure is the operator saying it out loud");
    }

    #[test]
    fn insecure_does_not_turn_off_configured_tls() {
        // `--insecure` suppresses the refusal; it is not a way to
        // disable TLS the operator asked for.
        let dir = tempfile::tempdir().unwrap();
        let generated = ServerIdentity::load_or_generate(dir.path()).unwrap();
        let cli = Cli::try_parse_from([
            "cannet-server",
            "--insecure",
            "--bind",
            "0.0.0.0:50051",
            "--cert",
            dir.path().join("server-cert.pem").to_str().unwrap(),
            "--key",
            dir.path().join("server-key.pem").to_str().unwrap(),
        ])
        .expect("--insecure alongside --cert/--key should parse");
        let identity = cli
            .proxy
            .identity()
            .unwrap()
            .expect("--insecure must not discard configured TLS material");
        assert_eq!(identity.fingerprint(), generated.fingerprint());
    }

    #[test]
    fn the_debug_modes_take_insecure_too() {
        // Dev/test tooling takes no certificate, so the only way it
        // leaves loopback is the explicit flag — the same guard, the
        // same escape hatch.
        let cli = Cli::try_parse_from([
            "cannet-server",
            "debug",
            "vbus",
            "--bind",
            "0.0.0.0:9000",
            "--insecure",
        ])
        .expect("debug vbus should take --insecure");
        let Some(Command::Debug(DebugCommand::Vbus { insecure, .. })) = cli.command else {
            panic!("expected Debug(Vbus), got {:?}", cli.command);
        };
        assert!(insecure);

        let cli = Cli::try_parse_from([
            "cannet-server",
            "debug",
            "replay",
            "capture.blf",
            "--bind",
            "0.0.0.0:9000",
            "--insecure",
        ])
        .expect("debug replay should take --insecure");
        let Some(Command::Debug(DebugCommand::Replay { insecure, .. })) = cli.command else {
            panic!("expected Debug(Replay), got {:?}", cli.command);
        };
        assert!(insecure);
    }

    #[test]
    fn old_top_level_virtual_bus_flag_no_longer_parses() {
        Cli::try_parse_from(["cannet-server", "--virtual-bus"])
            .expect_err("--virtual-bus is no longer a top-level flag; it is `debug vbus`");
    }

    #[test]
    fn old_top_level_positional_blf_no_longer_parses() {
        Cli::try_parse_from(["cannet-server", "capture.blf"])
            .expect_err("a bare positional BLF path is no longer accepted; it is `debug replay`");
    }
}
