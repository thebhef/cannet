// Shared most-recently-used list push.
//
// The recent-BLFs and recent-commands lists (ADR 0032) are both a
// bounded MRU: a value moves to the front, dedupes against the rest,
// and the tail is capped. Only the cap differs, so the push lives here.

/// Pure MRU push: prepend `value` to `current`, dedupe against the
/// previous list, cap at `limit`. A `limit` of zero remembers nothing —
/// which is what every setting feeding this cap documents zero to mean.
/// Empty values are dropped (defensive against an accidental empty
/// string). Returns a fresh array.
export function pushRecent(
  current: readonly string[],
  value: string,
  limit: number,
): string[] {
  if (limit <= 0) return [];
  if (!value) return [...current];
  const out: string[] = [value];
  for (const v of current) {
    if (v === value) continue;
    if (out.length >= limit) break;
    out.push(v);
  }
  return out;
}
