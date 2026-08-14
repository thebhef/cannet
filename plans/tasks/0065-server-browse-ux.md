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
- **The auto-generated token is "ridiculously long and difficult to
  transcribe across machines"** (owner, 2026-08-13). Replace the
  43-char base64url blob with an `xkpasswd`-style word passphrase —
  "generated-password-like-this". Generation-side only: `--token`
  stays free-form, the wire/trust store treat tokens as opaque
  strings, constant-time compare unchanged. Entropy note: the only
  attack is online guessing through the TLS endpoint (the stored
  token is plaintext at rest either way, so there is no offline
  crack surface); EFF-large-wordlist words carry ~12.9 bits each.

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

- ~~Passphrase token word count~~ — resolved 2026-08-13 (owner):
  **5 EFF-large words** (≈ 64.6 bits), lowercase, hyphen-separated;
  wordlist embedded in `cannet-server`, licensing noted in the
  technology inventory. The owner allowed adding special characters
  for extra entropy; recommendation recorded against it — the whole
  point is transcription ease, entropy is already ample, and
  symbols reintroduce the transcription pain. Plain hyphens only
  unless grooming reopens it.

- ~~Panel content and split~~ — resolved 2026-08-13 (owner):
  **one merged list** keyed by host:port, trust state as a per-row
  badge (trusted / new / fingerprint-changed), offline trusted
  servers greyed rather than hidden; fuzzy search filters the one
  list. The Task 42 trusted-servers list merges into this panel
  and its standalone surface retires.
- ~~What "present in project view" renders as~~ — resolved
  2026-08-13 (owner): in Connection Management, each trusted
  server becomes a **sibling of "Local interfaces"** — one
  collapsible element per server, **expanded only when an
  interface from that server is chosen**, collapsed otherwise.
  The project file stores only per-bus binding references
  (bus → host:port + remote interface id); no server config,
  token, or fingerprint is duplicated into the project — a
  project opened on a machine that hasn't trusted the server
  shows "unknown server — trust it in the server panel" on the
  affected buses. `servers.json` stays the single trust
  authority (ADR 0032).
- ~~Whether the per-bus AddServerInline stays~~ — resolved
  2026-08-13 (owner): **removed**. The binding combo offers
  interfaces from local + trusted-server sections; its only
  server affordance is a "Manage servers…" jump to the new
  server panel.

## Exit criteria (groomed 2026-08-13)

- A singleton server panel shows **one merged list** (discovered +
  trusted, keyed by host:port) with instance name, host name,
  `host:port`, version, and a trust-state badge; offline trusted
  servers greyed; fuzzy search retained; the Task 42 standalone
  trusted-servers list is retired into it.
- TOFU accept / token entry / forget flow from the panel; trusted
  servers appear in Connection Management as collapsible siblings
  of "Local interfaces" (expanded only while one of their
  interfaces is chosen) and are bindable from the per-bus flow;
  AddServerInline is removed, replaced by a "Manage servers…"
  jump to the panel; a project referencing an untrusted server
  says so legibly on the affected buses.
- Auto-generated tokens are 5-word EFF-large hyphenated
  passphrases; `--token` stays free-form; wire/trust store
  unchanged.
- Windows GUI browse produces no per-app firewall rules (native
  DNS-SD backend), verified on this machine.
- README covers the macOS permission and Windows firewall realities
  for both GUI and server.
- Blocked discovery states are visible in the panel, not silent.
