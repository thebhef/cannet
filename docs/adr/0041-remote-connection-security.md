# ADR 0041 — Remote connection security: TLS with a pinned server identity, bearer-token client auth

Status: accepted (2026-08-02)

## Threat model

A cannet server exposes *control of a physical CAN bus* — an
unauthorized client can transmit and actuate hardware. The primary
risk is therefore unauthorized **connection**, the secondary risk
eavesdropping on bus traffic. Authentication outranks encryption;
TLS supplies both.

## Decision

Applies to the production cannet server's public endpoint
([ADR 0040](0040-production-cannet-server.md)). The wire itself is
unchanged ([ADR 0004](0004-grpc-wire-protocol.md)); this layers
transport security under it via tonic's `tls` feature (rustls).

- **Server identity: self-signed, auto-generated.** On first run the
  server generates a keypair + self-signed certificate and persists
  it in its data directory. Operators with real certificates can
  supply `--cert` / `--key`; no CA or PKI is required.
- **Client trust: trust-on-first-use.** On first connect the GUI
  shows the server's certificate fingerprint; on acceptance it pins
  the fingerprint per server. A later fingerprint change is a hard
  warning — the connection is refused until the user explicitly
  re-accepts. The SSH model: defeats passive sniffing always, and
  active MITM after first contact.
- **Client auth: bearer token.** The server generates a token and
  prints it at startup (or takes `--token`). Clients present it in
  gRPC metadata on every call; a missing or wrong token is rejected
  before any `Session` opens. The GUI keeps the token with the
  server's connection entry.
- **Defaults enforce protection where it matters.** Binding to a
  non-loopback address without TLS + token configured is a startup
  error unless the operator passes an explicit `--insecure`.
  Loopback binds stay plaintext by default (dev ergonomics, and the
  sidecar link).

  *Amended 2026-08-14:* the startup error is gone. A non-loopback bind
  now auto-enables TLS (the generated identity, or operator-supplied
  `--cert`/`--key`) and the bearer token with no flag required.
  `--tls` had nothing left to opt into and is removed; `--insecure`
  suppressed a refusal that no longer exists and is removed with it.
  `--no-tls` is the single remaining escape hatch, for an operator who
  wants the endpoint served in the clear anyway. Loopback stays
  plaintext by default, unchanged.
- **TLS terminates at the server's public endpoint.** Supervised
  sidecars remain loopback-plaintext — a payoff of the single-endpoint
  proxy (ADR 0040). The GUI's local fast path is untouched.

## Why

**TOFU over a CA requirement.** Requiring operators to provision
CA-signed certificates for a bench tool is adoption friction that
ends in copy-pasted `--insecure`. TOFU gives real protection with
zero setup, and the `--cert`/`--key` escape hatch serves
organizations that do run a PKI.

**Bearer token over mTLS.** Client certificates protect against the
same adversary as the token but add keypair provisioning and
distribution per client. One shared secret, printed where the
operator launched the server, matches the trust boundary: whoever
can read the server's console is authorized to use its buses.

**Secure-by-default on non-loopback binds.** The dangerous
configuration should be the loud, explicit one. `--insecure` exists
because trusted-network deployments are real, but it is a flag the
operator types, not a default they forget.

*Amended 2026-08-14:* pushed further — the safe configuration is now
also the unconfigured one. A non-loopback bind auto-enables TLS and a
token with no flags; `--no-tls` is what the operator types to serve
the hardware unprotected, replacing `--insecure`.

## Rejected alternatives

- **mTLS / client certificates.** Configuration burden
  disproportionate to the added protection over token-over-TLS.
- **Require operator-provisioned (CA) certificates.** Friction that
  breeds insecure workarounds; kept as an option, not a requirement.
- **Plaintext plus "trust the LAN".** The LAN a bench sits on is
  rarely a security boundary; and mDNS advertisement (ADR 0040)
  actively publicizes the endpoint.
- **User accounts / authorization tiers.** One token grants full
  access; per-user identity and roles have no current use case.
