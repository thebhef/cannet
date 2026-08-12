# Task 43 — Server Discovery

Make cannet servers discoverable on the local network per
[ADR 0040](../../docs/adr/0040-production-cannet-server.md): the
server advertises `_cannet._tcp` via mDNS/DNS-SD; the GUI browses and
offers a fuzzy-searchable server list beside the manual `host:port`
field, which remains the path to servers beyond the local subnet.

**Blocking prerequisite**: evaluate-dependency pass for the Rust
mDNS/DNS-SD crate (candidates: `mdns-sd`, `libmdns`; must cover both
register and browse, or pick one per side) → entry in
`technology-inventory.md` before code.

## Decisions

- **Server advertises** instance name (`--name`, default hostname);
  TXT carries exactly one key, `ver=<release version>` (the vergen
  stamp). `--no-mdns` disables advertisement.
- **GUI browses** in the Tauri host (browse task pushes updates to
  the frontend by event — thin-view rule; no polling in JS), and the
  connect UI lists live servers (name, host:port, labels) with
  fzf-style fuzzy search over the list.
- **Discovery is convenience only** (ADR 0040): no security role;
  the connection layer (Task 42) is the boundary. Selecting a
  discovered server feeds the same connect path as a typed address.
- **No DNS-SD subtypes** — client-side filtering over names/labels
  covers the need (ADR 0040 rejected alternative).

## Grooming notes

- **2026-08-12 — no labels; TXT is one key (owner).** One server per
  host means the instance name already identifies it; `--label` was
  speculative surface and is dropped, as is a protocol-version key
  (the gRPC connect is the compatibility check, until a second
  protocol version exists). TXT still ships — RFC 6763 §6.1 wants a
  TXT record even when empty, and one key earns its place for
  network maintainers: `ver=<release version>` (the vergen stamp,
  zero config) makes fleet inventory answerable from `avahi-browse`
  without connecting. Revises ADR 0040's discovery bullet ("TXT
  metadata: protocol version, optional labels") — amend the ADR in
  the commit that implements this.
- Fuzzy search accordingly runs over instance names (+ host:port),
  not labels.
- **2026-08-12 — gone servers drop immediately (owner).** Either
  removal signal (goodbye packet or TTL expiry) removes the entry
  from the browse list; a re-announce re-adds it. No greyed-out
  linger state — the manual `host:port` field covers reaching a
  server that isn't currently advertising.
- **2026-08-12 — v4/v6 dedupe: key by instance name.** One list
  entry per DNS-SD instance name regardless of address family; the
  entry is live while any announcement for it is live.

## Open

- Crate choice (the evaluate-dependency pass); note `libmdns` is
  register-only, so browse needs `mdns-sd` or a second crate.

## Non-goals

- Cross-subnet / wide-area discovery, mDNS repeaters/gateways.
- Advertising the GUI's local sidecar or in-process vbuses.
- Access control via discovery visibility.

## Exit criteria

- Evaluate-dependency pass done; `technology-inventory.md` records
  the chosen crate as `adopted` (and alternatives as `rejected`).
- A running server appears in the GUI's browse list with its name
  and version; selecting it connects (through the Task 42 flow);
  fuzzy search filters the list.
- `--no-mdns` server absent from browse but connectable manually.
- Server shutdown removes it from the list (goodbye packet honored).
- Integration coverage where CI permits multicast; unit coverage for
  the browse-list state machine regardless.
- `plans/features.md` "Discoverable on the network" checked; README
  documents `--name` / `--no-mdns`.
