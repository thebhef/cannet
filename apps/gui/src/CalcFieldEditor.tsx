// The shared calculated-field configuration editor (ADR 0027): one
// modal that edits a message's counter and CRC designations. Used by
// the RBS panel (per-message overrides into the `.cannet_rbs` file)
// and the transmit panel (per-message override on the TX entry) — one
// mechanism, two consumers.
//
// The editor shows the *effective* designation — the project's
// override for a field, else the DBC's declared default for it — and
// says which layer each section came from, in the Default / Override
// vocabulary the RBS signals grid already uses. It produces *override
// specs*: a section left tracking its DBC default writes no override,
// editing one makes it an override of that field alone, and clearing
// a section restores the DBC-declared default for that field (an
// override replaces the default wholesale, per field). Validation
// here is shape-level (numbers parse, ranges byte-aligned, prefix is
// whole hex bytes, named XOR raw); placement-level errors (unknown
// signal, range overlapping the destination) surface from the host as
// system-log warnings when the config resolves.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";

import { Combobox } from "./Combobox";
import type { CalcFieldsSpec, CounterSpec, CrcSpec } from "./types";

export interface CalcFieldEditorProps {
  /// Message display name for the modal title.
  messageLabel: string;
  /// Signal names on the message (destination pickers).
  signalNames: string[];
  /// The DBC-declared defaults (`CannetCounter` / `CannetCrc`). A
  /// field the override layer leaves alone is shown from here, and
  /// clearing an override falls back to it. `null` = none declared.
  dbcDefaults: CalcFieldsSpec | null;
  /// The current override (absent fields fall back to the DBC layer).
  current: CalcFieldsSpec | null;
  /// Pre-select a destination when opened via "configure as …".
  preset?: { role: "counter" | "crc"; signal: string } | null;
  onSave: (spec: CalcFieldsSpec | null) => void;
  onCancel: () => void;
}

/// Parse a `0x…` / decimal number field; empty = `null` (use default).
function parseHexOrInt(text: string): number | string | null {
  const t = text.trim();
  if (t === "") return null;
  if (/^0x[0-9a-fA-F]+$/.test(t)) return t;
  const n = Number(t);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : null;
}

export function CalcFieldEditor({
  messageLabel,
  signalNames,
  dbcDefaults,
  current,
  preset,
  onSave,
  onCancel,
}: CalcFieldEditorProps) {
  // What the controls show: the override for a field when there is
  // one, else the DBC's declared default for it. The two layers are
  // per field (ADR 0027), so a message can have an overridden counter
  // and a DBC-declared CRC at once and both must come up populated.
  const effective = useMemo<CalcFieldsSpec>(
    () => ({
      counter: current?.counter ?? dbcDefaults?.counter ?? null,
      crc: current?.crc ?? dbcDefaults?.crc ?? null,
    }),
    [current, dbcDefaults],
  );

  // Whether the user has edited a section since the modal opened.
  // A section that still mirrors its DBC default writes no override —
  // opening the editor and applying it must not silently copy the
  // DBC's designation into the project.
  const [counterEdited, setCounterEdited] = useState(false);
  const [crcEdited, setCrcEdited] = useState(false);

  // --- counter section state ---
  const presetCounter = preset?.role === "counter" ? preset.signal : null;
  const [counterOn, setCounterOn] = useState(
    effective.counter != null || presetCounter != null,
  );
  const [counterSignal, setCounterSignal] = useState(
    presetCounter ?? effective.counter?.signal ?? signalNames[0] ?? "",
  );
  const [increment, setIncrement] = useState(
    String(effective.counter?.increment ?? 1),
  );
  const [rollover, setRollover] = useState(
    effective.counter?.rollover != null ? String(effective.counter.rollover) : "",
  );

  // --- crc section state ---
  const presetCrc = preset?.role === "crc" ? preset.signal : null;
  const [crcOn, setCrcOn] = useState(effective.crc != null || presetCrc != null);
  const [crcSignal, setCrcSignal] = useState(
    presetCrc ?? effective.crc?.signal ?? signalNames[0] ?? "",
  );
  const currentIsRaw = effective.crc != null && effective.crc.algorithm == null;
  const [useRaw, setUseRaw] = useState(currentIsRaw);
  const [algorithm, setAlgorithm] = useState(
    effective.crc?.algorithm ?? "CRC-8/SAE-J1850",
  );
  const [width, setWidth] = useState(
    effective.crc?.width != null ? String(effective.crc.width) : "8",
  );
  const [poly, setPoly] = useState(String(effective.crc?.poly ?? "0x1D"));
  const [init, setInit] = useState(
    effective.crc?.init != null ? String(effective.crc.init) : "",
  );
  const [xorout, setXorout] = useState(
    effective.crc?.xorout != null ? String(effective.crc.xorout) : "",
  );
  const [refin, setRefin] = useState(effective.crc?.refin ?? false);
  const [refout, setRefout] = useState(effective.crc?.refout ?? false);
  const [rangeStart, setRangeStart] = useState(
    String(effective.crc?.range_bits?.[0] ?? 0),
  );
  const [rangeLen, setRangeLen] = useState(
    String(effective.crc?.range_bits?.[1] ?? 0),
  );
  const [prefix, setPrefix] = useState(effective.crc?.prefix ?? "");

  // The named-algorithm catalogue (the `crc-catalog` list, verbatim).
  const [algorithms, setAlgorithms] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void invoke<string[]>("rbs_crc_algorithms")
      .then((names) => {
        if (!cancelled) setAlgorithms(names);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const [error, setError] = useState<string | null>(null);

  const defaultCounter = dbcDefaults?.counter ?? null;
  const defaultCrc = dbcDefaults?.crc ?? null;

  /// Which layer a section belongs to once applied: an override stays
  /// one, an edited section becomes one, and a section with no DBC
  /// default behind it can only be one. The negative case — on, from
  /// the DBC, untouched — is the one that writes nothing.
  const counterIsOverride = current?.counter != null || counterEdited || defaultCounter == null;
  const crcIsOverride = current?.crc != null || crcEdited || defaultCrc == null;

  /// Wrap a section's setter so editing anything in it moves that
  /// field from the DBC layer to the project's.
  const editCounter =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      setCounterEdited(true);
      set(v);
    };
  const editCrc =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      setCrcEdited(true);
      set(v);
    };

  const handleSave = () => {
    let counter: CounterSpec | null = null;
    if (counterOn && counterIsOverride) {
      const inc = Math.floor(Number(increment));
      if (!Number.isFinite(inc) || inc < 1) {
        setError("counter increment must be a positive integer");
        return;
      }
      let roll: number | null = null;
      if (rollover.trim() !== "") {
        roll = Math.floor(Number(rollover));
        if (!Number.isFinite(roll) || roll < 1) {
          setError("rollover must be a positive integer (or empty for the signal's width)");
          return;
        }
      }
      counter = { signal: counterSignal, increment: inc, rollover: roll };
    }

    let crc: CrcSpec | null = null;
    if (crcOn && crcIsOverride) {
      const start = Math.floor(Number(rangeStart));
      const len = Math.floor(Number(rangeLen));
      if (!Number.isFinite(start) || !Number.isFinite(len) || len <= 0) {
        setError("CRC range needs a start and a non-zero length (bits)");
        return;
      }
      if (start % 8 !== 0 || len % 8 !== 0) {
        setError("CRC range must be byte-aligned (start and length multiples of 8)");
        return;
      }
      const cleanPrefix = prefix.trim().toUpperCase();
      if (cleanPrefix !== "" && !/^([0-9A-F]{2})+$/.test(cleanPrefix)) {
        setError("prefix must be whole hex bytes, e.g. A3 or 0FA3");
        return;
      }
      if (useRaw) {
        const w = Math.floor(Number(width));
        if (!Number.isFinite(w) || w < 1 || w > 64) {
          setError("raw CRC width must be 1..64");
          return;
        }
        const polyV = parseHexOrInt(poly);
        if (polyV == null) {
          setError("raw CRC needs a poly (decimal or 0x hex)");
          return;
        }
        const initV = parseHexOrInt(init);
        const xoroutV = parseHexOrInt(xorout);
        crc = {
          signal: crcSignal,
          width: w,
          poly: polyV,
          ...(initV != null ? { init: initV } : {}),
          ...(xoroutV != null ? { xorout: xoroutV } : {}),
          refin,
          refout,
          range_bits: [start, len],
          ...(cleanPrefix !== "" ? { prefix: cleanPrefix } : {}),
        };
      } else {
        crc = {
          signal: crcSignal,
          algorithm,
          range_bits: [start, len],
          ...(cleanPrefix !== "" ? { prefix: cleanPrefix } : {}),
        };
      }
    }

    onSave(counter == null && crc == null ? null : { counter, crc });
  };

  /// The Default / Override chip a populated section carries — the
  /// same vocabulary the RBS signals grid uses for the same fact.
  const provenance = (isOverride: boolean) => (
    <span
      className={`calc-provenance calc-provenance--${isOverride ? "override" : "default"}`}
      data-testid="calc-provenance"
    >
      {isOverride ? "Override" : "Default"}
    </span>
  );

  // Rendered through a portal: the backdrop is `position: fixed` over
  // the whole window, and one of its call sites (the transmit panel's
  // frame row) is a click-to-expand container — a modal nested in that
  // container's DOM turns every click on its own chrome into a
  // background click on the row beneath it.
  return createPortal(
    <div className="modal-backdrop" role="dialog" aria-label="Calculated fields">
      <div className="modal calc-editor">
        <div className="modal-title">Calculated fields — {messageLabel}</div>

        <section className="calc-section">
          <label className="calc-toggle">
            <input
              type="checkbox"
              checked={counterOn}
              onChange={(e) => setCounterOn(e.target.checked)}
              aria-label="counter configured"
            />
            <span>Sequence counter</span>
            {counterOn && provenance(counterIsOverride)}
            {counterIsOverride && defaultCounter && (
              <span className="calc-default-hint">
                DBC default: {defaultCounter.signal}
              </span>
            )}
          </label>
          {counterOn && (
            <div className="calc-grid">
              <label>
                signal
                <Combobox
                  options={signalNames.map((n) => ({ value: n, label: n }))}
                  value={counterSignal}
                  onChange={editCounter(setCounterSignal)}
                  ariaLabel="counter signal"
                />
              </label>
              <label>
                increment
                <input
                  value={increment}
                  onChange={(e) => editCounter(setIncrement)(e.target.value)}
                  aria-label="counter increment"
                />
              </label>
              <label>
                rollover
                <input
                  value={rollover}
                  placeholder="signal width"
                  onChange={(e) => editCounter(setRollover)(e.target.value)}
                  aria-label="counter rollover"
                />
              </label>
            </div>
          )}
        </section>

        <section className="calc-section">
          <label className="calc-toggle">
            <input
              type="checkbox"
              checked={crcOn}
              onChange={(e) => setCrcOn(e.target.checked)}
              aria-label="crc configured"
            />
            <span>CRC</span>
            {crcOn && provenance(crcIsOverride)}
            {crcIsOverride && defaultCrc && (
              <span className="calc-default-hint">DBC default: {defaultCrc.signal}</span>
            )}
          </label>
          {crcOn && (
            <div className="calc-grid">
              <label>
                signal
                <Combobox
                  options={signalNames.map((n) => ({ value: n, label: n }))}
                  value={crcSignal}
                  onChange={editCrc(setCrcSignal)}
                  ariaLabel="crc signal"
                />
              </label>
              <label className="calc-raw-toggle">
                <input
                  type="checkbox"
                  checked={useRaw}
                  onChange={(e) => editCrc(setUseRaw)(e.target.checked)}
                  aria-label="raw parameters"
                />
                raw Rocksoft parameters
              </label>
              {useRaw ? (
                <>
                  <label>
                    width
                    <input value={width} onChange={(e) => editCrc(setWidth)(e.target.value)} aria-label="crc width" />
                  </label>
                  <label>
                    poly
                    <input value={poly} onChange={(e) => editCrc(setPoly)(e.target.value)} aria-label="crc poly" />
                  </label>
                  <label>
                    init
                    <input value={init} placeholder="0" onChange={(e) => editCrc(setInit)(e.target.value)} aria-label="crc init" />
                  </label>
                  <label>
                    xorout
                    <input value={xorout} placeholder="0" onChange={(e) => editCrc(setXorout)(e.target.value)} aria-label="crc xorout" />
                  </label>
                  <label className="calc-raw-toggle">
                    <input
                      type="checkbox"
                      checked={refin}
                      onChange={(e) => editCrc(setRefin)(e.target.checked)}
                    />
                    refin
                  </label>
                  <label className="calc-raw-toggle">
                    <input
                      type="checkbox"
                      checked={refout}
                      onChange={(e) => editCrc(setRefout)(e.target.checked)}
                    />
                    refout
                  </label>
                </>
              ) : (
                <label>
                  algorithm
                  <Combobox
                    options={(algorithms.length > 0 ? algorithms : [algorithm]).map((n) => ({
                      value: n,
                      label: n,
                    }))}
                    value={algorithm}
                    onChange={editCrc(setAlgorithm)}
                    ariaLabel="crc algorithm"
                  />
                </label>
              )}
              <label>
                range start (bits)
                <input
                  value={rangeStart}
                  onChange={(e) => editCrc(setRangeStart)(e.target.value)}
                  aria-label="crc range start"
                />
              </label>
              <label>
                range length (bits)
                <input
                  value={rangeLen}
                  onChange={(e) => editCrc(setRangeLen)(e.target.value)}
                  aria-label="crc range length"
                />
              </label>
              <label>
                prefix (hex)
                <input
                  value={prefix}
                  placeholder="none"
                  onChange={(e) => editCrc(setPrefix)(e.target.value)}
                  aria-label="crc prefix"
                  title="Bytes prepended to the ranged data before computing — an AUTOSAR E2E Data ID"
                />
              </label>
            </div>
          )}
        </section>

        {error && <div className="calc-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" onClick={handleSave}>
            Apply
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
