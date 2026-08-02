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

## Open

- Token format/length and whether it's persisted server-side across
  restarts or regenerated (lean: persist beside the cert so the
  printed token stays valid).
- Cert lifetime / regeneration story (self-signed + pinning makes
  expiry mostly moot; decide what the client does with an expired
  pinned cert).
- Fingerprint presentation format (SHA-256, grouped hex vs words).
- Whether `cannet-client`'s API takes a connection-config struct
  (addr + TLS + token) — likely yes; today it takes a bare address
  string at three call sites.

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
