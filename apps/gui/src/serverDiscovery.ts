// The browsed-server list — a view over the host's mDNS browse, never
// a source of truth.
//
// The Tauri host runs the `_cannet._tcp` browse and owns the list
// (`server_browse.rs`, ADR 0040). This module subscribes to it and
// filters it for display; it does not poll, merge announcements, or
// decide what a server is. Discovery is convenience only — an entry
// here is an address the user could equally have typed, and what
// happens when it is selected is the connect path's decision
// (ADR 0041).

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Fzf } from "fzf";

/// Tauri event the host fires whenever the browsed-server list moves.
/// Must match `server_browse::DISCOVERED_SERVERS_CHANGED_EVENT`
/// host-side.
export const DISCOVERED_SERVERS_CHANGED_EVENT = "discovered-servers-changed";

/// One server advertising itself on this subnet. Mirrors the host's
/// `server_browse::DiscoveredServer`.
export interface DiscoveredServer {
  /// DNS-SD fullname — the host's key for the instance, and this row's
  /// React key.
  fullname: string;
  /// The instance name the server was started with.
  name: string;
  /// `host:port`, handed to the connect path verbatim.
  address: string;
  /// The server's release version, from its `ver` TXT key.
  version: string | null;
}

/// Subscribe to the host's browsed-server list. Same pull-then-follow
/// shape as the trust prompts and the interface cache (ADR 0016): one
/// snapshot on mount, then the change event. The payload is the whole
/// list, bounded by the servers on the subnet.
export function useDiscoveredServers(): DiscoveredServer[] {
  const [servers, setServers] = useState<DiscoveredServer[]>([]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;

    void (async () => {
      try {
        const initial = await invoke<DiscoveredServer[]>("get_discovered_servers");
        if (!cancelled && Array.isArray(initial)) setServers(initial);
      } catch {
        // Host without the command (older build, dev shell): fall
        // through to the listener and stay empty if none comes.
      }
      try {
        unlisten = await listen<DiscoveredServer[]>(
          DISCOVERED_SERVERS_CHANGED_EVENT,
          (e) => {
            if (!cancelled) setServers(e.payload ?? []);
          },
        );
      } catch {
        // Same fallback: stay on whatever snapshot we have.
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  return servers;
}

/// What a query is matched against: the instance name and the address.
/// Not the version — it is a readout for the user, not something they
/// would search a server out by, and including it would have "0.8"
/// match every server on the same release.
function haystack(server: DiscoveredServer): string {
  return `${server.name} ${server.address}`;
}

/// Filter the browsed list with the same fzf matcher the rest of the
/// GUI searches with. An empty query returns the list untouched, in
/// the order the host sorted it — the rows must not reshuffle as
/// resolves arrive.
export function matchDiscoveredServers(
  servers: readonly DiscoveredServer[],
  query: string,
): DiscoveredServer[] {
  const trimmed = query.trim();
  if (trimmed === "") return [...servers];
  const fzf = new Fzf<readonly DiscoveredServer[]>(servers, {
    selector: haystack,
    casing: "case-insensitive",
  });
  return fzf.find(trimmed).map((r) => r.item);
}
