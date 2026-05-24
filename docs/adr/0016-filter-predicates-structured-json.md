# ADR 0016 — Filter predicates are structured JSON

Status: accepted (2026-05-24)

## Decision

Filter predicates are **structured JSON** — `all` / `any` /
leaf-predicate trees — authored through a node-and-form editor and
persisted as `serde_json::Value` in the project file
([ADR 0011](0011-project-file-format.md)).

The filter editor today lives inside the project graph view
([ADR 0006](0006-xyflow-project-graph.md)) as the UI for `filter`
nodes, but the persistence shape and the structured editor pattern
are independent of where the editor is hosted.

## Why

**The editor and the persisted shape match.** The form-and-tree
authoring surface produces a tree; the project file stores a tree.
There's no translation layer between authored intent and stored
predicate.

**No new dependency.** `serde_json::Value` round-trips through the
project file already; predicates inherit the project file's
schema-version migration path.

## Consequences

- **Predicate validation is `serde` rejection at load time** —
  shape enforcement lives in the type system and the filter-node
  UI; there is no separate validation pass.
- **Adding a new predicate kind is one variant in the `Predicate`
  enum plus the matching editor affordance** — no grammar update,
  no parser regeneration.
