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

- **Feature set.** Does the candidate actually do the things we need it to
  do? List the must-have capabilities for *this* decision and check each
  one off. A library that "almost" covers the need but punts on a critical
  feature is a false economy. Distinguish must-haves from nice-to-haves.
- **Architectural fit.** Does the candidate's shape — its concurrency
  model, data model, runtime, threading assumptions, where it lives in the
  process — align with the architecture in `plans/`? A library can have
  every feature we want and still warp the system around itself. Note: a
  candidate's *features* and its *fit* are independent — separate them
  deliberately when scoring.
- **Performance.** Throughput, latency, memory footprint, allocation
  behavior. Matters most on hot paths (CAN frame ingest, decode, network
  transport).
- **Maintenance health.** Release cadence, time-to-fix on issues, number of
  active maintainers, last-commit recency, whether it has a single bus
  factor.
- **Project openness.** How transparently is the project developed? Source
  availability is the floor; the real question is whether design discussion,
  issues, RFCs, release rationale, and decision history happen in the open.
  Closed-development-with-public-tarball releases hide why things change and
  what's coming next; open development means we can read the reasoning, file
  bugs that get acknowledged, and anticipate breakage. Distinct from
  maintenance health — a project can be active and still opaque, or quiet
  but fully in the open.
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
  handling), lean on **feature set**, **performance**, and **quality**.
- For protocol / transport choices, lean on **architectural fit** and
  **performance**.
- For framework-shaped choices (UI toolkits, app frameworks), lean on
  **feature set** and **architectural fit** — the shape of the framework
  pervades everything that touches it.
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

## 4. Evaluate integration mechanics

Architectural fit was already scored in step 2. Here, work out the concrete
mechanics of adopting each candidate:

- **Integration cost.** Estimated work to wire it in (hours/days, not
  months). Include any glue code, bindings, or adapter layers needed.
- **Exit cost.** If we adopt it and later want out, how localized is the
  blast radius? Wrapped behind an interface, or threaded throughout?
- **Constraints it imposes.** Does it force a language/runtime choice,
  pin a transitive dependency, require a specific build system, or dictate
  where it can run (client, server, both)?

If the integration mechanics surface a fit problem that step 2 missed,
loop back and update the architectural-fit score — don't paper over it.

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
