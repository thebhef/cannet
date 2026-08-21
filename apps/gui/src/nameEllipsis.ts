/**
 * Where a long entity name is split so the *middle* of it is what an
 * over-narrow column drops.
 *
 * DBC symbols share prefixes by construction —
 * `BmsPackCurrentFilteredHighRes` and `BmsPackCurrentFilteredLowRes`
 * differ only at the end — so plain end-truncation reliably hides the
 * one part that tells two names apart. Splitting the name into a
 * shrinkable head and a fixed tail, and letting only the head
 * ellipsize, keeps both ends visible: `BmsPackCurrentF…HighRes`.
 *
 * Enum labels are excluded on purpose. They are prose, read left to
 * right, and their distinguishing word is at the front — those keep
 * ordinary end-ellipsis.
 */

/**
 * The classic DBC format's identifier limit. A name at or under it can
 * be shown in the width every column was designed around, so it is
 * left as a single text node and nothing here applies; past it, the
 * name only exists because of the long-symbol extension, which is
 * exactly the case this treatment is for.
 */
export const DBC_IDENTIFIER_LIMIT = 32;

/** Characters the tail keeps, before the word-boundary search below. */
const TAIL_CHARS = 10;
/** The furthest back that search will move the split. */
const TAIL_MAX_CHARS = 16;

/** Whether `name[i]` starts a word — an underscore, a digit, or a
 * capital following a non-capital, which is where CamelCase divides. */
function startsWord(name: string, i: number): boolean {
  const c = name[i];
  if (c === "_") return true;
  const prev = name[i - 1] ?? "";
  if (c >= "0" && c <= "9") return !(prev >= "0" && prev <= "9");
  return c >= "A" && c <= "Z" && !(prev >= "A" && prev <= "Z");
}

/**
 * Split `name` into the head an over-narrow column ellipsizes and the
 * tail it always keeps. A name of `DBC_IDENTIFIER_LIMIT` characters or
 * fewer gets an empty tail, meaning "render it as one string".
 *
 * The split lands on a word boundary where there is one within a few
 * characters of `TAIL_CHARS`, so the tail reads as `…Temperature`
 * rather than `…emperature`; failing that it falls back to a plain
 * character count, which is still a tail.
 */
export function splitName(name: string): { head: string; tail: string } {
  if (name.length <= DBC_IDENTIFIER_LIMIT) return { head: name, tail: "" };
  const preferred = name.length - TAIL_CHARS;
  const floor = Math.max(1, name.length - TAIL_MAX_CHARS);
  for (let i = preferred; i >= floor; i--) {
    if (startsWord(name, i)) return { head: name.slice(0, i), tail: name.slice(i) };
  }
  return { head: name.slice(0, preferred), tail: name.slice(preferred) };
}
