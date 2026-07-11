// Remembered BLF channel→bus mappings (ADR 0032 / ADR 0034).
//
// The channel↔bus dialog's last-accepted choices, persisted host-side in
// `state.json` and keyed by project id (bus ids are project-scoped).
// Per project there are two tiers: an exact by-path map, and a
// by-channel-count fallback so an unrecognized file is assumed to come
// from the same source as the last same-shaped one. These are the pure
// helpers between the dialog's `Record<number, bus_id | "">` shape and
// the persisted string-keyed maps in `hostState`.

/// One accepted mapping: channel number (JSON object key, so a string)
/// → `Bus.id`, with `""` for a deliberately skipped channel.
type StoredChannelMap = Record<string, string>;

/// Mirror of the host `ProjectBlfChannelMaps` (state.rs), keyed by
/// project id.
export type BlfChannelMaps = Record<
  string,
  {
    by_path: Record<string, StoredChannelMap>;
    by_channel_count: Record<string, StoredChannelMap>;
  }
>;

/// The stored pre-fill for opening `blfPath` with `channelCount` distinct
/// channels: the exact path entry if there is one, else the mapping last
/// accepted for a BLF with the same channel count, else `undefined`
/// (positional defaults apply). A stored bus id no longer in the project
/// degrades to `""` (unmapped) rather than leaking a dangling id into the
/// dialog.
export function savedBlfChannelMap(
  maps: BlfChannelMaps,
  projectId: string | null,
  blfPath: string,
  channelCount: number,
  validBusIds: ReadonlySet<string>,
): Record<number, string> | undefined {
  if (projectId === null) return undefined;
  const project = maps[projectId];
  const stored =
    project?.by_path[blfPath] ?? project?.by_channel_count[String(channelCount)];
  if (!stored) return undefined;
  const out: Record<number, string> = {};
  for (const [ch, busId] of Object.entries(stored)) {
    out[Number(ch)] = validBusIds.has(busId) ? busId : "";
  }
  return out;
}

/// Store an accepted mapping back, under both the exact path and the
/// file's channel count. Pure — returns a new map (or the input untouched
/// when no project is open; without a project id the mapping has nothing
/// durable to bind to).
export function recordBlfChannelMap(
  maps: BlfChannelMaps,
  projectId: string | null,
  blfPath: string,
  choices: Record<number, string>,
): BlfChannelMaps {
  if (projectId === null) return maps;
  const stored: StoredChannelMap = {};
  for (const [ch, busId] of Object.entries(choices)) stored[ch] = busId;
  const count = String(Object.keys(choices).length);
  const project = maps[projectId] ?? { by_path: {}, by_channel_count: {} };
  return {
    ...maps,
    [projectId]: {
      by_path: { ...project.by_path, [blfPath]: stored },
      by_channel_count: { ...project.by_channel_count, [count]: stored },
    },
  };
}
