# ADR 0062 — One date pattern: a TR35 subset, two implementations, one vector file

Status: accepted (2026-10-07)

## Context

Wherever a user writes a calendar-time format, cannet has to interpret
it — and it must interpret it the same way everywhere. The one place
that existed, the export / logger name template's `{start:…}` /
`{now:…}` tokens, passed the format straight to `chrono`'s strftime
(`%Y-%m-%d`). The owner is extending user-chosen formats to every
displayed calendar time (a date/time setting rendered by the
frontend), and ruled on the notation:

> I don't love the strftime behavior we've got; it's not as intuitive.
> — owner, 2026-10-07

File names are resolved by the host (the logger writes without the
frontend); display is rendered by the frontend from raw numbers (the
host ships seconds, never formatted text). So the notation needs an
implementation on each side, and the two must not drift.

## Decision

1. **The notation is TR35 (Unicode LDML date format patterns)**, in a
   fixed subset — `yyyy-MM-dd HH:mm:ss`:

   | field | tokens |
   |---|---|
   | year | `yyyy`, `yy` |
   | month | `M`, `MM`, `MMM` (Jan), `MMMM` (January) |
   | day | `d`, `dd`; `EEE` (Mon), `EEEE` (Monday) |
   | hour | `H`, `HH` (0–23); `h`, `hh` (1–12) with `a` (AM/PM) |
   | minute / second | `mm`, `ss` |
   | fraction | `S` … `SSSSSSSSS` (1–9 digits, truncated) |
   | offset | `xx` (`-0700`), `xxx` (`-07:00`), `X` / `XX` / `XXX` (`Z` at UTC) |
   | zone name | `zzz` (`PDT`) — display only |

   Letters are reserved as TR35 reserves them: an ASCII letter outside
   the subset, or a subset letter at an unlisted width, is an **error**,
   never a literal. Literal text is quoted (`'T'`); `''` is an
   apostrophe. Names are English (the TR35 root locale) — there is no
   locale layer, and one predictable rendering is the point.
   Fractions truncate rather than round, so a time never reads as a
   later second than the one it is in.

2. **Two implementations, one vector file.** The host's
   `apps/gui/src-tauri/src/date_pattern.rs` renders file names; the
   frontend's `apps/gui/src/datePattern.ts` renders display. Both test
   suites read `apps/gui/src/datePattern.vectors.json` (the host through
   `include_str!`): every token, quoting, truncated fractions, offsets at
   UTC and on both sides of it (including half- and quarter-hour
   offsets), and the error cases **with their exact messages** — so the
   two sides refuse a pattern in the same words. Each vector carries an
   explicit UTC offset, so the file is machine-independent. A change to
   the subset is a change to the vector file first.

3. **`zzz` is display-only.** The frontend renders the zone name through
   `Intl`; the host has no zone-name table and refuses `zzz` in a file
   name with that reason (use `xxx`). The refusal is in the vector file
   too.

4. **No legacy notation.** A template saved in strftime fails to resolve
   with the pattern's own error (`%Y` fails on `Y`) until it is
   retyped. No migration, no dual parser.

5. **ISO 8601 stays where a machine reads the time or a file name wants
   it sortable**, untouched by any pattern: the bare `{start}` / `{now}`
   tokens (ISO basic, `yyyyMMdd'T'HHmmssxx` — extended ISO's colons
   cannot appear in a Windows file name), the GUI's and the server's
   rolling-log lines, the sidecar's log (parsed by the host), BLF / MDF
   header fields, bench run directories, and the dev console's `[diag]`
   stamps.

## Consequences

- A template written as `{start:%Y-%m-%d}` shows an error in the
  preview, and a logger whose template it is refuses to start, until it
  reads `{start:yyyy-MM-dd}`.
- Two small hand-rolled formatters to keep in step; the shared vector
  file is what keeps them so, and a token absent from it fails both
  suites' coverage check.
- The calendar arithmetic itself stays library-provided: `chrono` on the
  host, `Date`'s UTC fields on the frontend. Only the pattern grammar
  and the English names are hand-written.

## Rejected alternatives

- **strftime (`chrono` format strings) for user-facing patterns** —
  rejected 2026-10-07 by the owner: "not as intuitive". `%`-codes are
  opaque at a glance (`%m` month vs `%M` minute), and the frontend has
  no strftime of its own, so display would have needed a second,
  hand-rolled strftime anyway.
- **`date-fns`** (its `format` speaks a TR35 dialect) — frontend only;
  it gives the host nothing, so parity with file names would still rest
  on a hand-rolled Rust side matched to a library's edge cases.
- **ICU4X** — no pattern-string API for arbitrary user patterns, and
  megabytes of locale data to render one English format.
- **`Intl.DateTimeFormat` options instead of a pattern** — no pattern
  string at all, so nothing for the user to write or for the host to
  share; it remains only the source of the zone name.
