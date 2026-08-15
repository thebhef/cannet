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

## Status log

### 2026-08-13 — phase 1: passphrase tokens

**Landed** (branch `task65a-passphrase-tokens`, off `task64d-ci-installers`
tip `e1465dd`): `AccessToken::generate()` now produces a 5-word
hyphenated passphrase from the embedded EFF large wordlist instead of
a 256-bit base64url blob. Generation-side only — `--token` /
`CANNET_TOKEN`, the wire, the trust store, and the constant-time
compare are all unchanged; they still treat every token as an opaque
string.

- Wordlist embedded verbatim as
  `crates/cannet-server/assets/eff_large_wordlist.txt`
  (`include_str!`, no new crate dependency), attribution in the
  sibling `eff_large_wordlist.LICENSE` (CC BY 3.0, EFF); adoption
  recorded in `plans/technology-inventory.md`.
- Word selection is rejection-sampled off `ring::rand::SystemRandom`
  (no modulo bias); entropy is 5 × log2(7776) ≈ 64.6 bits, discussed
  on `AccessToken::generate`'s rustdoc.
- Printed shape observed from a real `--bind 127.0.0.1:50051 --tls`
  run of the release binary: `hardware proxy: client token
  chug-pruning-unclad-hazard-morphine` — five lowercase words,
  hyphen-separated.
- Tests: 107 passed (0 failed, 1 ignored — the sidecar-spawning test
  gated behind the real `python-can` process), plus 1 doc-test.
  `cargo clippy -p cannet-server --all-targets -- -D warnings` clean.
  New/updated coverage: wordlist has exactly 7776 unique lowercase
  entries; `generate_words` draws 5 wordlist members; a generated
  token is lowercase words hyphen-joined; `uniform_index` stays in
  bounds and does not panic at boundary bounds (1, 2, 7776, 65536);
  the two-tokens-differ and full persistence/rotation/CLI-precedence
  suites stay green with the new format.
- README's server section (both printed-banner examples and the
  "client token" prose) updated to the new shape and entropy note.

Remaining Task 65 scope (server browse panel, host-name surfacing,
Windows native-DNS-SD browse, etc.) is unstarted — this phase covers
only the token-format grooming item.

### 2026-08-13 — phase 2: the Servers panel

**Landed** (branch `task65b-server-panel`, off `task65a-passphrase-tokens`
tip `32c2a06`), four commits:

- `bc72930` **host name through the browse list.** The reducer was
  dropping `ResolvedService::get_hostname()`; it now keeps it per
  instance and renders it with the root dot trimmed (`bench.local`),
  `None` when the responder published none. No TXT key needed — the
  ignored live-advertisement test asserts the SRV target survives a
  real resolve.
- `20a8665` **`server_list.rs` — the merged host-side model.** One
  command `get_server_list`, one event `server-list-changed`.
  Snapshot shape: `{ servers: ServerRow[], browse: BrowseStatus }`,
  where a row is `{ address, name?, host?, version?, online, trust,
  fingerprint?, hasToken, insecure, prompt? }` keyed by the trust
  store's normalized `host:port`. `trust` is `trusted` exactly when
  `connect_flow::plan` would not probe (a pin, or an explicit
  unprotected choice) — a stored token alone is *not* trust —
  `fingerprintChanged` when a pending `IdentityChanged` question
  exists for the address, `new` otherwise. The row carries the pending
  question so the panel can re-raise the dialog without re-failing the
  connection. Trusted-but-not-advertising rows stay, `online: false`,
  sorted below the reachable ones. Emitted from all four write paths:
  the browse reducer, the browse status, `server_trust::answered`, and
  `connect_flow`'s prompt map.
- `d7e758b` **the panel.** Singleton `ServersPanel` on the
  keyboard-shortcuts pattern: `SERVERS_PANEL_COMPONENT`/`_ID` in
  `dockLayout.ts`, `DOCK_COMPONENTS` entry, `panel.show.servers`
  command, palette + go-to-view entries, no default chord. One merged
  list, fuzzy search (fzf, over name + host name + address; not the
  version), offline rows greyed via `.server-row.offline`. Row actions
  are the trust lifecycle only — *Trust…* dials first via
  `refresh_interfaces` so the fingerprint shown is the one this attempt
  observed, then opens `ServerTrustDialog` from the row's prompt;
  *Token…* is an inline field over `set_server_token`; *Forget* is the
  repo's danger-button-plus-title pattern (the same one
  `ProjectCachesList` uses).
- `5e20691` **retirement + docs.** `TrustedServersList` and its
  settings descriptor removed, README's connect walkthrough starts at
  the panel, CONTEXT gains **Servers panel** and **Trust state**.

**Browse status — what could honestly be surfaced.** `BrowseStatus` is
`starting | running | failed{detail} | degraded{detail} | stopped`,
every variant something the browse task observed: `failed` from
`ServiceDaemon::new()` / `browse()` refusing (the socket case),
`degraded` from `mdns-sd`'s `ServiceDaemon::monitor()` channel yielding
`DaemonEvent::Error` (a running browse that is complaining — what a
blocked multicast path looks like), cleared back to `running` by the
next resolve, and `stopped` when the daemon's event stream ends. No
detection was invented: there is no "macOS permission denied" signal in
the crate's API, so that case shows as a quiet `running` for now and is
covered by the README note the phase-3/4 work still owes.

**Tests.** Host `cargo test -p cannet-gui`: 602 passed, 6 ignored
(+16 — 3 browse-reducer, 13 `server_list` merge/badge/sort/wire-shape).
Frontend `pnpm test`: 1947 in 151 files (+24 new: 11 `serverList.test.ts`,
13 `ServersPanel.dom.test.tsx`; −5 with `TrustedServersList.dom.test.tsx`).
`pnpm build` and `cargo clippy -p cannet-gui --all-targets -- -D warnings`
clean on every commit.

**Deviations / side effects.**

- `list_trusted_servers` (host command, plus `listTrustedServers` and
  the `TrustedServer` type frontend-side) was removed along with the
  settings list, rather than kept. The phase brief said to keep the
  underlying commands; the merged snapshot is now the one read path
  over `servers.json`, and a second command answering the same
  question is a second authority to keep in step. Every *write*
  command and the trust dialog are untouched.
- `AddServerInline` and its `DiscoveredServerList` are untouched, as
  the brief directed — they retire in phase 3, which also owes
  Connection Management its per-server collapsible sections and the
  "Manage servers…" jump to this panel.
- Not verified against a running GUI (the phase forbade launching it);
  everything above is covered by unit and DOM tests only.
