# Task 144 — cannet-client CLI: the auth workflow without the GUI

Opened by owner instruction 2026-09-17; groomed 2026-09-17/18.
**Executes now, on the current stack.**

## Why

The python client (task 136) does full ADR-0041 auth on the wire —
TLS pinned to a stored fingerprint plus a bearer token on every RPC —
but it only *reads* the GUI's trust store. The acceptance workflow
(mDNS browse, TOFU fingerprint compare, token entry) exists only in
the GUI's Servers panel, so a machine without the GUI cannot onboard
against a server at all short of hand-editing `servers.json`.

## Scope

A console script **`cannet-client`** (pyproject entry point in the
client package) with three subcommands, mirroring the GUI's Servers
panel and nothing more:

- **`list`** — the GUI's server-list merge (`server_list.rs`): a
  one-shot mDNS browse of `_cannet._tcp` (`--timeout`, default a few
  seconds) merged with the trust store, one row per server —
  instance name, `host:port`, trust state (trusted / new /
  unprotected-by-choice), and whether it is currently advertising.
  **Known servers appear even when absent** (owner, 2026-09-18),
  with a not-answering marker.
- **`connect <host:port | name>`** — mirrors `connect_flow.rs`'s
  four paths:
  - loopback → plaintext, no questions;
  - pinned → TLS verified against the stored fingerprint, stored
    token presented;
  - nothing stored → TOFU probe: print the observed `SHA256:…`
    fingerprint, the operator compares it against the server's
    startup banner and confirms, then is prompted for the banner's
    passphrase token; both stored;
  - endpoint not speaking TLS → explicit "connect unprotected?"
    prompt; a yes stores `insecure: true`. Never a silent fallback.
  - A fingerprint mismatch against a stored pin is refused with a
    clear message — no retry, no fallback, same as the GUI.

  After storing, verify with one authenticated RPC, report the
  result, and print the working
  `can.Bus(interface="cannet", server=…)` snippet.
- **`forget <server>`** — delete the server's trust entry (pin,
  token, flags) from `servers.json` (owner, 2026-09-18); the same
  act as removing the row in the GUI's Servers panel.

## Rulings

- **The CLI writes the same `servers.json`** the GUI owns — same
  schema, same `host:port` key normalisation; accept once, every
  client on the machine inherits (owner, 2026-09-17). ADR 0032/0041
  get a note that the store now has a second writer.
- **The package moves out of `servers/`** to top-level
  **`clients/cannet-python-client/`** (owner, 2026-09-18) — it is a
  client, not a server. Amended into its introducing branch
  (`task136-core-bus`), path references swept repo-wide.
- **New dependency `zeroconf`** (browse only, never advertising) →
  `technology-inventory.md` entry.
- **Placement**: one gt-tracked single-commit branch
  `task144-client-cli`, inserted directly above the client
  introduction (between `task136-clock-detect` and
  `task137-templates`), upper stack restacked (owner, 2026-09-17).
- **The CLI is a thin layer over an application model** (owner,
  2026-09-18) — ADR 0003's contract on a terminal: browse, merge,
  connect flow and store writes are importable library modules; the
  subcommands only parse args, drive prompts, and render.

## Phases

1. **Move** — the package lives at `clients/cannet-python-client`,
   moved out of `servers/` and absorbed into `task136-core-bus`,
   with references swept (`ci.yml`, `.pre-commit-config.yaml`,
   `README.md`, plans docs, in-package docs) and the stack
   restacked.
2. **CLI** — the three subcommands on `task144-client-cli`, TDD
   against the same local test server the existing TLS/trust tests
   use.

## Exit criteria

- `cannet-client list` shows the browse ∪ trust-store merge with
  trust state and presence per row; a known-but-silent server still
  appears.
- `cannet-client connect` handles all four connection paths with the
  prompts above, refuses a pin mismatch, verifies with an
  authenticated RPC on success, and round-trips a store entry the
  GUI reads unchanged.
- `cannet-client forget` removes the entry; a following `connect` is
  back to trust-on-first-use.
- Tests cover the store round-trip, each connect path, and the merge
  (fake browse results; no real mDNS or network in the default
  suite).
- `technology-inventory.md` lists `zeroconf` as adopted; ADRs
  0032/0041 note the second writer; both READMEs reflect the new
  path and the CLI.

## Status log

- 2026-09-18 — task opened, groomed, phases cut; execution starting.
- 2026-09-18 — phase 1 done: package moved to
  `clients/cannet-python-client`, absorbed into `task136-core-bus`
  (`01608032`); references swept across 4 amended branches; the
  `../cannet-local-sidecar` path dependency re-deepened to
  `../../servers/cannet-local-sidecar` in `pyproject.toml`/`uv.lock`;
  stack restacked, 86 passed / 1 skipped at tip.
- 2026-09-18 — phase 2 done: `task144-client-cli` (`9fe79a27`)
  inserted above `task136-clock-detect`; model modules `browse.py` /
  `servers.py` / `connect.py` + `trust.py`'s write half, `cli.py`
  thin per the ADR-0003 ruling. 138 passed / 1 skipped (+52),
  mypy/ruff clean, entry point resolves; python-only diff, Rust /
  frontend / sidecar lanes declared unreachable (tip release build
  green anyway). Name resolution: store first, typed `host:port`
  as-is, browse only for an unknown bare name.
- 2026-09-18 — **exit criteria walked: all 5 met.** (1) list =
  browse ∪ store, absent servers shown not-answering — met.
  (2) four connect paths, pin-mismatch refused, authenticated
  `ListInterfaces` verify, additive GUI-compatible store writes —
  met, with one deliberate deviation: a *pinned* server that is
  down is refused, not offered in the clear (matches
  `connect_flow.rs`, which only asks on a probe; asking would make
  "server down" a route to dropping protection) — queued for owner
  confirmation. (3) forget → next connect is TOFU — met. (4) suite
  off-network via fakes/seams, model tested directly — met.
  (5) `python-zeroconf` 0.151 adopted in the inventory (LGPL-2.1
  caveat recorded there: fine unfrozen; revisit if ever bundled),
  ADR 0032/0041 second-writer notes, both READMEs — met. Side
  finding: the GUI's own store writer *drops* unknown JSON keys
  where the CLI preserves them — asymmetry queued.
