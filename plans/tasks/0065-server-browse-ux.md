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
- ~~Windows GUI browse produces no per-app firewall rules~~ —
  **waived by owner ruling 2026-08-14** (phase-4 eval, option B):
  stay on `mdns-sd`; the native backend's one-address race and
  missing removal signal disqualify it even with an unsafe
  exception. The minted rules are silent; deny-path visibility
  (phase 2) and add-by-address (phase 3b) cover the blocked
  cases. README documents the Windows firewall reality instead.
  (The phase-4 status log carries the full eval data behind the
  ruling.)
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

### 2026-08-13 — phase 3: Connection Management over the server model

**Landed** (branch `task65c-connections-integration`, off
`task65b-server-panel` tip `be75010`), five commits:

- `0a1d5af` **the host says which addresses need a decision.**
  `connect_flow::needs_trust` names the probe case and the
  `addresses_needing_trust` command answers it for a set of addresses,
  so the frontend flags buses without re-deriving `is_local` or
  re-reading `servers.json`. `server_list::trust_state` now goes
  through the same function instead of reading the entry alone — which
  is what its own rustdoc already claimed — so a **loopback server
  reads *trusted***: nothing is stored for it and nothing ever will be,
  because it is never asked about.
- `b517938` **the combo binds from the trusted servers.** Local
  interfaces, then each trusted server's interfaces under a group named
  for the server (`selectedLabel` keeps the server's name in the closed
  state), then the virtual buses, then *Manage servers…*.
  `AddServerInline`, its `DiscoveredServerList`, the `serverDiscovery`
  module, and their tests are gone; `dockLayout::showServersPanel` is
  the one show-or-focus, shared by the palette command and the combo.
- `33f9fa1` **server sections.** One collapsible sibling of *Local
  interfaces* per trusted server — name, host name, address,
  reachability, and every interface it offers annotated `→ <bus>` or
  `(unassigned)`. `RemoteServerRow` (which appeared only because a
  binding named an address, and listed only bound interfaces) and
  `uniqueRemoteServers` retire; the local row's listing is now the
  shared `InterfaceList`, keyed by address.
- `fd9f373` **unknown-server legibility.** A bus bound to a server this
  machine cannot reach without an answer says so under its combo, with
  the same *Manage servers…* jump.
- `75b154b` **panel actions follow what is stored.** Fallout from the
  trust-state change: *Token…* now needs a pin and *Forget* needs
  something stored, so a loopback row does not offer to store a
  credential that would never be presented.

**Where the rules live.**

- *Sections come from the trust store, not the project.* The project
  panel renders one section per row of `trustedServers(serverList)`;
  the project only says which interface a bus is bound to. A trusted
  server that is answering is watched for interfaces whether or not the
  project uses it — the section and the combo are an offer.
- *The chosen-interface rule* is `useServerSections(chosen)` in
  `ConnectionManagement.tsx`, driven by a `Record<address, boolean>`
  the project panel computes from `bindingsForServer`. A manual fold is
  an override that survives until the rule's own answer for that server
  moves; `keptOverrides` is that reconcile (pure, and returns its input
  untouched when nothing is dropped, so a no-op does not re-render).
- *The unknown-server state* is `busServerTrust(binding, servers,
  needingTrust)`: `changed` when the row's badge says the identity
  moved, otherwise `unknown` / `untrusted` when the **host** put the
  address in `addresses_needing_trust` — split by whether the merged
  list has a row for it. Absence alone is deliberately not the test: a
  `--bind 127.0.0.1` proxy is absent too and needs no decision.
  Addresses are matched through `serverKey`, mirroring the host's
  normalisation, so a binding that spelled the address with a scheme or
  in another case still finds its row.

**Tests.** Frontend `pnpm test`: 1964 in 151 files (+17 net: 14
`BusServerTrust.dom.test.tsx`, 14 `ServerSections.dom.test.tsx`, 4
`serverList.test.ts`, 1 `ServersPanel.dom.test.tsx`; −5 combo/inline
form, −5 `AddServerInline.discovery`, −6 `serverDiscovery`).
Host `cargo test -p cannet-gui`: 604 passed, 6 ignored (+2 —
`needs_trust` is exactly the probe case, a loopback row is trusted with
nothing stored). `pnpm build` and `cargo clippy -p cannet-gui
--all-targets -- -D warnings` clean on every commit.

**Deviations / side effects.**

- **Two host changes the brief did not ask for**, both in service of
  its own instruction that the unknown-server state come from host
  data: the `addresses_needing_trust` command (the alternative — using
  the merged list's silence about an address — would flag every
  loopback binding, since a `--bind 127.0.0.1` server is never asked
  about and so never stored), and `trust_state` consulting
  `connect_flow::plan`.
- **~~Blocker for a later phase: a server that neither advertises nor is
  trusted is now unreachable.~~** — closed by phase 3b (`b1c5c95`).
  With the typed-address field gone, the
  only way a server becomes bindable is a trusted row, and the only way
  to get one is *Trust…* on a row the browse produced. Two gaps follow:
  a server on another subnet (or started `--no-mdns`) cannot be reached
  at all, and — before `0a1d5af` — a loopback proxy could not either,
  because *Trust…* against it succeeds without a prompt, so nothing is
  ever stored and the row would have stayed *new* forever. The
  trust-state change fixes the loopback case **only while the proxy is
  advertising**, which is how it reaches the list. What is still owed:
  an *add by address* affordance in the Servers panel, which is where
  the owner's ruling puts server selection anyway. README's
  Servers-panel section and the panel's empty states no longer claim an
  off-subnet server is reached by typing its address on a bus.
- The combo's per-server groups are labelled `name ?? address`. Two
  servers advertising the same instance name would share one group
  header; their options stay distinct (values are addresses) and the
  section headers carry the full detail.
- Not verified against a running GUI (the phase forbade launching it);
  everything above is covered by unit and DOM tests only.

### 2026-08-13 — phase 3b: add by address

**Landed** (branch `task65d-add-by-address`, off
`task65c-connections-integration` tip `ae28c4e`), three commits, closing
the blocker phase 3 recorded:

- `7a11564` **a question the host is waiting on is a row.** `merge` took
  its rows from the trust store and the browse only, so an address that
  neither advertises nor has anything stored had nowhere to be answered
  from. A pending prompt now puts a row in the list on its own account —
  which is also what makes a bus's *Manage servers…* jump land on
  something.
- `9e7a7fc` **`add_server`.** The host checks the address shape
  (`host:port`, brackets on an IPv6 literal, a port that parses), dials
  it through the existing `refresh_interfaces`, and lets
  `connect_flow` do exactly what it does for a browsed row's first
  contact. It returns the normalized key so the panel knows which row to
  open. **A refused attempt writes nothing**: the pin the operator
  accepts is the store's first record of the server, and until then the
  pending question holds the row. The one write is for a server reached
  with no question asked — a loopback proxy — recorded as
  `TrustEntry::manual`, since no answer will ever exist to keep it in the
  list.
- `b1c5c95` **the panel.** *Add server…* in the toolbar opens a
  `host:port` field. The panel decides two things only — that the text
  looks like an address (`addressShapeError`, a typo guard the host
  re-checks) and that the list does not already hold it — and hands the
  rest to `add_server`. README's Servers-panel section and CONTEXT gain
  the affordance; the "nothing is advertising" empty state now points at
  it instead of saying an off-subnet server is out of reach.

**What was reused, and what was added.** The whole trust flow is the
existing one: `refresh_interfaces` → `connect_flow::plan`/`classify` →
the prompt map → `ServerTrustDialog` over the row's `prompt`, the same
path the panel's *Trust…* has used since phase 2. Three additions, each
because the panel could not drive the existing flow without it:
`add_server` (nothing existed that took an address the list has no row
for), rows from pending prompts (the dialog needs a row to hang on), and
`TrustEntry::manual` (a server that is never asked about leaves no trace
that would keep it listed). `connect_flow::waiting_on` is the internal
helper that lets `add_server` tell "refused with a question" from
"failed with nothing to ask".

**How the rows read.** A just-added address that has not been answered
yet is an offline row wearing *new*, carrying the question — the same
`prompt?` mechanism phase 2 built, no new state. Accepting pins it and
it becomes trusted, still greyed until something advertises it, and
bindable in Connection Management like any other trusted server. An
added address that was refused or unreachable never becomes a stored
row; the panel says what the attempt hit. An address already in the list
is not added twice — its row is outlined (`.server-row.highlight`) and
the panel says so. *Forget* now appears on a manually added row too,
titled for what it does there (nothing is stored for it).

**Tests.** Host `cargo test -p cannet-gui`: 609 passed, 6 ignored (+4 —
a prompt-only row, a manual row's trust state and removability, address
checking both ways). Frontend `pnpm test`: 1972 in 151 files (+8 — 5
`ServersPanel.dom.test.tsx` covering the happy path through to the
dialog, an unreachable address, a shape that never leaves the window, a
duplicate, and a manually added offline row; 3 `serverList.test.ts` over
`addressShapeError`). `pnpm build` and `cargo clippy -p cannet-gui
--all-targets -- -D warnings` clean on every commit.

**Deviations / side effects.**

- `ServerRow` needed `#[allow(clippy::struct_excessive_bools)]` once
  `manual` made it four. It is the JSON the panel renders and each flag
  is an independent fact; folding them into enums would invent states
  the model does not have.
- Rows from pending prompts are visible beyond the add flow: any address
  the host is waiting on now appears in the panel, including one a bus
  binding named. That is the surface the *Manage servers…* jump wanted,
  but it was not asked for.
- Not verified against a running GUI (the phase forbade launching it);
  everything above is covered by unit and DOM tests only.

### 2026-08-13 — phase 4: native Windows DNS-SD, evaluated

**Eval only — no code landed** (branch `task65e-native-dnssd`, off
`task65d-add-by-address` tip `edd3c1a`). The decision gate in the
brief resolved to *stop and hand the owner a decision*: the only route
that would satisfy the exit criterion needs `unsafe` in our own tree,
and the workspace forbids it outside `crates/cannet-spill`.

**The premise is correct.** Windows's `DnsServiceBrowse` /
`DnsServiceResolve` (`dnsapi.dll`, Win10+) has the OS resolver own the
mDNS socket, and it does exactly what the folded-in item hoped:

- A throwaway probe was built at a scratchpad path that had **no**
  firewall rule of any kind, and browsed a live `cannet-server`
  advertisement (`--bind 127.0.0.1:50071 --name cannet-probe-target`,
  the debug binary, which already carries allow rules) through the
  native API.
- `Get-NetFirewallRule -All` counted **899 rules before the probe and
  899 after**, with no application-filter entry for the probe's path
  and no prompt. For contrast, three binaries from the Task 43 mDNS
  spike — which bound 5353 themselves — still sit in that table with
  inbound *Block* rules on the Public profile, one TCP and one UDP
  each, exactly the per-app pair the item set out to avoid.
- `Get-NetUDPEndpoint -LocalPort 5353` showed the socket held by
  `svchost` (`dnscache`), for which Windows ships built-in
  `MDNS-In-UDP-{Domain,Private,Public}-Active` allow rules pinned to
  that service. That is the mechanism: nothing in the app binds.

**What the API delivered to the reducer.** Everything
`server_browse::Resolved` wants except the address set: instance name
`cannet-probe-target`, SRV target host `cannet-probe-target.local`,
port `50071`, and TXT `ver = v0.8.1-142-ge1465dd-dirty`. Resolve
latency when the server was up: 7–11 ms.

**Two defects, both disqualifying as things stand.**

1. *One address per resolve, chosen by a race.* `DNS_SERVICE_INSTANCE`
   has a single `ip4Address` and a single `ip6Address` pointer, and the
   resolve is answered by whichever interface replies first. Four runs
   against the same advertisement: interface 25 (VMware VMnet1)
   returning only `fe80::9:12b9:dcae:57f1` three times, interface 15
   returning only `10.10.10.50` once. `dial_rank` treats link-local
   IPv6 as undialable, so three of four runs would have produced **no
   row at all** for a server that is plainly there. `mdns-sd` avoids
   this by accumulating addresses across the burst of per-interface
   resolves, which is the whole reason `BrowseList` is keyed by
   fullname and merges rather than replaces.
2. *No removal signal.* The server was hard-killed at t=6 s and the
   browse ran to t=130 s: **no removal event in 124 s**. This is
   structural, not a timing artefact — the crate's Windows backend
   contains no construction of a `Removed` event at all, while its
   Linux and macOS backends do. A one-shot resolve of the vanished
   instance did fail (3 s timeout) at t=130 s, so liveness is
   recoverable by polling; the reducer has no polling.

The graceful-shutdown case (a goodbye packet, which `mdns-sd` turns
into a removal in ~1 s) was **not** measured: `GenerateConsoleCtrlEvent`
attached to the server's console and returned success but the process
did not exit, and the alternative — a registrar binary of our own —
would have bound 5353 from an unruled path, which this phase was
forbidden to do. It does not change the verdict: the crash/vanish case
alone leaves a dead server in the list forever.

**Crate survey.** `mdns-sd-discovery` 0.3.0 is the only maintained
crate that wraps the native *browse* API (it is what the probe used,
and both defects above were observed through it — the address one is
the Win32 struct's, the removal one is the crate's). `win-dns-sd`
(WinRT, register-only, last touched 2021) and `dns-sd-native`
(register-only) are the wrong half of DNS-SD; `astro-dnssd` wraps
Apple's `dns_sd.h` and so wants Bonjour installed on Windows — the
objection that rejected `zeroconf` in Task 43, and no help on the
firewall either, since `mDNSResponder` is one more userland 5353
socket. All four are recorded in `plans/technology-inventory.md`.

**The unsafe policy, as enforced.** `[workspace.lints.rust]
unsafe_code = "forbid"` in the root `Cargo.toml`; every member opts in
with `[lints] workspace = true`, `apps/gui/src-tauri` included.
`forbid` cannot be lifted by a local `#[allow]`, which is why
`cannet-spill` does not inherit the workspace lint table at all and
declares its own `unsafe_code = "deny"` — the one crate where `unsafe`
is permitted, per-site and justified (ADR 0002). Relaxing this is the
owner's call, not the orchestrator's.

**The decision.**

- **Option A — grant a scoped `unsafe` exception.** A contained module
  (`apps/gui/src-tauri/src/dnssd_win.rs`, or a new small crate on the
  `cannet-spill` pattern so `apps/gui/src-tauri` itself stays
  `forbid`) calling `DnsServiceBrowse`/`DnsServiceResolve` directly.
  Owning the FFI fixes defect 2 — the browse callback hands over the
  whole current PTR record list, so diffing it against the previous
  one yields removals — but **not** defect 1, which is the Win32
  struct's shape: that still needs a per-interface resolve fan-out or
  a switch to dialling the SRV host name (which would make the trust
  store's `host:port` key differ by platform for one server). The
  hand-written surface is raw callback plumbing with pointer lifetimes
  and cancel handles — the shape CLAUDE.md's reviewability rule warns
  is hard to spot-check even in a small diff. Gets the exit criterion.
- **Option B — stay on `mdns-sd`, waive the criterion.** The GUI keeps
  minting one inbound rule pair per binary path on first browse. The
  deny-path legibility this task also asked for already shipped in
  phase 2 (`BrowseStatus::Failed/Degraded`), so a blocked browse is
  visible rather than silent, and phase 3b's *Add server…* reaches any
  server by address without discovery at all. Cost: the README owes
  the Windows firewall reality for the GUI (it already carries it for
  the server) and the macOS local-network prompt. No code.
- **Option C — pre-create the rule at install time** was considered
  and does not work as shipped: the Tauri NSIS bundle installs
  per-user with no administrator rights, and adding a firewall rule
  needs elevation. It would take switching the installer to
  per-machine, which buys an admin prompt in exchange for the
  firewall one.

**Recommendation: B.** A is a lot of hand-written `unsafe` for a
property that is real but cosmetic-adjacent — the rules Windows mints
are silent, same-host discovery works regardless, and the case they
actually break (reaching another machine's advertisement) is already
reachable by address — and it still would not restore the address set
without a second design change to how a server is keyed. If the owner
wants A anyway, the honest scope is: new crate with `unsafe_code =
"deny"`, browse + resolve + cancel, PTR-set diffing for removal, a
per-interface resolve fan-out for addresses, and a reducer-level test
suite fed by a fake backend.

### 2026-08-13 — phase 5: documentation close-out

**Landed** (branch `task65f-docs-sweep`, off `task65e-native-dnssd`
tip `e7f8501`): the doc-only sweep the option-B ruling owed, plus the
pending grooming-resolution edits carried since phases 1–3b.

- Committed verbatim: this file's waived-exit-criterion edit, the
  task 63 and task 66 grooming resolutions, and ADR 0052.
- README gains the Windows firewall reality for both the GUI and the
  server (one prompt per binary install path, per network profile;
  allowing is correct; a browse a deny is blocking shows as
  `degraded`/`failed` in the Servers panel rather than failing
  silently; **Add server…** reaches a blocked or non-advertising
  server regardless) and the macOS local-network permission note
  (denial silently empties browse — `mdns-sd` has no denied signal —
  with **Add server…** as the workaround and the System Settings path
  to re-grant it).
- Consistency sweep: the Connection-Management paragraph describing
  discovery vs. trust (README, near ADR 0040/0041) still said "a
  browsed server is checked exactly as a typed one would be" and "a
  server started with `--no-mdns` never appears in the list" — both
  leftover from before phase 3 removed the per-bus typed-address field
  and phase 3b added **Add server…**. Reworded to the current
  mechanism; no other stale references to `AddServerInline`,
  `TrustedServersList`, or a per-bus typed address found outside
  historical status-log prose (which stays, describing what those
  phases changed). CONTEXT.md's Servers-panel terms (Servers panel,
  Add server…, Unknown server, Server section, Trust state) already
  matched the shipped UX; the passphrase-token prose phase 1 landed
  also still stands. No code changed.

Task 65 is ready for its exit-criteria walk: every criterion is met
except the Windows-firewall one, which carries the owner's option-B
waiver recorded above.

## Exit-criteria walk (2026-08-14, orchestrator)

1. **Singleton panel, one merged list** (name, host name, host:port,
   version, trust badge; offline greyed; fuzzy search; standalone
   list retired) — MET (phase 2; host-side merge in
   `server_list.rs`, 13 host + 24 frontend tests; settings-dialog
   surface removed same phase).
2. **Trust flows + Connection Management integration** (TOFU/token/
   forget from the panel; collapsible server siblings expanded only
   while chosen; AddServerInline removed → "Manage servers…";
   unknown-server legibility) — MET (phases 3 + 3b; add-by-address
   restored the non-advertising-server path and struck the recorded
   regression).
3. **5-word passphrase tokens** — MET (phase 1; real-run banner
   verified; wire/store untouched).
4. **No per-app firewall rules on Windows** — WAIVED (owner ruling
   2026-08-14, option B; phase-4 eval data in the status log).
5. **README covers macOS permission + Windows firewall realities**
   — MET (phase 5).
6. **Blocked-discovery states visible, not silent** — MET (phase 2
   `BrowseStatus`: starting/running/failed/degraded/stopped;
   macOS-permission blindspot documented in README per phase-2
   status log).

Caveat recorded: per the no-UI-automation rule, this task shipped on
unit/DOM coverage only — the owner's next interactive session is the
live pass over the new panel/connections UX.

Perf gate (ADR 0031): **passed 31/31** (release build `13213cb`,
ev-zonal 60 s scrub; report
`docs/performance-measurements/frontend/2026-08-14-13213cb-task65-closeout.json`,
uncommitted). `tx_late_ms_max` 89.8 vs 75.9 baseline noted as run
variance (metric ranged 16–90 across this week's green runs); all
limits comfortably held. Baseline untouched.
