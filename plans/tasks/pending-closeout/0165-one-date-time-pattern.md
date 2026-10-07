# Task 165 — One Date/Time Pattern

> **Opened 2026-10-07** from the owner's reaction to the plot's new
> calendar-time hover (`fix-cursor-chip-row` 8107af40), groomed the same
> day. In progress (phase 1 landed 2026-10-07).

## Why

> I don't like the time format. We should use yyyy-MM-dd HH:MM:ss and
> allow the user to customize the format string in the settings. And
> that should apply across all date/time formats in the application —
> EXCEPT in file formats/slugified context where ISO time is useful.
> […] inclined to switch both to TR35; I don't love the strftime
> behavior we've got; it's not as intuitive. — owner, 2026-10-07

Today the application renders calendar times five different ways, none
of them chosen by the user, and its one user-written time format — the
`{start:%Y-%m-%d}` file-name tokens — speaks strftime.

## Survey (2026-10-07)

Every user-facing calendar time is formatted **in the frontend from a
raw number** (the host ships ns / ms / seconds, never formatted text),
so the setting reaches everything through the frontend alone.

| Site | Today | Under the setting |
|---|---|---|
| `format.ts::formatLocalTimestamp` — trace, By-ID and event time-cell hovers, plot A/B chips and x-tick hovers, export extent labels | `toLocaleString` (ms, zone) | follows |
| `logFileGrid.ts::formatLogTimestamp` — logger grid start / end | UTC ISO, deliberately | follows (local) |
| `logFileGrid.ts::formatLogModified` — logger grid modified | hand-rolled `yyyy-MM-dd HH:mm` | follows |
| `systemLog.ts::formatLogTimestamp` — System Messages column and copied text | `HH:mm:ss.SSS`, no date | follows (owner: "across all"; the column widens, and milliseconds show only if the pattern has `SSS`) |
| `BlfChannelMapModal.tsx` "started …" | bare `toLocaleString()` | follows |
| `exportRange.ts::formatRangeBound` — export From / To fields | `Nd HH:MM:SS`, editable, parsed back | **kept** — an input that round-trips, not a display |

ISO stays, per the owner's exception: the bare `{start}` / `{now}`
file-name tokens (ISO 8601 basic), `cannet.log` and the server's log
lines, the sidecar's log (parsed by `cannet-sidecar::banner`), BLF /
MDF header fields, bench run directories, dev-console `[diag]` stamps.

## Rulings (2026-10-07)

| # | Question | Ruling |
|---|---|---|
| 1 | Token language | **TR35 (Unicode LDML date patterns)** — `yyyy-MM-dd HH:mm:ss` — for the display setting **and** for the `{start:…}` / `{now:…}` template tokens. strftime goes (owner: "not as intuitive"). No legacy path: a saved template written in strftime fails to resolve with the pattern error the template preview already shows, until it is retyped. |

## Design

**The pattern.** One subset of TR35, implemented twice — in Rust for
file names (`export_template.rs`) and in TypeScript for display — and
proven identical by **one shared vector file** both test suites read
(`apps/gui/src/datePattern.vectors.json`, `include_str!` from the host
test). Letters are reserved as TR35 reserves them: a letter outside the
subset is an error, not a literal; literals are quoted `'T'`, `''` is
an apostrophe.

| Field | Tokens |
|---|---|
| year | `yyyy`, `yy` |
| month | `M`, `MM`, `MMM` (Jan), `MMMM` (January) |
| day | `d`, `dd`; `EEE` (Mon), `EEEE` (Monday) |
| hour | `H`, `HH` (0–23); `h`, `hh` (1–12) with `a` (AM/PM) |
| minute / second | `mm`, `ss` |
| fraction | `S` … `SSSSSSSSS` (1–9 digits, truncated — nanosecond captures) |
| offset | `xx` (`-0700`), `xxx` (`-07:00`), `X` / `XX` / `XXX` (`Z` at UTC) |
| zone name | `zzz` (`PDT`) — display only, via `Intl`; refused in a file-name template with the reason (the host has no zone-name table; use `xxx`) |

Names are English (TR35 root locale); the application has no locale
layer and the owner wants one predictable rendering.

**The setting.** `date_time_pattern` in `settings.json` (ADR 0034),
`Control::Text`, General surface, label *Date/time pattern*, default
`yyyy-MM-dd HH:mm:ss`, local time. The host validates on write the way
it validates `can_id_format` (an invalid pattern is refused with the
error); the control shows a live preview of *now*. The frontend reads
it with `useSetting("date_time_pattern")`; the five formatters above
collapse into one `formatCalendarTime(seconds, base, pattern)` that
still returns `null` without a wall-clock anchor (ADR 0024 rule 4).

**The templates.** `{start:yyyy-MM-dd}` replaces `{start:%Y-%m-%d}`;
the bare token stays ISO basic (`yyyyMMdd'T'HHmmssxx`). Token help
(`templateTokenHelp.tsx`), README § export templates, and the logger
panel's example text change with it.

**Dependencies.** Hand-rolled subset on both sides (technology
inventory: TR35 date patterns *adopted*, hand-rolled; `date-fns`
*rejected* — frontend only, no host parity; ICU4X *rejected* — no
pattern-string API, megabytes of locale data for one format).

## Phases

1. **The pattern, both sides (host + frontend)** — Opus. `datePattern`
   module in Rust and TS with the shared vectors; `export_template.rs`
   switches to it (strftime removed); token help, README, the inventory
   entry; an ADR for the pattern rule (one TR35 subset, two
   implementations, one vector file; the ISO exceptions). Tests: the
   vectors (every token, quoting, truncated fractions, offsets at UTC
   and ±, the error cases) on both sides; template resolution with a
   TR35 format; an old strftime template reports the error.
2. **The setting and the five displays (host + frontend)** — Sonnet.
   `date_time_pattern` end to end (`settings.rs`, descriptor,
   `hostSettings.ts`, preview in the control); the five formatters
   replaced by the one; `formatRangeBound` untouched. Tests: each site
   renders the default and a custom pattern; no anchor → nothing; an
   invalid pattern is refused on write and the stored value survives.
   ADR 0024 rule 4, CONTEXT.md (*date/time pattern*), README settings
   list.

Branch base: `fix-cursor-chip-row` (the hover this task re-formats);
`doc-closeout-2` restacked on top. Frontend-only lanes plus the Rust
lanes for phase 1 and 2's host halves.

## Exit criteria

- [ ] Every site in the survey's "follows" rows renders the pattern
      from Settings; the export From / To fields are unchanged.
- [ ] `{start:yyyy-MM-dd}` resolves; `{start:%Y-%m-%d}` reports an
      error in the preview and at write time; the bare token is still
      ISO basic.
- [ ] The Rust and TypeScript formatters pass the same vector file.
- [ ] An invalid pattern cannot be saved; the control previews the
      pattern live.
- [ ] ADR written; ADR 0024 rule 4 amended; README, CONTEXT.md and the
      technology inventory current.
- [ ] Six-row CI table per phase.

## Status

- 2026-10-07 — **Phase 1 landed** (`task165-date-pattern` c0550d9d, on
  `task160-wire-rule`). The TR35 subset is implemented twice —
  `date_pattern.rs` on the host, `datePattern.ts` on the frontend — and
  both are held to `apps/gui/src/datePattern.vectors.json` (69 format,
  20 error, 3 display-only vectors; the error messages are shared and
  exact). `export_template.rs` resolves `{start:…}` / `{now:…}` through
  it; strftime is removed. `{start:%Y-%m-%d}` fails with `"Y" is not a
  date pattern field …` in the preview and in the logger's run-path
  resolution; the bare tokens are still ISO basic
  (`yyyyMMdd'T'HHmmssxx`). `zzz` renders through `Intl` on the frontend
  and is refused on the host with a pointer to `xxx`. chrono stays for
  calendar arithmetic and `logger.rs`. Docs: ADR 0062, README § export
  templates, token help, inventory (TR35 adopted; strftime, date-fns,
  ICU4X rejected). Scoped CI: cargo-gui 1443, vitest 3857 (92 in
  `datePattern.test.ts`), clippy, fmt, rustdoc, build. `datePattern.ts`
  is not consumed yet. **Hand-off to phase 2:** the host's
  `DatePattern::parse` refuses `zzz` (file names only) — validating the
  display setting on write needs a display-mode parse that accepts it,
  with a matching vector-file field; the frontend API is
  `formatDatePattern(pattern, {seconds, nanos}, offsetMinutes,
  timeZone?)` and phase 2 supplies the local offset itself (the negation
  of `getTimezoneOffset()` at that instant).
