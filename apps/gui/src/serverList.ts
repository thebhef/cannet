// The merged server list — a view over the host's model, never a
// source of truth.
//
// The host owns the browse (`server_browse.rs`), the trust store
// (`server_trust.rs`, ADR 0032), and the join between them
// (`server_list.rs`). This module subscribes to the merged snapshot and
// filters it for display. It does not decide what a server is, whether
// it is trusted, or whether the identity it presented is the pinned
// one — those are model facts, and re-deriving any of them here would
// be a second authority.

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Fzf } from "fzf";

import type { TrustPrompt } from "./serverTrust";

/// Tauri event the host fires whenever the merged list moves. Must
/// match `server_list::SERVER_LIST_CHANGED_EVENT` host-side.
export const SERVER_LIST_CHANGED_EVENT = "server-list-changed";

/// Where one server stands with this machine. Mirrors the host's
/// `server_list::TrustState`.
export type TrustState = "new" | "trusted" | "fingerprintChanged";

/// What the browse task reports about itself. Mirrors the host's
/// `server_browse::BrowseStatus` — the difference between "nothing is
/// advertising" and "nothing is listening for advertisements", which
/// an empty list alone cannot express.
export type BrowseStatus =
  /// The daemon has not answered yet.
  | { state: "starting" }
  /// Browsing. An empty list means an empty subnet.
  | { state: "running" }
  /// The daemon or the browse refused to start — a socket that could
  /// not be bound. No discovery will happen at all.
  | { state: "failed"; detail: string }
  /// Running, but the daemon reported an error while it ran; an empty
  /// list under this is suspect rather than informative.
  | { state: "degraded"; detail: string }
  /// The daemon's event stream ended.
  | { state: "stopped" };

/// One server as the panel renders it. Mirrors the host's
/// `server_list::ServerRow`. The stored token is deliberately not here.
export interface ServerRow {
  /// Normalized `host:port` — the row's identity, its React key, and
  /// the argument every action takes.
  address: string;
  /// DNS-SD instance name. `null` for a row that only exists because
  /// something was accepted for it.
  name: string | null;
  /// The machine the server runs on, from the SRV target host.
  host: string | null;
  /// The server's release, from its `ver` TXT key.
  version: string | null;
  /// Whether the server is advertising right now.
  online: boolean;
  trust: TrustState;
  fingerprint: string | null;
  hasToken: boolean;
  insecure: boolean;
  /// The operator put this address in the list by hand. Not a trust
  /// decision — only what keeps a server nothing advertises in the list.
  manual: boolean;
  /// The question the host is waiting on for this server, if any.
  prompt: TrustPrompt | null;
  /// This server's measured clock offset for the live session against
  /// it. `null` for an unconnected server, a peer that doesn't support
  /// the probe, or a session whose first measurement hasn't settled
  /// yet — all of which render as no badge, never an error.
  clock: ServerClock | null;
}

export interface ServerList {
  servers: ServerRow[];
  browse: BrowseStatus;
}

/// The measured clock offset for the live session against a server.
/// Mirrors the host's `server_list::ServerClock`. `warn` and `stale`
/// are the host's own read of the record — not re-derived here.
export interface ServerClock {
  /// The server's clock minus ours, nanoseconds. Positive means the
  /// server is ahead.
  offsetNs: number;
  /// Set when the offset's magnitude exceeds the host's warn threshold.
  warn: boolean;
  /// Set when the measurement is stale: the peer answered before but
  /// has gone quiet on the re-probe cadence, so this is the last good
  /// number rather than a fresh one.
  stale: boolean;
}

/// `offsetNs` as the short figure a row shows: sub-second in
/// milliseconds, a second or more in seconds — signed, so "ahead" and
/// "behind" read at a glance (e.g. `"+4.2 s"`, `"-42 ms"`).
export function formatClockOffset(offsetNs: number): string {
  const ms = offsetNs / 1_000_000;
  const sign = ms >= 0 ? "+" : "-";
  const abs = Math.abs(ms);
  return abs >= 1000 ? `${sign}${(abs / 1000).toFixed(1)} s` : `${sign}${abs.toFixed(0)} ms`;
}

/// The starting snapshot, before the host has answered: no servers, and
/// a browse whose state is genuinely not known yet.
export const EMPTY_SERVER_LIST: ServerList = {
  servers: [],
  browse: { state: "starting" },
};

/// Subscribe to the host's merged server list. Same pull-then-follow
/// shape as the trust prompts and the interface cache (ADR 0016): one
/// snapshot on mount, then the change event. The payload is the whole
/// list, bounded by the servers on the subnet plus the ones this
/// machine has accepted.
export function useServerList(): ServerList {
  const [list, setList] = useState<ServerList>(EMPTY_SERVER_LIST);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;

    void (async () => {
      try {
        const initial = await invoke<ServerList>("get_server_list");
        if (!cancelled && Array.isArray(initial?.servers)) setList(initial);
      } catch {
        // Host without the command (older build, dev shell): fall
        // through to the listener and stay empty if none comes.
      }
      try {
        unlisten = await listen<ServerList>(SERVER_LIST_CHANGED_EVENT, (e) => {
          if (!cancelled && Array.isArray(e.payload?.servers)) setList(e.payload);
        });
      } catch {
        // Same fallback: stay on whatever snapshot we have.
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  return list;
}

/// The identity the host files a server under: the address without a
/// `scheme://`, lower-cased. Mirrors `server_trust::server_key`, so a
/// binding's spelling of an address finds the row the host keyed by it.
export function serverKey(address: string): string {
  const i = address.indexOf("://");
  return (i < 0 ? address : address.slice(i + 3)).toLowerCase();
}

/// Whether `input` looks like a server address, as the complaint when it
/// does not.
///
/// A typo guard in front of the field and nothing more. The host checks
/// the address again in `add_server` and its answer is the one that
/// decides — this only spares a round trip on an empty box, a missing
/// port, or an IPv6 literal written without its brackets.
export function addressShapeError(input: string): string | null {
  const trimmed = input.trim();
  const shape = "A server address is host:port, for example bench.local:50051.";
  if (trimmed === "") return `Enter the server's address. ${shape}`;
  const match = /^(\[[^\]]+\]|[^:[\]\s]+):(\d+)$/.exec(serverKey(trimmed));
  if (match === null) return `"${trimmed}" is not an address. ${shape}`;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) {
    return `"${match[2]}" is not a port number. ${shape}`;
  }
  return null;
}

/// How a server is named where it is picked from: the instance name it
/// advertises, or its address when nothing has answered to name it.
export function serverLabel(row: ServerRow): string {
  return row.name ?? row.address;
}

/// How each of `rows` is named where servers are picked from, keyed by
/// address — {@link serverLabel}, made distinct.
///
/// Two servers may advertise the same instance name, and where the name
/// is all a surface shows (a combo's group header), that leaves a
/// choice nobody can make correctly: picking an interface under the
/// wrong one binds a bus to another machine. So a name that more than
/// one server answers to carries what tells them apart — the machine it
/// runs on, and its address when even that is shared. The address is
/// the row's identity, so the fallback always separates them.
///
/// A row nothing advertises is already named by its address and is left
/// alone.
export function serverLabels(
  rows: readonly ServerRow[],
): ReadonlyMap<string, string> {
  const tally = (key: (row: ServerRow) => string) => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
    return (row: ServerRow) => (counts.get(key(row)) ?? 0) > 1;
  };
  // A newline separates the fields, because no name or host name can
  // contain one — so two rows can never collide by running theirs
  // together.
  const nameShared = tally(serverLabel);
  const hostShared = tally((row) => `${serverLabel(row)}\n${row.host ?? ""}`);
  const labels = new Map<string, string>();
  for (const row of rows) {
    const base = serverLabel(row);
    if (!nameShared(row)) {
      labels.set(row.address, base);
      continue;
    }
    const apart = row.host !== null && !hostShared(row) ? row.host : row.address;
    labels.set(row.address, `${base} (${apart})`);
  }
  return labels;
}

/// The servers a bus can be bound to: the ones the host reaches without
/// stopping to ask (ADR 0041). A server that is only *discovered* is
/// not one of them — it is trusted in the Servers panel first, which is
/// where that decision belongs.
export function trustedServers(rows: readonly ServerRow[]): ServerRow[] {
  return rows.filter((r) => r.trust === "trusted");
}

/// Which of `addresses` the host cannot reach without an answer from
/// the user. The host decides — the trust store and the address rules
/// that make a loopback proxy plaintext are both its, and a view that
/// guessed at either would be a second authority.
///
/// Re-asked whenever the address set changes and whenever the merged
/// list moves, which is what a trust write does.
export function useAddressesNeedingTrust(
  addresses: readonly string[],
): ReadonlySet<string> {
  const [needing, setNeeding] = useState<ReadonlySet<string>>(() => new Set());
  // Stable shape of the address set, so the subscription effect doesn't
  // tear down on every render.
  const key = useMemo(() => [...addresses].sort().join("|"), [addresses]);
  const latest = useRef(addresses);
  latest.current = addresses;

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;

    const ask = async () => {
      const list = [...latest.current];
      if (list.length === 0) {
        setNeeding(new Set());
        return;
      }
      try {
        const answer = await invoke<string[]>("addresses_needing_trust", {
          addresses: list,
        });
        if (!cancelled && Array.isArray(answer)) setNeeding(new Set(answer));
      } catch {
        // Host without the command (older build, dev shell): nothing is
        // flagged, which is the pre-existing behaviour.
      }
    };

    void (async () => {
      await ask();
      try {
        unlisten = await listen(SERVER_LIST_CHANGED_EVENT, () => {
          void ask();
        });
      } catch {
        // Same fallback: stay on the answer we have.
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [key]);

  return needing;
}

/// What a query is matched against: everything that identifies the
/// machine — its instance name, its host name, and its address. Not the
/// version, which is a readout rather than something a server is sought
/// out by, and not the trust badge, which the row already sorts by.
function haystack(row: ServerRow): string {
  return [row.name, row.host, row.address].filter((s) => s !== null).join(" ");
}

/// Filter the merged list with the same fzf matcher the rest of the GUI
/// searches with. An empty query returns the list untouched, in the
/// order the host sorted it — the rows must not reshuffle as resolves
/// arrive.
export function matchServerRows(
  rows: readonly ServerRow[],
  query: string,
): ServerRow[] {
  const trimmed = query.trim();
  if (trimmed === "") return [...rows];
  const fzf = new Fzf<readonly ServerRow[]>(rows, {
    selector: haystack,
    casing: "case-insensitive",
  });
  return fzf.find(trimmed).map((r) => r.item);
}

/// The badge one row wears. The host decides the state; this is only
/// its wording.
export function trustLabel(row: ServerRow): string {
  switch (row.trust) {
    case "trusted":
      return row.insecure ? "unprotected" : "trusted";
    case "fingerprintChanged":
      return "identity changed";
    case "new":
      return "new";
  }
}

/// What a *Forget* left to say when the trust store held nothing for the
/// row — `null` when it held something, which is the ordinary case and
/// needs no explanation.
///
/// A row the store does not hold is held by one of the merge's other two
/// sources, and the row itself says which: it is advertising, or a
/// session is connected to it (an entry the store keeps is never empty —
/// the host removes an emptied one — so there is no third case). Without
/// this, forgetting such a row is a button that does nothing, which is
/// how the app's own sidecar — dialled at `127.0.0.1:<ephemeral>` for
/// local hardware, stored nowhere — reads as an unremovable mystery.
export function nothingStoredNote(row: ServerRow): string | null {
  if (row.fingerprint !== null || row.hasToken || row.insecure || row.manual) {
    return null;
  }
  const why = row.online
    ? "it is advertising on this network"
    : "a session is connected to it, and it leaves the list when that session ends";
  return `Nothing was stored for ${row.address} — ${why}.`;
}

/// What the panel says when the list is empty, given what the browse
/// task reported. Never inferred from the list being empty — every
/// branch here is a state the host observed.
export function browseNotice(browse: BrowseStatus): string | null {
  switch (browse.state) {
    case "starting":
      return "Looking for servers on this network…";
    case "running":
      return null;
    case "failed":
      return `Discovery is not running — the mDNS browser could not start (${browse.detail}). Only servers already accepted on this machine are listed.`;
    case "degraded":
      return `Discovery may be blocked — the mDNS browser reported an error (${browse.detail}). Check that UDP 5353 is allowed inbound, and on macOS that cannet is permitted to find devices on the local network.`;
    case "stopped":
      return "Discovery has stopped. Restart cannet to browse again.";
  }
}

/// What an empty list means under a browse that is running normally:
/// genuinely nothing on this subnet — and nothing accepted here
/// either, so no bus has a server to bind to yet.
export const NOTHING_ADVERTISING =
  "No servers are advertising on this network, and none have been accepted on this machine. Discovery is multicast, so a server on another subnet — or one started --no-mdns — never advertises anywhere this machine can hear: add it by address.";
