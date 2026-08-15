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

import { useEffect, useState } from "react";
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
  /// The question the host is waiting on for this server, if any.
  prompt: TrustPrompt | null;
}

export interface ServerList {
  servers: ServerRow[];
  browse: BrowseStatus;
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
        if (!cancelled && initial) setList(initial);
      } catch {
        // Host without the command (older build, dev shell): fall
        // through to the listener and stay empty if none comes.
      }
      try {
        unlisten = await listen<ServerList>(SERVER_LIST_CHANGED_EVENT, (e) => {
          if (!cancelled && e.payload) setList(e.payload);
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
      return `Discovery is not running — the mDNS browser could not start (${browse.detail}). Servers can still be reached by typing their address.`;
    case "degraded":
      return `Discovery may be blocked — the mDNS browser reported an error (${browse.detail}). Check that UDP 5353 is allowed inbound, and on macOS that cannet is permitted to find devices on the local network.`;
    case "stopped":
      return "Discovery has stopped. Restart cannet to browse again.";
  }
}

/// What an empty list means under a browse that is running normally:
/// genuinely nothing on this subnet, which a typed address still
/// reaches.
export const NOTHING_ADVERTISING =
  "No servers are advertising on this network, and none have been accepted on this machine. A server on another subnet won't appear here — reach it by typing its address on a bus.";
