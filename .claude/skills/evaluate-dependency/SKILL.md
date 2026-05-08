---
name: evaluate-dependency
description: Evaluate a candidate third-party dependency (library, framework, protocol, tool, driver) before adopting it. Use when the project is about to take on a new dependency or pick between alternatives, or when the user asks to "evaluate", "compare", or "pick a library/framework/tool" for some need. Produces enough material for an entry in plans/technology-inventory.md.
---

# Evaluate a third-party dependency

Use this skill any time we're about to take on a new dependency — a library,
framework, protocol implementation, file-format parser, hardware driver, etc.
— or pick between alternatives. The goal is a deliberate decision, recorded
in `plans/technology-inventory.md`, not a drive-by import.

Run the steps in order. Don't skip the "agree on criteria" step: choosing the
wrong attributes to optimize for is the most common way these decisions go
sideways.

## 1. Frame the need

Before evaluating anything, write down — in your reply to the user — what
problem the dependency would solve, where it sits in the architecture, and
which phase from `plans/phased-implementation.md` it belongs to. If the need
isn't on the plan yet, surface that first; the dependency decision shouldn't
get ahead of the plan.

## 2. Agree on the evaluation criteria

The candidate attributes to weigh:

- **Performance.** Throughput, latency, memory footprint, allocation
  behavior. Matters most on hot paths (CAN frame ingest, decode, network
  transport).
- **Maintenance health.** Release cadence, time-to-fix on issues, number of
  active maintainers, last-commit recency, whether it has a single bus
  factor.
- **Observability of behavior.** How easy is it to see what the library is
  doing? Logging hooks, metrics, deterministic behavior, ability to step
  through it in a debugger, source availability.
- **Cost.** License terms, commercial fees, vendor lock-in, redistribution
  constraints. Includes the cost of *not* using it (build it ourselves).
- **Popularity / ecosystem.** Stars and download counts are weak signals on
  their own; what matters is the size of the user base that hits the same
  edge cases we will, and whether there's community knowledge to draw on.
- **Quality.** Test coverage, type safety, API hygiene, error handling,
  track record on security issues.

Ask the user which of these matter most for *this* decision, and which can
be deprioritized. Offer a recommendation up front based on the need:

- For driver / vendor SDK choices, lean on **cost** (license) and
  **maintenance health** — we'll be stuck with the choice for a long time.
- For decode/parsing libraries on the critical path (DBC, BLF, CAN frame
  handling), lean on **performance** and **observability**.
- For protocol / transport choices, lean on **architectural fit** (next
  step) and **performance**.
- For tooling that's only used at build/test time, lean on **popularity**
  and **maintenance** so we don't get stranded.

Only proceed once the user has confirmed or adjusted the weighting. If the
project has a stated preference in `CLAUDE.md` or the planning docs, treat
that as the default.

## 3. Identify the available options

Cast a wide-enough net that the comparison is meaningful — typically 2–4
realistic candidates. Include:

- The obvious mainstream choice.
- At least one alternative with a meaningfully different tradeoff (e.g. a
  smaller / lighter option, or a vendor-native option).
- "Build it ourselves" if it's plausible — sometimes the right answer.

For each option, capture: name, source (URL), license, language(s),
last-release date, and a one-line summary of what it is.

If you're not sure what's available, say so before guessing — search, ask
the user, or read recent docs rather than fabricating options.

## 4. Evaluate architectural resonance and integration cost

For each candidate, assess:

- **Fit with the CAN abstraction.** Does it produce/consume frames in a
  shape that the abstraction in `plans/` can absorb without ceremony? Or
  does adopting it warp the abstraction?
- **Fit with the client/server split.** Does it run on the server side, the
  client side, or both? Does it force a language/runtime choice on either?
- **Integration cost.** Estimated work to wire it in (hours/days, not
  months). Include any glue code, bindings, or adapter layers needed.
- **Exit cost.** If we adopt it and later want out, how localized is the
  blast radius? Wrapped behind an interface, or threaded throughout?

A library that scores well on the per-attribute axes can still be the wrong
choice if it doesn't fit the architecture. Call that out explicitly.

## 5. Recommend and record

End with:

1. A short comparison table or bullet list of the candidates against the
   agreed-upon criteria.
2. A concrete recommendation (which option, why, what the main risk is).
3. A draft entry for `plans/technology-inventory.md` — status `proposed`
   for the recommended candidate, `rejected` (with one-line rationale) for
   the alternatives that were seriously considered. The user can promote
   the entry to `adopted` once the decision lands in code.

Don't actually add the dependency to the build until the user confirms.
