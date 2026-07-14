/// Pure helpers for re-resolving a project's interface bindings
/// against the channels actually attached to a server. Extracted from
/// the connect flow in `App.tsx` so the matching rules are
/// unit-testable without React or a live sidecar.
///
/// Why this exists: bindings persist the full channel id string
/// (e.g. `pcan:PCAN_USBBUS2(h:0x52, ch:0, uid:255)`), but parts of
/// that id are positional — PCAN slot names and handles shift with
/// USB port / plug order. An exact-string match against a stale slot
/// silently subscribes to nothing. The channel id grammar (see the
/// sidecar's `Channel` rustdoc/pydoc) deliberately carries stable
/// identity metadata (PCAN's user-settable `uid:` device id and
/// controller number, Vector/Kvaser serials) so a moved device can be
/// recognised on its new slot.

/// A channel id split into its grammar parts:
/// `<vendor>:<body>(<key:value>, …)`.
export interface ChannelIdParts {
  vendor: string;
  body: string;
  meta: Record<string, string>;
}

/// Parse a wire channel id. Returns `null` when the string has no
/// `vendor:` prefix. Metadata parens are optional; a missing or
/// malformed paren group yields an empty `meta`.
export function parseChannelId(id: string): ChannelIdParts | null {
  const colon = id.indexOf(":");
  if (colon <= 0) return null;
  const vendor = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  const open = rest.lastIndexOf("(");
  if (open < 0 || !rest.endsWith(")")) {
    return { vendor, body: rest, meta: {} };
  }
  const body = rest.slice(0, open).trimEnd();
  const meta: Record<string, string> = {};
  for (const pair of rest.slice(open + 1, -1).split(",")) {
    const sep = pair.indexOf(":");
    if (sep <= 0) continue;
    meta[pair.slice(0, sep).trim()] = pair.slice(sep + 1).trim();
  }
  return { vendor, body, meta };
}

/// Metadata keys that are positional rather than identity: PCAN's
/// `h:` handle tracks the slot, not the device, so it must not count
/// toward an identity match.
const POSITIONAL_META_KEYS = new Set(["h"]);

/// The identity of a channel: its vendor plus every non-positional
/// metadata entry, as a comparable string. `null` when the id is
/// unparseable or carries no identity metadata at all (nothing safe
/// to match on).
function channelIdentity(id: string): string | null {
  const parts = parseChannelId(id);
  if (parts === null) return null;
  const keys = Object.keys(parts.meta)
    .filter((k) => !POSITIONAL_META_KEYS.has(k))
    .sort();
  if (keys.length === 0) return null;
  return `${parts.vendor}|${keys.map((k) => `${k}:${parts.meta[k]}`).join("|")}`;
}

/// Outcome of checking one bound interface id against the attached
/// channel list.
export type BindingResolution =
  | { kind: "attached" }
  | { kind: "rebound"; interface: string }
  | { kind: "missing" };

/// Check `bound` against `attached` (the channel ids a server
/// currently enumerates). Exact match wins; otherwise a channel with
/// the same identity (vendor + non-positional metadata) is accepted
/// as the same device on a different slot — but only when exactly one
/// attached channel matches, so two adapters on the factory-default
/// device id never get rebound by guesswork.
export function resolveBindingInterface(
  bound: string,
  attached: readonly string[],
): BindingResolution {
  if (attached.includes(bound)) return { kind: "attached" };
  const identity = channelIdentity(bound);
  if (identity === null) return { kind: "missing" };
  const matches = attached.filter((id) => channelIdentity(id) === identity);
  if (matches.length === 1) return { kind: "rebound", interface: matches[0] };
  return { kind: "missing" };
}
