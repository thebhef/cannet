import { describe, expect, it } from "vitest";

import {
  browseNotice,
  matchServerRows,
  serverLabel,
  trustLabel,
  trustedServers,
  type ServerRow,
} from "./serverList";

const row = (over: Partial<ServerRow>): ServerRow => ({
  address: "192.168.1.10:50051",
  name: "bench-rig",
  host: "bench-rig.local",
  version: "v0.8.1",
  online: true,
  trust: "new",
  fingerprint: null,
  hasToken: false,
  insecure: false,
  prompt: null,
  ...over,
});

const ROWS: ServerRow[] = [
  row({}),
  row({ address: "192.168.1.44:50051", name: "dyno-cell", host: "dyno-cell.local" }),
  row({
    address: "bench.example.com:50051",
    name: null,
    host: null,
    version: null,
    online: false,
    trust: "trusted",
    fingerprint: "SHA256:aaa",
  }),
];

describe("filtering the merged server list", () => {
  it("shows every row, in the host's order, until something is typed", () => {
    // The host sorts the list; the view does not re-sort it, so the
    // rows don't reshuffle as resolves arrive.
    expect(matchServerRows(ROWS, "").map((r) => r.address)).toEqual(
      ROWS.map((r) => r.address),
    );
    expect(matchServerRows(ROWS, "   ")).toHaveLength(3);
  });

  it("matches a subsequence of the instance name", () => {
    expect(matchServerRows(ROWS, "dyno").map((r) => r.name)).toEqual(["dyno-cell"]);
  });

  it("matches the host name, which is how two servers named alike are told apart", () => {
    const alike = [
      row({ address: "10.0.0.1:50051", name: "proxy", host: "bench.local" }),
      row({ address: "10.0.0.2:50051", name: "proxy", host: "spare.local" }),
    ];
    expect(matchServerRows(alike, "spare").map((r) => r.address)).toEqual([
      "10.0.0.2:50051",
    ]);
  });

  it("matches the address, including a row that has nothing else to match on", () => {
    expect(matchServerRows(ROWS, "example").map((r) => r.address)).toEqual([
      "bench.example.com:50051",
    ]);
  });

  it("does not match the version, which every server on a release shares", () => {
    expect(matchServerRows(ROWS, "v0.8.1")).toHaveLength(0);
  });
});

describe("the badge wording", () => {
  it("names each state the host reported", () => {
    expect(trustLabel(row({ trust: "new" }))).toBe("new");
    expect(trustLabel(row({ trust: "trusted" }))).toBe("trusted");
    expect(trustLabel(row({ trust: "fingerprintChanged" }))).toBe("identity changed");
  });

  it("says a trusted-but-unprotected server is unprotected", () => {
    // "Trusted" would be a lie on a row whose stored decision is to
    // speak in the clear.
    expect(trustLabel(row({ trust: "trusted", insecure: true }))).toBe("unprotected");
  });
});

describe("what an empty list is allowed to mean", () => {
  it("says nothing extra while the browse is running normally", () => {
    // Only then does an empty list mean an empty subnet, and the empty
    // state says that on its own.
    expect(browseNotice({ state: "running" })).toBeNull();
  });

  it("distinguishes a browse that never started from a quiet network", () => {
    const notice = browseNotice({ state: "failed", detail: "address in use" });
    expect(notice).toContain("could not start");
    expect(notice).toContain("address in use");
  });

  it("says discovery may be blocked when the browse itself reported an error", () => {
    const notice = browseNotice({ state: "degraded", detail: "send failed" });
    expect(notice).toContain("blocked");
    expect(notice).toContain("send failed");
    expect(notice).toContain("5353");
  });

  it("covers the states before and after a browse runs", () => {
    expect(browseNotice({ state: "starting" })).toContain("Looking");
    expect(browseNotice({ state: "stopped" })).toContain("stopped");
  });
});

describe("which servers a bus can be bound to", () => {
  it("offers the trusted ones and nothing else", () => {
    // A merely-advertising server is not a source: it is accepted in
    // the Servers panel first, which is where that decision lives.
    expect(trustedServers(ROWS).map((r) => r.address)).toEqual([
      "bench.example.com:50051",
    ]);
  });

  it("keeps a trusted server that is switched off — its section still shows", () => {
    const offline = row({ address: "dead:50051", online: false, trust: "trusted" });
    expect(trustedServers([offline])).toEqual([offline]);
  });

  it("drops a server whose identity changed: that is a question, not a source", () => {
    expect(trustedServers([row({ trust: "fingerprintChanged" })])).toEqual([]);
  });

  it("names a server by what it advertises, falling back to its address", () => {
    expect(serverLabel(row({ name: "bench-rig" }))).toBe("bench-rig");
    expect(serverLabel(row({ name: null, address: "dead:50051" }))).toBe("dead:50051");
  });
});
