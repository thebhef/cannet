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

## Status log

### 2026-08-12 — phase 1: server identity + TLS endpoint

Landed on `task42a-server-tls`, four commits off
`task41e-perf-proxy-comparison` (`29cd7b0`):

| commit | what |
|--------|------|
| `0756485` | docs(plans): the plan review + the task-41 criteria walk |
| `de20dc9` | feat(server): generate, persist, and fingerprint a TLS identity |
| `507059d` | feat(server): terminate TLS on the proxy's endpoint |
| `4da779a` | feat(server): refuse an unprotected routable bind |

`cannet-server` tests: 34 → 51 (lib 5 → 11, bin 9 → 19, new
`tests/tls.rs` 3; the pre-existing integration suites are unchanged).
`cannet-client` (7 + 5) and `cannet-gui` (503) still pass under the
new `tonic/tls` feature; `cannet-perf-measurement` is clippy-clean.

What shipped:

- `identity.rs` — `ServerIdentity` (generate/persist/reload,
  operator `--cert`/`--key` material) and `CertFingerprint` (SHA-256
  over the end-entity DER, `SHA256:` + unpadded standard-alphabet
  base64, pinned against an independently computed digest). Key file
  created `0o600` on Unix via `OpenOptions`, temp+rename for both
  files. Default dir `<data-local-dir>/cannet-server`.
- `install_crypto_provider()` — explicit `ring`, called first thing in
  `main` and by the TLS tests (B1).
- `ServerTlsConfig` on the proxy's endpoint; fingerprint printed with
  a direct `eprintln!`.
- `guard_bind` + a `Protections` struct at all three `--bind` sites,
  with IPv4-mapped-loopback canonicalization (N16) and an
  `--insecure` that suppresses the refusal only (S7).
- `tests/tls.rs` — real handshake: a tonic client holding the
  generated certificate as `ca_certificate` (`domain_name("localhost")`,
  matching a SAN) completes `ListInterfaces`; a client without it is
  refused; a plaintext client gets nowhere.

**Design call the plan did not specify — a `--tls` flag.** The plan
says both "the identity is auto-generated on first run" and "a
non-loopback bind without TLS is a startup error unless `--insecure`",
and S7 adds that `--insecure` suppresses the error only. Those are
only simultaneously true if TLS is something the operator turns on:
if a routable bind enabled TLS automatically, the refusal could never
fire for the proxy and S7 would have nothing to suppress. So TLS is on
when `--tls` (generated identity) or `--cert`/`--key` (operator
material) is given, and off otherwise; loopback stays plaintext by
default either way. Phase 2 should gate the token the same way rather
than auto-enabling it.

Dependency decisions recorded in `technology-inventory.md`: rcgen
0.14 (not 0.13 — the plan review named the then-current version) and
tonic `tls` move to `adopted`, plus three the plan review had not
enumerated — `ring` 0.17, `rustls-pemfile` 2 (end-entity DER out of
the PEM chain, rather than hand-rolled DER scanning), and `dirs` 6
(the per-user data dir; the headless server has no Tauri path API).
`base64` is pinned to 0.22, the version already in the lock, so the
build carries one major.

Not in this phase, per the plan: the token (phase 2), the pin-only
client verifier and the GUI TOFU flow (phase 3). The exit criteria
covering those are still open.

### 2026-08-12 — phase 2: bearer-token auth on the server

Landed on `task42b-token-auth`, five commits off `task42a-server-tls`
(`db8a90c`):

| commit | what |
|--------|------|
| `bc6e17f` | feat(server): mint, persist, and compare a bearer token |
| `c1a907b` | feat(server): gate an RPC on the presented bearer token |
| `0489568` | feat(server): enforce the bearer token on a TLS endpoint |
| `4fdcf35` | test(server): pin the gate across all three RPCs over TLS |
| `4f0f636` | test(server): pin that the proxy forwards no client credential |

`cannet-server` tests: 58 → 85 (lib 11 → 28, bin 19 → 24, new
`tests/auth.rs` 3, `tests/proxy.rs` 6 → 7, one doctest; one
pre-existing ignored sidecar test unchanged). No other crate is
touched — the client keeps its phase-3 slot.

What shipped:

- `auth.rs` — `AccessToken` (256-bit `ring::rand::SystemRandom`,
  unpadded base64url, 43 chars; `load_or_generate` persists
  `access-token` beside the certificate with the private key's hygiene,
  `from_value` for `--token`/`CANNET_TOKEN` persisting nothing,
  `matches` constant-time over the **encoded** ASCII). No `Debug`, no
  `Display` — `as_str` is the only render, so the value cannot reach a
  log or an error by accident.
- `token_gate(Option<AccessToken>)` — the interceptor, mounted in
  `run_proxy` as `Server::builder().layer(tonic::service::interceptor(..))`
  (S5). `authorization`, `Bearer` case-insensitively, non-ASCII ⇒
  `unauthenticated` with no unwrap, one generic message for every
  failure, presented value never echoed (S10, N15).
- `Protections` grew a `token` field; a routable bind now needs both,
  and the refusal names them separately so it never claims protection
  the endpoint lacks.
- Startup banner, direct `eprintln!` (S10), verified on a real launch:

  ```text
  hardware proxy: certificate fingerprint SHA256:4EMRWrqj5MtP7Lxx4DjdNGUhBPIUijAl4UZekXCJwAc
  hardware proxy: client token KMGqFEndqRji-y-f4Ej48LJZBu7Bjg2IfmRVMv-jHZE
  hardware proxy: listening on 127.0.0.1:0 (tls)
  ```

- README: the token line in the banner, `--token`, `CANNET_TOKEN` and
  the argv-visibility note (S9), rotation by deleting `access-token`,
  and why neither protection exists on a plaintext endpoint.

Two calls the plan did not settle:

- **`subtle` after all, not `ring::constant_time` (N17).** ring 0.17.14
  moved that module to `deprecated_constant_time` and deprecated
  `verify_slices_are_equal` as "internal, no promises regarding side
  channels" — the one promise a credential compare needs. The
  2026-08-11 grooming note named `subtle` as the other acceptable
  option and rustls already puts it in the lock, so this is a direct
  dependency on a crate that was already there, not a new tree edge.
  `technology-inventory.md` records it, and flips
  `getrandom`/`rand`/`sha2` to `rejected` as planned.
- **`--token` on a plaintext endpoint warns rather than errors.** The
  token is enforced exactly when TLS is (S7), so a token given to a
  plaintext server does nothing — and an operator who typed one
  believes otherwise. It prints a warning naming `--tls` rather than
  refusing to start, because refusing would make `CANNET_TOKEN` in a
  shell profile break every loopback dev run.

One thing noticed and not touched, from phase 1: `main` returns
`Box<dyn Error>`, so a refused bind reaches the operator as
`Error: UnprotectedBind { bind: 0.0.0.0:50051, missing: [...] }` — the
`Display` impl written for it is never used. Informative, but not the
sentence it was written to be.

### 2026-08-12 — phase 3: the pinned, authenticated client

Landed on `task42c-client-connect`, off `task42b-token-auth`
(`f254f1b`):

| commit | what |
|--------|------|
| `5b94dd9` | feat(client): pin a server certificate and carry a token on every RPC |

`cannet-client` tests: 12 → 27 (lib 5 → 12, `tests/end_to_end.rs` 7
unchanged, new `tests/protected.rs` 8). `cannet-server` (85),
`cannet-gui` (503) and `cannet-perf-measurement` unchanged and green,
clippy-clean across all four with the call-site changes.

**Spike outcome (B2): a hand-written connector, not `hyper-rustls`.**
`hyper-rustls` 0.27 is not in the lock; the tokio-rustls route needs
`rustls`, `tokio-rustls`, `hyper-util` and `tower`, all four already
there as tonic's own dependencies, and costs ~25 lines (connect a
`TcpStream`, wrap it, hand tonic a `TokioIo`). So the tree does not
grow at all, against one new crate for the alternative. Proven before
anything was built on it by
`tls::tests::a_pinned_client_completes_a_handshake_and_an_rpc`.

Two things the spike found that the plan could not have known:

- **The endpoint URI has to be `http://`, even though the connection
  is TLS.** With tonic's `tls` feature compiled in — and it is, by
  workspace feature unification with `cannet-server` — tonic wraps
  every connector in one of its own that intercepts an `https://` URI
  and fails with `HttpsUriWithoutTlsSupport` unless *tonic's* TLS
  config is set, which is the config that cannot hold the pin
  verifier. The scheme only reaches the wire as h2's `:scheme`
  pseudo-header. The first four TLS tests all failed on this, and the
  three negative ones were passing *vacuously* until the positive one
  worked — worth remembering when a security test's assertion is "this
  connection failed".
- `alpn_protocols = [b"h2"]` really is nobody else's job on that path,
  as the plan review said.

What shipped:

- `tls.rs` — `CertPin` (32 bytes; parses and displays the server's
  `SHA256:` + unpadded standard-base64 form, so a pin round-trips
  through a settings file as the same string the operator eyeballs),
  `PinVerifier`, and the connector. The verifier compares the
  end-entity DER's digest in constant time, ignores chain/validity/
  server name, and **delegates both signature hooks to the ring
  provider** with `supported_verify_schemes` from the same provider.
  It fails closed: mismatch — or nothing pinned yet — refuses the
  handshake and records a `PinObservation` (observed fingerprint plus
  the unknown-vs-mismatch discriminator) into an `Arc<Mutex<..>>` the
  dialer reads back, because by the time the failure surfaces there is
  nothing certificate-shaped left in it.
- `ConnectConfig` with four constructors — `plaintext`, `pinned`,
  `pinned_with_token`, `unpinned` — threaded through all three entry
  points and the session worker. S7's two rules are structural, not
  conventions: only `pinned_with_token` carries a credential and it
  always pins (so a token cannot be put on a plaintext channel at
  all), and a pinned config whose address spells `http://` is
  `InsecureScheme` before a socket is opened. The token rides a
  `BearerCredential` interceptor built once per connection, so no call
  site can forget it.
- `ConnectionError::PinMismatch { expected, observed }` and
  `::Unauthenticated` (S13), the latter from a `From<tonic::Status>`
  that every RPC path now goes through, so a rejection on the watch
  stream or mid-session is the same terminal variant. Plus
  `InsecureScheme` and `InvalidToken` for the two configuration
  errors. Retry-loop handling is phase 4, as planned.
- N19's call sites: 4 in the GUI host
  (`interfaces.rs` ×2, `session.rs` ×2, `local_buses.rs`), 4 in the
  perf harness (`grpc.rs` ×2, `hardware_peak.rs` ×2, `upstream.rs`),
  and `tests/end_to_end.rs` — all one-line `ConnectConfig::plaintext`,
  behaviour unchanged. The GUI frontend is untouched.
- `tests/protected.rs` — against a server in the production shape
  (`ServerTlsConfig` + the gate as a server-wide layer): pinned + token
  lists interfaces; all three RPCs carry the credential and frames
  round-trip between two sessions over the pinned channel; missing and
  wrong tokens are `Unauthenticated`; a stale pin is `PinMismatch`
  naming both fingerprints; a first contact is `PinMismatch` with
  `expected: None`; a pinned config on an `http://` address fails
  without dialling (the address points at a port nobody listens on, so
  a `Connect` error would prove it went to the network anyway).
- The falsification test (exit criterion),
  `tls::tests::a_certificate_presented_without_its_key_is_refused`:
  `ServerIdentity::from_pem(cert_a.cert_pem(), key_b.key_pem())` —
  rustls' `with_single_cert` does not check that a certificate and a
  key belong together, so the server starts and serves certificate A's
  chain while signing with B. The client pins A's fingerprint, the
  digest matches exactly, and the handshake must still die — at the
  `CertificateVerify` signature. The test asserts the verifier
  published *no* observation, which is what distinguishes "the
  signature failed" from "the pin failed".

Two calls the plan did not settle:

- **The plaintext constructor is `plaintext`, not
  `plaintext_loopback` (N19).** Every current call site is a loopback
  or in-process server, but `session.rs` and `local_buses.rs` pass
  whatever address the project file holds, which need not be loopback
  until phase 4 gives the GUI somewhere to put a pin and a token.
  Naming it for loopback would have been a claim the call sites cannot
  keep; the rustdoc says what it is — the unprotected path — and names
  loopback as where it belongs.
- **`ConnectConfig::unpinned` exists, and it always fails.** The plan
  specifies the verifier's no-pin mode and the unknown-vs-mismatch
  discriminator, which are only reachable if a config can ask for one.
  It is the trust-on-first-use probe phase 4's dialog needs: it gets
  as far as the server's certificate, refuses it, and returns the
  fingerprint to accept. No RPC and no credential can ride it, because
  the handshake never completes.

Not in this phase, per the plan: the GUI's TOFU dialog, the per-server
pin/token store (ADR 0032), and terminal handling in
`interfaces.rs`'s watch-retry loop.
