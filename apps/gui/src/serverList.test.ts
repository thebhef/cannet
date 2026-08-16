import { describe, expect, it } from "vitest";

import {
  addressShapeError,
  browseNotice,
  formatClockOffset,
  matchServerRows,
  nothingStoredNote,
  serverLabel,
  serverLabels,
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
  manual: false,
  prompt: null,
  clock: null,
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

describe("naming servers that answer to the same name", () => {
  it("leaves a name alone when only one server answers to it", () => {
    const labels = serverLabels(ROWS);
    expect(labels.get("192.168.1.10:50051")).toBe("bench-rig");
    expect(labels.get("192.168.1.44:50051")).toBe("dyno-cell");
    // A row with nothing advertising it is already named by its
    // address — the differentiator must not be added twice.
    expect(labels.get("bench.example.com:50051")).toBe("bench.example.com:50051");
  });

  it("tells two servers of the same name apart by the machine each runs on", () => {
    const alike = [
      row({ address: "10.0.0.1:50051", name: "proxy", host: "bench.local" }),
      row({ address: "10.0.0.2:50051", name: "proxy", host: "spare.local" }),
    ];
    const labels = serverLabels(alike);
    expect(labels.get("10.0.0.1:50051")).toBe("proxy (bench.local)");
    expect(labels.get("10.0.0.2:50051")).toBe("proxy (spare.local)");
  });

  it("falls back to the address when the machine name does not tell them apart", () => {
    // Two servers on one machine, or one whose SRV target never
    // resolved: the address is the row's identity, so it always can.
    const alike = [
      row({ address: "10.0.0.1:50051", name: "proxy", host: "bench.local" }),
      row({ address: "10.0.0.1:50052", name: "proxy", host: "bench.local" }),
      row({ address: "10.0.0.3:50051", name: "proxy", host: null }),
    ];
    const labels = serverLabels(alike);
    expect(labels.get("10.0.0.1:50051")).toBe("proxy (10.0.0.1:50051)");
    expect(labels.get("10.0.0.1:50052")).toBe("proxy (10.0.0.1:50052)");
    expect(labels.get("10.0.0.3:50051")).toBe("proxy (10.0.0.3:50051)");
  });

  it("gives every server a label, and never the same label twice", () => {
    const alike = [
      row({ address: "10.0.0.1:50051", name: "proxy", host: "bench.local" }),
      row({ address: "10.0.0.2:50051", name: "proxy", host: "bench.local" }),
      row({ address: "10.0.0.3:50051", name: "proxy", host: "spare.local" }),
      row({ address: "10.0.0.4:50051", name: "dyno", host: "spare.local" }),
      row({ address: "10.0.0.5:50051", name: null, host: null }),
    ];
    const labels = serverLabels(alike);
    expect(labels.size).toBe(alike.length);
    expect(new Set(labels.values()).size).toBe(alike.length);
  });
});

describe("the shape of a typed server address", () => {
  it("passes what the host can dial, in every spelling it files", () => {
    for (const input of [
      "bench.example.com:50051",
      " https://Bench.Example.com:50051 ",
      "192.168.1.10:50051",
      "[2001:db8::1]:50051",
    ]) {
      expect(addressShapeError(input)).toBeNull();
    }
  });

  it("catches the typos worth catching before a round trip", () => {
    for (const input of ["", "   ", "bench.example.com", "bench:", ":50051", "bench:fifty", "bench:0", "bench:70000", "2001:db8::1:50051"]) {
      expect(addressShapeError(input)).not.toBeNull();
    }
  });

  it("names host:port in the complaint, because that is the fix", () => {
    expect(addressShapeError("bench.example.com")).toContain("host:port");
  });
});

describe("formatClockOffset", () => {
  it("shows sub-second offsets in milliseconds", () => {
    expect(formatClockOffset(42_000_000)).toBe("+42 ms");
    expect(formatClockOffset(-42_000_000)).toBe("-42 ms");
    expect(formatClockOffset(0)).toBe("+0 ms");
  });

  it("switches to seconds with one decimal at 1000 ms and above", () => {
    expect(formatClockOffset(4_200_000_000)).toBe("+4.2 s");
    expect(formatClockOffset(-1_000_000_000)).toBe("-1.0 s");
  });

  it("keeps the sign so ahead and behind read at a glance", () => {
    expect(formatClockOffset(500_000_000)).toMatch(/^\+/);
    expect(formatClockOffset(-500_000_000)).toMatch(/^-/);
  });
});

describe("what a Forget that dropped nothing has to say", () => {
  it("stays quiet whenever the store held something", () => {
    for (const held of [
      { fingerprint: "SHA256:aaa" },
      { hasToken: true },
      { insecure: true },
      { manual: true },
    ]) {
      expect(nothingStoredNote(row(held))).toBeNull();
    }
  });

  it("names the network as what holds an advertising row", () => {
    const note = nothingStoredNote(row({ online: true }));
    expect(note).toContain("192.168.1.10:50051");
    expect(note).toContain("advertising on this network");
  });

  it("names the session as what holds a row nothing advertises", () => {
    // The app's own sidecar, dialled at 127.0.0.1:<ephemeral> for local
    // hardware: nothing is stored and nothing advertises it, so the
    // session is the only thing keeping the row — and it goes with it.
    const note = nothingStoredNote(
      row({ address: "127.0.0.1:65476", name: null, online: false, trust: "trusted" }),
    );
    expect(note).toContain("127.0.0.1:65476");
    expect(note).toContain("session is connected to it");
    expect(note).toContain("leaves the list when that session ends");
  });
});
