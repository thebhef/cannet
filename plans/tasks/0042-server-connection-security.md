# Task 42 — Server Connection Security

Protect the production cannet server's endpoint per
[ADR 0041](../../docs/adr/0041-remote-connection-security.md): TLS
(rustls via tonic's `tls` feature) with an auto-generated self-signed
server certificate, trust-on-first-use fingerprint pinning in the GUI,
and bearer-token client auth. Binding non-loopback without TLS + token
becomes a startup error unless `--insecure`.

## Decisions

- **Server identity**: keypair + self-signed cert generated on first
  run, persisted in the server's data dir; `--cert` / `--key` accept
  operator-provided material. Generation via `rcgen` (proposed —
  technology-inventory).
- **Client trust**: GUI shows the fingerprint on first connect, pins
  it per server; a changed fingerprint refuses the connection with a
  hard warning until explicitly re-accepted.
- **Client auth**: bearer token in gRPC metadata on every RPC;
  server generates and prints one at startup or takes `--token`.
  Checked before any `Session` opens.
- **Scope**: TLS terminates at the server's public endpoint;
  supervised sidecars stay loopback-plaintext; GUI local fast path
  untouched. Loopback binds stay plaintext by default.
- Pins and tokens are machine-local UI state, host-side
  ([ADR 0032](../../docs/adr/0032-machine-local-ui-state-host-side.md))
  — not project-file content.

## Grooming notes

- **2026-08-11 — token pinned (owner).** Standard opaque-API-key
  shape, no token library: 256-bit OS-CSPRNG value, base64url
  (RFC 4648 §5, 43 chars), presented as RFC 6750
  `authorization: Bearer` gRPC metadata checked by a tonic
  interceptor, constant-time compared (`subtle` or
  `ring::constant_time`). Generated on first run, persisted beside
  the cert, reprinted every startup (console readers are authorized
  by definition); `--token` overrides for the run without persisting;
  rotation = delete the token file. New direct deps
  (`getrandom`/`rand`, `base64`) go through `technology-inventory.md`.
- **2026-08-11 — cert lifetime: SSH model, no expiry path.** Cert
  generated with a far-future `notAfter` (rcgen default, year 4096);
  the GUI's pinning verifier checks fingerprint equality only and
  ignores validity dates — an expired pinned cert is a non-event by
  construction, with no client code path. Operator `--cert`/`--key`
  material goes through the same pin-only verifier. Standard for
  pin-based trust (SSH host keys); on the plan-review subagent's
  checklist.
- **2026-08-11 — fingerprint format: OpenSSH's.** `SHA256:` +
  unpadded base64 of the SHA-256 digest (43 chars) — the format the
  audience already eyeball-compares daily, half the length of
  colon-hex, self-labels the hash. Server prints it at startup beside
  the token; the GUI shows the identical string in the TOFU accept
  dialog and the pinned-server list.
- **2026-08-11 — `cannet-client` grows a connection-config struct**
  (codebase-confirmed): all three entry points (`list_interfaces`,
  `watch_interfaces`, `connect_and_subscribe`) take a bare `&str` and
  independently format `http://{address}` — TLS (pinned-fingerprint
  verifier), scheme, and bearer token need one shared
  `ConnectConfig`-style struct threaded through all three instead.
- **2026-08-11 — plan review gate (owner).** When this task's plan is
  ready, dispatch a review subagent to vet it for security best
  practices and proper application of the libraries and techniques
  relied on (rustls/tonic TLS, rcgen, token handling) before
  implementation starts.

## Plan review (2026-08-12 — the owner-mandated gate)

Verdict: **ready with corrections** — architecture sound, decisions
stand; the following bind the implementation phases. Workspace facts:
tonic 0.12.3, rustls not yet in the lock (tonic `tls` off today), so
this is a new subtree, not a feature flip.

Blockers (each silently wrong at runtime, not compile time):

- **B1 — one crypto provider.** rcgen 0.13 defaults to `aws-lc-rs`;
  tonic's `tls` pulls rustls+`ring`. Both in-tree ⇒ rustls panics at
  the first config builder. Pin `rcgen` with
  `default-features = false, features = ["crypto", "pem", "ring"]`
  **and** install the provider explicitly at startup
  (`rustls::crypto::ring::default_provider().install_default()`).
- **B2 — tonic 0.12 `ClientTlsConfig` cannot carry a custom
  verifier.** The pinning client must go through
  `Endpoint::connect_with_connector` over its own
  `rustls::ClientConfig` (hyper-rustls 0.27 or a small
  tower/tokio-rustls connector — spike decides before phase 3 commits
  to shape) and must set `alpn_protocols = [b"h2"]` itself. Server
  side stays `ServerTlsConfig` + `Identity::from_pem` (tonic sets
  ALPN there).
- **B3 — the pin verifier still verifies signatures.**
  `verify_server_cert` = SHA-256(end-entity DER) constant-time vs the
  pin, ignoring validity/server-name; but `verify_tls12_signature` /
  `verify_tls13_signature` **delegate to the provider's real
  verification** and `supported_verify_schemes` returns the
  provider's list — a blind-assertion verifier lets anyone with the
  (public) cert impersonate the server. Proven by the cert-A/key-B
  exit-criteria test below.

Should-fixes folded into the decisions:

- **One fail-closed verifier type, ever** (S4): unknown/mismatched pin
  aborts the handshake before any RPC; the observed fingerprint
  reaches the TOFU dialog via a side-channel, never via a
  trust-anything connect. No RPC and no token on an unpinned
  connection.
- **Auth gates every RPC** (S5): interceptor mounted as a server
  layer, not per-service; tests cover missing/wrong/wrong-scheme/
  non-ASCII/correct across all three RPCs.
- **Debug subcommands share the bind guard** (S6): one guard function
  at all three `--bind` sites; debug modes may decline TLS but then
  need `--insecure` to leave loopback.
- **`--insecure` suppresses the guard error only** (S7): it never
  disables TLS that is configured. Client side: a pinned server is
  never contacted over `http://`, and the token never rides a
  plaintext channel.
- **Secrets at rest** (S8): key+token files created `0o600` on Unix
  (at create, temp+rename), per-user data dir on Windows; GUI-side
  token store stays out of `settings.json` and logs — plaintext in
  the ADR 0032 host store is accepted and recorded.
- **`CANNET_TOKEN` env override** (S9) documented as the
  non-persisting path; `--token` stays but README notes argv
  visibility.
- **Token printing hygiene** (S10): direct `eprintln!` only, never
  `tracing`; token value never in any tracing event, `Status`, or
  error string; interceptor never echoes the presented value.
- **Fingerprint pinned down** (S11): SHA-256 over the **end-entity
  certificate DER** (first cert of a `--cert` chain), displayed as
  `SHA256:` + **standard**-alphabet unpadded base64 (OpenSSH's
  alphabet — distinct from the token's base64url); pin stored as raw
  32 bytes + display string.
- **Whole-cert pinning, renewal consequence documented**
  (S12, orchestrator call at gate disposition): SPKI pinning was
  considered and declined — it needs X.509 parsing (a new dep or
  hand-rolled DER) for a benefit that only materializes for
  `--cert` operators doing key-preserving renewal. README's
  `--cert` section states: renewing the cert changes the
  fingerprint and every client re-accepts.
- **Terminal auth errors in the GUI** (S13):
  `ConnectionError::Unauthenticated` and
  `ConnectionError::PinMismatch { expected, observed }` variants;
  both are terminal for the `interfaces.rs` watch-retry loop (no
  infinite hammering past a mismatch).

Checklist notes for phase prompts: `Bearer` scheme case-insensitive;
non-ASCII metadata ⇒ `unauthenticated`, no unwrap; compare the 43-char
string, not decoded bytes (non-canonical encodings) (N15); canonicalize
IPv4-mapped addresses before `is_loopback()` (N16); `ring` covers
CSPRNG/constant-time/SHA-256 so only `base64` becomes a new direct dep
(N17); the proxy's fresh `Request::new` per upstream call already
strips client `authorization` — keep it deliberate with a regression
test (N18); `ConnectConfig` touches 4 GUI call sites + 3 perf-harness
sites + client e2e tests, and gets a plaintext-loopback constructor so
those stay one-line (N19); when Task 43 lands, fingerprint/token never
go in mDNS TXT (N20); pins/tokens keyed by `host:port` — a moved
server re-prompts, accepted (N21).

## Non-goals

- mTLS / client certificates, CA/PKI requirement, user accounts or
  authorization tiers (ADR 0041 rejected alternatives).
- Securing the Task 28 value-source link (separate service; adopt
  the same scheme later if needed).
- Account-associated tunneling.

## Exit criteria

- Server refuses a non-loopback bind without TLS + token unless
  `--insecure`; the same guard covers `debug replay` / `debug vbus`;
  loopback behavior unchanged.
- Integration tests: TLS handshake succeeds against the self-signed
  cert; wrong/missing token rejected before `Session`; correct token
  end-to-end frames flow; auth enforced on all three RPCs (missing /
  wrong / wrong-scheme / non-ASCII / correct).
- **Verifier falsification test**: a server configured with cert A's
  chain but key B fails the pinned handshake against cert A's
  fingerprint — proving the verifier checks the handshake signature,
  not just the cert bytes.
- Regression test: the proxy forwards no `authorization` metadata
  upstream.
- GUI TOFU flow: fingerprint shown on first connect, pinned,
  mismatch refused with re-accept path; token entry stored per
  server (host-side, per ADR 0032).
- `technology-inventory.md` entries for rustls-via-tonic and `rcgen`
  move `proposed` → `adopted` (or record the alternative chosen).
- README covers launching a protected server and connecting the GUI,
  including `--insecure` and its tradeoff.
