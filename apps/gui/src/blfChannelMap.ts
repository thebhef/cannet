// Remembered BLF channel→bus mappings (ADR 0032 / ADR 0034 / ADR 0042).
//
// The channel↔bus dialog's last-accepted choices, persisted host-side in
// the project's own `.cannet/state.json`. Two tiers: an exact by-path
// map, and a by-channel-count fallback so an unrecognized file is assumed
// to come from the same source as the last same-shaped one. These are the
// pure helpers between the dialog's `Record<number, bus_id | "">` shape
// and the persisted string-keyed maps in `hostState`.
//
// There is no project-id key: the mappings live in the project directory,
// so the directory *is* the scoping (ADR 0042) — and since every session
// has one, there is no "no project to bind this to" case to handle.

/// One accepted mapping: channel number (JSON object key, so a string)
/// → `Bus.id`, with `""` for a deliberately skipped channel.
type StoredChannelMap = Record<string, string>;

/// Mirror of the host `BlfChannelMaps` (state.rs) — one project's
/// remembered mappings.
export interface BlfChannelMaps {
  by_path: Record<string, StoredChannelMap>;
  by_channel_count: Record<string, StoredChannelMap>;
}

/// An empty set of mappings — a project that has never mapped a BLF.
export function emptyBlfChannelMaps(): BlfChannelMaps {
  return { by_path: {}, by_channel_count: {} };
}

/// The stored pre-fill for opening `blfPath` with `channelCount` distinct
/// channels: the exact path entry if there is one, else the mapping last
/// accepted for a BLF with the same channel count, else `undefined`
/// (positional defaults apply). A stored bus id no longer in the project
/// degrades to `""` (unmapped) rather than leaking a dangling id into the
/// dialog.
export function savedBlfChannelMap(
  maps: BlfChannelMaps,
  blfPath: string,
  channelCount: number,
  validBusIds: ReadonlySet<string>,
): Record<number, string> | undefined {
  const stored =
    maps.by_path?.[blfPath] ?? maps.by_channel_count?.[String(channelCount)];
  if (!stored) return undefined;
  const out: Record<number, string> = {};
  for (const [ch, busId] of Object.entries(stored)) {
    out[Number(ch)] = validBusIds.has(busId) ? busId : "";
  }
  return out;
}

/// Store an accepted mapping back, under both the exact path and the
/// file's channel count. Pure — returns a new map.
export function recordBlfChannelMap(
  maps: BlfChannelMaps,
  blfPath: string,
  choices: Record<number, string>,
): BlfChannelMaps {
  const stored: StoredChannelMap = {};
  for (const [ch, busId] of Object.entries(choices)) stored[ch] = busId;
  const count = String(Object.keys(choices).length);
  return {
    by_path: { ...maps.by_path, [blfPath]: stored },
    by_channel_count: { ...maps.by_channel_count, [count]: stored },
  };
}
