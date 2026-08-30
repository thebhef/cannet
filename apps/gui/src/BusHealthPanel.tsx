/// The bus health panel: one row per logical bus, carrying the
/// low-level state of the wire that the app surfaced nowhere before.
///
/// **Absent is not zero.** Every column is a fact some bus can genuinely
/// supply and some cannot — an in-process virtual bus has no controller
/// and deliberately no configurable bitrate, so it has no counters and
/// no defined load; a bus with no binding has nothing at all. Those
/// cells read an em dash, never a zero and never an estimate.
///
/// **A bus-off bus shows 0 % load, not an em dash.** The controller is
/// off the wire, so zero is the true reading. "No traffic" and "we
/// cannot know" are different answers and only one of them is an alarm;
/// a panel that renders them alike is worse than no panel.
///
/// The adapter column shares its formats with the project panel —
/// `describeAppliedConfig` renders the applied configuration there and
/// here, so `500k · FD data 2M` means the same thing in both places.
/// Under the adapter's name it carries whatever the peer's driver said
/// about the hardware — driver stack and version, firmware, serial —
/// and nothing at all where the driver said nothing, so a virtual bus
/// reads exactly as it always did.
///
/// **The overruns column is the one that says whether the rest of the
/// panel is the whole story.** It counts occasions on which the driver
/// reported that received frames were lost before they reached us. A
/// driver that does not watch for that reports nothing and the cell
/// reads an em dash — which is not the same as the zero a driver that
/// watches and has seen none reports, and must never be shown as one.

import { useContext, useMemo } from "react";

import { ProjectContext } from "./projectContext";
import {
  busHealthRows,
  useBusHealth,
  type AdapterIdentity,
  type BusHealthRow,
} from "./busHealth";
import { useConnectionStates } from "./connectionStates";
import { useInterfaceDiscovery } from "./ConnectionManagement";
import { useSidecarStatus } from "./sidecarStatus";
import { bindingKind, resolveServer, type InterfaceRecord } from "./types";

/// Where a load reading stops being comfortable and starts being worth
/// looking at. Arbitration is statistical, so a bus is not "full" at
/// 100 % — latency for the lowest-priority id degrades long before
/// that, and these are the two thresholds a CAN engineer reaches for.
const LOAD_WARN_PERCENT = 50;
const LOAD_BAD_PERCENT = 80;

export function BusHealthPanel() {
  const project = useContext(ProjectContext);
  const connStates = useConnectionStates();
  const health = useBusHealth();
  // The adapter column names the interface, and only the host's
  // per-server interface cache knows a channel id's display name. The
  // same hook the project panel's bus rows use, over the servers this
  // project actually binds — no new discovery path, no second spelling.
  const sidecarAddress = useSidecarStatus().address;
  const bindings = project?.interfaceBindings ?? [];
  const addresses = useMemo(
    () =>
      [
        ...new Set(
          bindings
            .filter((b) => bindingKind(b) === "remote")
            .map((b) => resolveServer(b.server, sidecarAddress))
            .filter((a): a is string => a !== null && a !== ""),
        ),
      ].sort(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(bindings), sidecarAddress],
  );
  const discovery = useInterfaceDiscovery(addresses);
  const interfaces = useMemo<InterfaceRecord[]>(
    () =>
      Object.values(discovery.entries).flatMap((e) =>
        e.status === "ok" ? e.interfaces : [],
      ),
    [discovery.entries],
  );
  const rows = useMemo(
    () =>
      busHealthRows({
        buses: project?.buses ?? [],
        bindings,
        interfaces,
        connStates,
        health,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project?.buses, JSON.stringify(bindings), interfaces, connStates, health],
  );

  return (
    <div className="bus-health-panel">
      {rows.length === 0 ? (
        <p className="bus-health-empty">
          This project has no buses. Add one in the project panel.
        </p>
      ) : (
        <table className="bus-health-grid">
          <thead>
            <tr>
              <th>Bus</th>
              <th>State</th>
              <th>Load</th>
              <th className="num">TEC</th>
              <th className="num">REC</th>
              <th
                className="num"
                title="Occasions the driver reported that received frames were lost before reaching the capture. A count of reports, not of frames: no adapter says how many an overrun swallowed. An em dash means this driver does not report receive loss at all."
              >
                Overruns
              </th>
              <th className="num">Errors</th>
              <th>Adapter</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Row key={row.busId} row={row} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Row({ row }: { row: BusHealthRow }) {
  return (
    <tr>
      <td className="bus-health-bus">{row.name}</td>
      <td>
        <span
          className="bus-health-state"
          data-tone={row.tone}
          title={row.stateTitle ?? undefined}
        >
          <span className="bus-health-dot" />
          {row.stateText}
        </span>
      </td>
      <td>
        <Load row={row} />
      </td>
      <Num value={row.tec} />
      <Num value={row.rec} />
      <Num value={row.rxOverruns} />
      <td className="num">
        {row.errorCount === null ? (
          <Absent />
        ) : (
          <>
            {row.errorCount.toLocaleString()}
            {row.errorRate > 0 && (
              <span className="bus-health-rate"> ({formatRate(row.errorRate)}/s)</span>
            )}
          </>
        )}
      </td>
      <td className="bus-health-adapter">
        {row.adapter === null ? (
          <span className="bus-health-absent">no binding</span>
        ) : (
          <>
            {row.adapter}
            {row.applied !== null && <span className="bus-health-applied"> {row.applied}</span>}
            {row.adapterIdentity !== null && <Identity identity={row.adapterIdentity} />}
          </>
        )}
      </td>
    </tr>
  );
}

/// The adapter's identity, rendered only once the driver has reported
/// some of it. Each slot names itself and shows an em dash where the
/// driver said nothing, so a reader can tell "this adapter has no
/// serial to report" from "we never asked".
function Identity({ identity }: { identity: AdapterIdentity }) {
  return (
    <span className="bus-health-identity">
      <Slot label="Driver" value={identity.driver} />
      <Slot label="Firmware" value={identity.firmware} />
      <Slot label="Serial" value={identity.serial} />
    </span>
  );
}

function Slot({ label, value }: { label: string; value: string | null }) {
  return (
    <span className="bus-health-identity-slot">
      <span className="bus-health-identity-label">{label}</span>{" "}
      {value === null ? <Absent /> : value}
    </span>
  );
}

function Load({ row }: { row: BusHealthRow }) {
  if (row.loadPercent === null) {
    return (
      <span className="bus-health-absent" title={row.loadAbsentReason ?? undefined}>
        &mdash;
      </span>
    );
  }
  const level =
    row.loadPercent >= LOAD_BAD_PERCENT
      ? "bad"
      : row.loadPercent >= LOAD_WARN_PERCENT
        ? "warn"
        : "ok";
  return (
    <span className="bus-health-load">
      <span className="bus-health-meter" data-level={level}>
        <i style={{ width: `${Math.min(100, Math.max(0, row.loadPercent))}%` }} />
      </span>
      <span className="num">{Math.round(row.loadPercent)} %</span>
    </span>
  );
}

function Num({ value }: { value: number | null }) {
  return <td className="num">{value === null ? <Absent /> : value.toLocaleString()}</td>;
}

function Absent() {
  return <span className="bus-health-absent">&mdash;</span>;
}

/// Errors per second, kept to the two digits that matter: a fault
/// storm's rate is interesting as an order of magnitude, not to three
/// decimal places.
function formatRate(rate: number): string {
  if (rate >= 1000) return `${(rate / 1000).toFixed(1)}k`;
  if (rate >= 10) return `${Math.round(rate)}`;
  return rate.toFixed(1);
}
