// Date patterns: the one subset of TR35 (Unicode LDML date format
// patterns) the application speaks wherever a user writes a calendar
// time format — `yyyy-MM-dd HH:mm:ss` (ADR 0062).
//
// The subset is implemented twice: here, for display, and in the host's
// `date_pattern.rs`, for file names (the `{start:…}` / `{now:…}` template
// tokens). Both test suites read `datePattern.vectors.json`, so the two
// cannot drift — the error messages included. The one difference is the
// zone name `zzz`, which only this side renders (through `Intl`); the
// host has no zone-name table and refuses it.
//
// Letters are reserved as TR35 reserves them: an ASCII letter outside
// the subset is an error, never a literal. Literal text is quoted
// (`'T'`); `''` is an apostrophe. Names are English (TR35 root locale).

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/// Sunday first, matching `Date.prototype.getUTCDay`.
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const UNTERMINATED_QUOTE = "unterminated quote — close it with ', or write '' for an apostrophe";

/// The widths each subset letter accepts — what the error lists, and
/// which runs parse.
const WIDTHS: Record<string, { widths: number[]; hint: string }> = {
  y: { widths: [2, 4], hint: "yy or yyyy" },
  M: { widths: [1, 2, 3, 4], hint: "M, MM, MMM or MMMM" },
  d: { widths: [1, 2], hint: "d or dd" },
  E: { widths: [3, 4], hint: "EEE or EEEE" },
  H: { widths: [1, 2], hint: "H or HH" },
  h: { widths: [1, 2], hint: "h or hh" },
  a: { widths: [1], hint: "a" },
  m: { widths: [2], hint: "mm" },
  s: { widths: [2], hint: "ss" },
  S: { widths: [1, 2, 3, 4, 5, 6, 7, 8, 9], hint: "S to SSSSSSSSS" },
  x: { widths: [2, 3], hint: "xx or xxx" },
  X: { widths: [1, 2, 3], hint: "X, XX or XXX" },
  z: { widths: [3], hint: "zzz" },
};

type Item = { literal: string } | { letter: string; width: number };

/// A parsed date pattern, ready to format any number of instants.
export interface DatePattern {
  readonly items: readonly Item[];
}

/// An instant: whole Unix-epoch seconds plus nanoseconds, so a
/// nanosecond capture's fraction survives (a `number` of epoch seconds
/// keeps only ~0.1 µs).
export interface Instant {
  seconds: number;
  nanos: number;
}

/// Parse `pattern`, or say what is wrong with it. The first problem,
/// reading left to right, is the one reported.
export function parseDatePattern(pattern: string): DatePattern | { error: string } {
  if (pattern === "") return { error: "a date pattern must not be empty" };
  const chars = Array.from(pattern);
  const items: Item[] = [];
  let literal = "";
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === "'") {
      if (chars[i + 1] === "'") {
        literal += "'";
        i += 2;
        continue;
      }
      // A quoted run: up to the closing quote, `''` inside it being an
      // apostrophe.
      i += 1;
      for (;;) {
        if (i >= chars.length) return { error: UNTERMINATED_QUOTE };
        if (chars[i] === "'" && chars[i + 1] === "'") {
          literal += "'";
          i += 2;
        } else if (chars[i] === "'") {
          i += 1;
          break;
        } else {
          literal += chars[i];
          i += 1;
        }
      }
    } else if (/^[A-Za-z]$/.test(c)) {
      let width = 0;
      while (chars[i + width] === c) width += 1;
      const spec = WIDTHS[c];
      if (spec === undefined) {
        return {
          error: `"${c}" is not a date pattern field — letters are reserved; quote literal text, e.g. 'T'`,
        };
      }
      if (!spec.widths.includes(width)) {
        return { error: `"${c.repeat(width)}" is not a supported width — use ${spec.hint}` };
      }
      if (literal !== "") {
        items.push({ literal });
        literal = "";
      }
      items.push({ letter: c, width });
      i += width;
    } else {
      literal += c;
      i += 1;
    }
  }
  if (literal !== "") items.push({ literal });
  return { items };
}

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/// `±HH`, then the minutes — `:MM` when `colon`, `MM` otherwise —
/// unless `alwaysMinutes` is false and they are zero.
function offset(offsetMinutes: number, colon: boolean, alwaysMinutes: boolean): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const h = pad(Math.floor(abs / 60), 2);
  const m = abs % 60;
  if (!alwaysMinutes && m === 0) return `${sign}${h}`;
  return `${sign}${h}${colon ? ":" : ""}${pad(m, 2)}`;
}

/// The zone's short name at `instant` (`PDT`), from `Intl` in English.
/// `timeZone` is an IANA name; `undefined` is the machine's own zone.
function zoneName(instant: Instant, timeZone: string | undefined): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(
    new Date(instant.seconds * 1000),
  );
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
}

/// `instant` rendered per `pattern` at `offsetMinutes` east of UTC.
/// `timeZone` names the zone `zzz` renders (IANA; the machine's own
/// when omitted) — it must be the zone `offsetMinutes` was read from.
export function formatDatePattern(
  pattern: DatePattern,
  instant: Instant,
  offsetMinutes: number,
  timeZone?: string,
): string {
  // The wall-clock fields at that offset, read as if they were UTC.
  const local = new Date((instant.seconds + offsetMinutes * 60) * 1000);
  const year = local.getUTCFullYear();
  const month0 = local.getUTCMonth();
  const day = local.getUTCDate();
  const hour = local.getUTCHours();
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const weekday = WEEKDAYS[local.getUTCDay()];
  let out = "";
  for (const item of pattern.items) {
    if ("literal" in item) {
      out += item.literal;
      continue;
    }
    const w = item.width;
    switch (item.letter) {
      case "y":
        out += w === 4 ? pad(year, 4) : pad(((year % 100) + 100) % 100, 2);
        break;
      case "M":
        out +=
          w === 1
            ? String(month0 + 1)
            : w === 2
              ? pad(month0 + 1, 2)
              : w === 3
                ? MONTHS[month0].slice(0, 3)
                : MONTHS[month0];
        break;
      case "d":
        out += w === 1 ? String(day) : pad(day, 2);
        break;
      case "E":
        out += w === 3 ? weekday.slice(0, 3) : weekday;
        break;
      case "H":
        out += w === 1 ? String(hour) : pad(hour, 2);
        break;
      case "h":
        out += w === 1 ? String(hour12) : pad(hour12, 2);
        break;
      case "a":
        out += hour < 12 ? "AM" : "PM";
        break;
      case "m":
        out += pad(local.getUTCMinutes(), 2);
        break;
      case "s":
        out += pad(local.getUTCSeconds(), 2);
        break;
      case "S":
        out += pad(instant.nanos, 9).slice(0, w);
        break;
      case "x":
        out += offset(offsetMinutes, w === 3, true);
        break;
      case "X":
        out += offsetMinutes === 0 ? "Z" : offset(offsetMinutes, w === 3, w > 1);
        break;
      case "z":
        out += zoneName(instant, timeZone);
        break;
    }
  }
  return out;
}
