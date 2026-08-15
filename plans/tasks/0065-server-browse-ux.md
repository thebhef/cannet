# Task 65 — Server Browse & Trust UX Round

Owner feedback from first live use of the Task 42/43 surfaces
(2026-08-12). The mechanics shipped and work; the surfacing is wrong.

## Owner feedback (verbatim intent)

- **Server browse gets its own panel** (singleton, like the keyboard
  shortcuts panel), instead of living inside the per-bus
  "+ Add server…" inline form. **Server selection/auth is user-level
  config**, not a project-bus detail. Once a server is selected and
  authenticated (TOFU accept + token), it **appears in the project
  view** — the per-bus binding flow then draws on the user-level
  trusted set rather than raw discovery.
- **The server's host name must appear in the browse list.** DNS-SD
  carries it (the SRV record's target host, independent of the
  `--name` instance name) — surface it; only if it turns out not to
  be reliably available do we add a TXT key for it.

## Also folded in (2026-08-12 session findings)

- **Windows: browse via the native DNS-SD API** (`DnsServiceBrowse`)
  so the OS resolver owns the 5353 socket and the GUI needs **no
  per-app inbound firewall rules** (the userland `mdns-sd` socket
  makes Windows mint UDP+TCP rule pairs per binary path). Keep
  `mdns-sd` for the server's register side and for macOS/Linux
  browse unless grooming decides otherwise.
- **macOS: local-network privacy prompt** — a Mac GUI build will
  trigger the "find devices on your local network" permission;
  denial silently empties browse. README note + graceful UX.
- **Deny-path legibility**: an empty browse list must be
  distinguishable from "discovery blocked" (firewall deny / macOS
  permission deny / browse task failed to bind).

## Grooming needed before implementation

- Panel content and split: discovered (live, ephemeral) vs trusted
  (persisted `servers.json`) — one list with state, or two sections?
  (The trusted-servers list from Task 42 phase 4 presumably merges
  into this panel.)
- What "present in project view" renders as, and how a project
  references a user-level server entry (by host:port key?).
- Whether the per-bus AddServerInline discovery list stays as a
  shortcut or is removed in favor of the panel.

## Exit criteria (draft — firm up at grooming)

- A singleton server panel lists discovered + trusted servers with
  instance name, host name, `host:port`, version, and trust state;
  fuzzy search retained.
- TOFU accept / token entry / forget flow from the panel;
  selected+auth'd servers visible in the project view and bindable
  from the per-bus flow.
- Windows GUI browse produces no per-app firewall rules (native
  DNS-SD backend), verified on this machine.
- README covers the macOS permission and Windows firewall realities
  for both GUI and server.
- Blocked discovery states are visible in the panel, not silent.
