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

## Non-goals

- mTLS / client certificates, CA/PKI requirement, user accounts or
  authorization tiers (ADR 0041 rejected alternatives).
- Securing the Task 28 value-source link (separate service; adopt
  the same scheme later if needed).
- Account-associated tunneling.

## Exit criteria

- Server refuses a non-loopback bind without TLS + token unless
  `--insecure`; loopback behavior unchanged.
- Integration tests: TLS handshake succeeds against the self-signed
  cert; wrong/missing token rejected before `Session`; correct token
  end-to-end frames flow.
- GUI TOFU flow: fingerprint shown on first connect, pinned,
  mismatch refused with re-accept path; token entry stored per
  server (host-side, per ADR 0032).
- `technology-inventory.md` entries for rustls-via-tonic and `rcgen`
  move `proposed` → `adopted` (or record the alternative chosen).
- README covers launching a protected server and connecting the GUI,
  including `--insecure` and its tradeoff.
