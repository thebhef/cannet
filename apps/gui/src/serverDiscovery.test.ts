import { describe, expect, it } from "vitest";

import { matchDiscoveredServers } from "./serverDiscovery";
import type { DiscoveredServer } from "./serverDiscovery";

const server = (
  name: string,
  address: string,
  version: string | null = "v0.8.1",
): DiscoveredServer => ({
  fullname: `${name}._cannet._tcp.local.`,
  name,
  host: `${name}.local`,
  address,
  version,
});

const SERVERS: DiscoveredServer[] = [
  server("bench-rig", "192.168.1.10:50051"),
  server("dyno-cell", "192.168.1.44:50051"),
  server("RIPPY", "10.0.0.7:50051"),
];

describe("filtering the browsed-server list", () => {
  it("shows every server, in the host's order, until something is typed", () => {
    // The host sorts the list; the view does not re-sort it, so the
    // rows don't reshuffle as resolves arrive.
    expect(matchDiscoveredServers(SERVERS, "").map((s) => s.name)).toEqual([
      "bench-rig",
      "dyno-cell",
      "RIPPY",
    ]);
    expect(matchDiscoveredServers(SERVERS, "   ")).toHaveLength(3);
  });

  it("matches a subsequence of the instance name", () => {
    expect(matchDiscoveredServers(SERVERS, "bnchrg").map((s) => s.name)).toEqual([
      "bench-rig",
    ]);
  });

  it("matches on the address, so a known subnet finds the server", () => {
    expect(matchDiscoveredServers(SERVERS, "10.0.0").map((s) => s.name)).toEqual([
      "RIPPY",
    ]);
  });

  it("ignores case, so a hostname in caps is reachable in lower case", () => {
    expect(matchDiscoveredServers(SERVERS, "rippy").map((s) => s.name)).toEqual([
      "RIPPY",
    ]);
  });

  it("returns nothing when the query matches nothing", () => {
    expect(matchDiscoveredServers(SERVERS, "zzzz")).toEqual([]);
  });

  it("does not search the version, which is a readout and not an identity", () => {
    expect(matchDiscoveredServers(SERVERS, "v0.8.1")).toEqual([]);
  });
});
