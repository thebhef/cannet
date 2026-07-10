# Task 33 — DBC View Rework

Collects every outstanding DBC-view item into one focused pass:
responsiveness, search behaviour, tree organisation, and keyboard
navigation. Pulled together from Task 20 (large-DBC perf + FZF
hiding), Task 25 (DBC performance/search/scrolling + the massive-DBC
fixture), and the backlog (ECU view mode). Land it against a
realistic large fixture so the scaling work is measurable.

## Items

### 1. Paging / responsiveness

The DBC view is sluggish with a large database because it holds and
renders the whole database at once. Make it a thin view over the model
that pages like the other data-bearing views (see
[`../../CLAUDE.md`](../../CLAUDE.md) § GUI architecture: thin views
over a paged model) — fetch only the visible slice plus a bounded
prefetch margin.

### 2. Search behaviour

The DBC panel already uses the `fzf` matcher; this is about how it
scales and behaves, not picking a new library.

- **Hide non-matches.** Search highlights matches but does not hide
  rows that don't match the filter string, so on a large DBC the
  highlighted items are hard to find. Filter the tree to matches.
- **Collapse while searching.** With a search active the tree still
  shows fully-expanded nodes; it should collapse nodes that contain no
  match and reveal only the paths to matches.
- **Ranking / latency.** Iterate on match quality and latency against
  the large fixture in hand.

### 3. Tree organisation: bus / dbc / ecu / message

Organise the tree by **bus → DBC → ECU → message** (mirroring the
per-ECU grouping the RBS panel uses). Today the message level is
missing from the grouping. (Absorbs the backlog "ECU view mode" item.)

### 4. Keyboard tree navigation

The tree can't be driven from the keyboard. Add collapse / expand and
up / down navigation so the whole tree is reachable without the mouse.

### 5. Test fixture: a large, realistic DBC set

To exercise the above, generate a deliberately large, realistic
fixture deterministically (like `examples/generate_blf.py`) so the
suite stays reproducible:

- **Two unique DBCs**, each with **150+ messages**.
- Some messages with **500+ multiplexed signals**.
- A realistic EV flavour — BMS, inverter, and a few other nominal
  ECUs — with **unique, realistic** message and signal names (not
  `Sig_0001` filler) so search ranking is exercised the way a real
  database stresses it.

## Exit criteria

- The DBC view pages its content and stays responsive with the large
  fixture open (no whole-database render).
- Search hides non-matching rows and collapses to reveal only match
  paths; latency and ranking are demonstrably improved against the
  fixture.
- The tree groups by bus / DBC / ECU / message.
- The tree is fully navigable by keyboard (collapse / expand / up /
  down).
- The large two-DBC fixture is generated deterministically and checked
  into `examples/`.
