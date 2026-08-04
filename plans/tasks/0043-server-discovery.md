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

- **Server advertises** instance name (`--name`, default hostname) +
  TXT metadata: protocol version, optional free-form labels.
  `--no-mdns` disables advertisement.
- **GUI browses** in the Tauri host (browse task pushes updates to
  the frontend by event — thin-view rule; no polling in JS), and the
  connect UI lists live servers (name, host:port, labels) with
  fzf-style fuzzy search over the list.
- **Discovery is convenience only** (ADR 0040): no security role;
  the connection layer (Task 42) is the boundary. Selecting a
  discovered server feeds the same connect path as a typed address.
- **No DNS-SD subtypes** — client-side filtering over names/labels
  covers the need (ADR 0040 rejected alternative).

## Open

- Crate choice (the evaluate-dependency pass).
- Label configuration surface on the server (repeated `--label k=v`?).
- Whether discovered-but-gone servers linger greyed-out in the list
  or drop immediately (mDNS goodbye vs TTL expiry).
- IPv4/IPv6 duplicate-announcement handling in the browse list.

## Non-goals

- Cross-subnet / wide-area discovery, mDNS repeaters/gateways.
- Advertising the GUI's local sidecar or in-process vbuses.
- Access control via discovery visibility.

## Exit criteria

- Evaluate-dependency pass done; `technology-inventory.md` records
  the chosen crate as `adopted` (and alternatives as `rejected`).
- A running server appears in the GUI's browse list with its name
  and labels; selecting it connects (through the Task 42 flow);
  fuzzy search filters the list.
- `--no-mdns` server absent from browse but connectable manually.
- Server shutdown removes it from the list (goodbye packet honored).
- Integration coverage where CI permits multicast; unit coverage for
  the browse-list state machine regardless.
- `plans/features.md` "Discoverable on the network" checked; README
  documents `--name` / `--label` / `--no-mdns`.
