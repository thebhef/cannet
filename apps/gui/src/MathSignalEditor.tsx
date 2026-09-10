/// The **math signal** editor (`docs/CONTEXT.md`) — one component,
/// mounted wherever a math signal is shown: under the Database panel's
/// Computed branch, and (later) in an expanded row on a signal panel or
/// a plot's side list. It renders **in place** on the surface that
/// invoked it; it is never a dialog, and there is no read-only stage in
/// front of it — expanding a math signal *is* editing it.
///
/// **Every field commits as it is left** (owner ruling). There is no
/// Save: a text field applies on blur or Enter and abandons on Escape
/// (the shared `ValidatedInput`, ADR 0027), a combobox applies on the
/// pick, an operand applies when it is dropped or removed. Each commit
/// is one host write and one undo step, recorded through the panel-edit
/// recorder with the definition as it stood — so Mod+Z reverses a math
/// edit exactly as it reverses a decoder pick or an RBS enable.
///
/// The definition being edited is therefore the *host's*, always: this
/// component holds no draft of it. The consequence the surfaces rely on
/// is that it can be unmounted and remounted freely — a virtualized row
/// scrolling out of the window loses nothing.
///
/// Its operand sections are the Signals panel's section idiom with the
/// affordances a *fixed* section suppresses: which sections exist is
/// the function's arity (A and B for a pair, Signal for one, Signals
/// for a set), so there is nothing to add, rename or delete. Sections
/// and fields stack full width under their own headings, because the
/// narrowest surface this has to fit is a plot's side list. A section
/// is filled three ways — a signal dragged in from any drag source
/// (ADR 0045), a single-slot combobox over the catalog, or, for a set,
/// the same `SignalPatternEditor` a signal view's section uses, so a
/// pattern behaves identically wherever it is typed (ADR 0038).
///
/// **The host judges.** Arity, parameter ranges, an uncompilable
/// pattern and a missing name do not refuse an edit — the registry
/// stores the unfinished definition and says what is missing, which is
/// what the row and this editor show (ADR 0025). Only a cycle and a
/// duplicate id are refused, and their prose is shown as it comes.

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";

import type {
  MathDefinition,
  MathFunctionKind,
  MathOperandRef,
  MathSignalRecord,
  SignalDescriptorRecord,
} from "./types";
import {
  MATH_FUNCTIONS,
  definitionOf,
  mathFunctionSpec,
  operandRefKey,
  operandSections,
  parameterEnabled,
  setValidity,
  slotValidity,
  withParam,
  withPatterns,
  withPick,
  withoutPick,
  type MathParamSpec,
  type OperandSection,
  type SectionValidity,
} from "./mathSignals";
import { catalogPath, resolvePatterns } from "./signalSelection";
import { recordSignalKey } from "./plotData";
import { dragHasSignals, parseSignalDragData, SIGNAL_DND_MIME } from "./dragSignals";
import { useProjectContext } from "./projectContext";
import { useSignalCatalog } from "./signalCatalogContext";
import { usePanelEditRecorder } from "./panelEditRecorder";
import { SignalPatternEditor } from "./SignalPatternEditor";
import { ValidatedInput, parseFiniteNumber } from "./ValidatedInput";
import { Combobox, type ComboboxOption } from "./Combobox";
import { useDismissableMenu } from "./useDismissableMenu";
import { Icon } from "./Icon";

export interface MathSignalEditorProps {
  /// The definition being edited, as the host last listed it.
  record: MathSignalRecord;
  /// Every math signal the session holds — the operand picker offers
  /// them too (math signals are selectable as inputs to math signals;
  /// the host refuses the cycles that would make).
  definitions: readonly MathSignalRecord[];
}

/// One operand as a row renders it.
interface OperandDescription {
  label: string;
  unit: string;
  /// The canonical path (ADR 0038), for the row's tooltip.
  path: string;
  /// Nothing in the catalog answers this reference any more.
  missing: boolean;
}

/// Rough height of the editor block in the Database tree's detail-line
/// units, for its virtualizer's offset table. Only the scroll geometry
/// reads it — the block itself lays out in flow — so an approximation
/// is honest here in a way it would not be for a fixed-height row.
export function mathEditorLines(record: MathSignalRecord): number {
  const spec = mathFunctionSpec(record.function.kind);
  const sections = operandSections(spec).reduce(
    (n, s) =>
      n + 3 + (s.slot === "set" ? Math.max(1, record.resolvedOperands.length) : 1),
    0,
  );
  const params = spec.params.filter((p) => parameterEnabled(p, record.function)).length;
  return 6 + sections + 2 * params;
}

export function MathSignalEditor({ record, definitions }: MathSignalEditorProps) {
  const { buses } = useProjectContext();
  const { catalog } = useSignalCatalog();
  const recordPanelEdit = usePanelEditRecorder();
  const [error, setError] = useState<string | null>(null);
  const spec = mathFunctionSpec(record.function.kind);
  const sections = operandSections(spec);
  const stored = definitionOf(record);

  const busNames = useMemo(() => new Map(buses.map((b) => [b.id, b.name])), [buses]);
  const busNamePairs = useMemo(
    () => buses.map((b) => [b.id, b.name] as [string, string]),
    [buses],
  );

  /// Write one edited definition: the host command, and the undo step
  /// whose inverse is the definition as it stood before the write.
  const commit = (next: MathDefinition) => {
    setError(null);
    recordPanelEdit({
      undo: [{ kind: "mathUpdate", definition: stored, busNames: busNamePairs }],
      redo: [{ kind: "mathUpdate", definition: next, busNames: busNamePairs }],
    });
    void invoke("update_math_signal", {
      definition: next,
      busNames: busNamePairs,
    }).catch((e: unknown) => setError(String(e)));
  };

  /// The other math signals, as operand candidates: a definition may
  /// not take itself.
  const others = useMemo(
    () => definitions.filter((d) => d.id !== record.id),
    [definitions, record.id],
  );
  const byKey = useMemo(() => {
    const out = new Map<string, OperandDescription>();
    for (const s of catalog) {
      out.set(recordSignalKey(s), {
        label: s.signal_name,
        unit: s.unit,
        path: catalogPath(s, busNames),
        missing: false,
      });
    }
    for (const d of others) {
      out.set(operandRefKey(mathRef(d.id)), {
        label: d.name,
        unit: d.unitResolved,
        path: d.name,
        missing: false,
      });
    }
    return out;
  }, [catalog, others, busNames]);

  const describe = (ref: MathOperandRef): OperandDescription =>
    byKey.get(operandRefKey(ref)) ?? {
      // A definition whose operand was deleted keeps the reference by
      // design — the editor says so rather than rendering a blank the
      // user cannot act on.
      label: "operand missing",
      unit: "",
      path: ref.signalName,
      missing: true,
    };

  /// Catalog + math definitions as combobox options, grouped the way
  /// the database tree groups them: bus → message → signal, with the
  /// Computed branch last.
  const options = useMemo<ComboboxOption[]>(() => {
    const out: ComboboxOption[] = catalog.map((s) => ({
      value: recordSignalKey(s),
      label: s.signal_name,
      path: [
        s.bus_id == null ? "(no bus)" : busNames.get(s.bus_id) ?? s.bus_id,
        s.message_name,
      ],
      selectedLabel: `${s.message_name}.${s.signal_name}`,
    }));
    for (const d of others) {
      out.push({ value: operandRefKey(mathRef(d.id)), label: d.name, path: ["Computed"] });
    }
    return out;
  }, [catalog, others, busNames]);

  /// Option value → the reference it stands for. Built from the same
  /// list the options are, so a pick cannot name something the editor
  /// cannot resolve.
  const refByValue = useMemo(() => {
    const out = new Map<string, MathOperandRef>();
    for (const s of catalog) out.set(recordSignalKey(s), refOfDescriptor(s));
    for (const d of others) out.set(operandRefKey(mathRef(d.id)), mathRef(d.id));
    return out;
  }, [catalog, others]);

  /// Each pattern's live resolution, and the matches the section shows
  /// beneath its picks. Manual picks win, exactly as they do host-side
  /// — a pattern that matches one adds nothing.
  const picked = new Set(stored.operands.picks.map(operandRefKey));
  const resolutions = resolvePatterns(stored.operands.patterns, catalog, busNames);
  const matched: SignalDescriptorRecord[] = [];
  const seenMatch = new Set(picked);
  for (const res of resolutions) {
    for (const s of res.matches) {
      const k = recordSignalKey(s);
      if (seenMatch.has(k)) continue;
      seenMatch.add(k);
      matched.push(s);
    }
  }

  const onDrop = (section: OperandSection, e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(SIGNAL_DND_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    const { signals } = parseSignalDragData(e.dataTransfer.getData(SIGNAL_DND_MIME));
    if (signals.length === 0) return;
    const refs = signals.map((s) => ({
      busId: s.busId,
      messageId: s.messageId,
      extended: s.extended,
      signalName: s.signalName,
      ...(s.fileBacked ? { fileBacked: true as const } : {}),
      // Provenance travels with the drop, exactly as it does on the
      // combobox path: a math signal is a legal operand of another
      // one, and a pick that dropped the flag would name a DBC
      // identity nothing decodes — `signalName` is then a definition
      // id, so the operand reads back as missing.
      ...(s.math ? { math: true as const } : {}),
    }));
    // One drop is one gesture, so a set takes every signal it carries
    // in a single commit rather than one write per signal.
    const next =
      section.slot === "set"
        ? refs.reduce((d, r) => withPick(d, "set", r), stored)
        : withPick(stored, section.slot, refs[0]);
    if (next !== stored) commit(next);
  };

  return (
    <div className="math-editor">
      <div className="math-editor-title">{spec.label}</div>
      {record.invalid && (
        <div className="math-editor-invalid" role="status">
          {record.invalid}
        </div>
      )}
      {sections.map((section) => (
        <OperandSectionView
          key={section.label}
          section={section}
          definition={stored}
          validity={
            section.slot === "set"
              ? setValidity(
                  stored.operands.picks,
                  resolutions.map((r) => ({
                    valid: r.valid,
                    matches: r.matches.filter((m) => !picked.has(recordSignalKey(m))).length,
                  })),
                )
              : slotValidity(stored.operands.picks[section.slot])
          }
          describe={describe}
          matched={matched}
          busNames={busNames}
          catalog={catalog}
          options={options}
          onPick={(value) => {
            const ref = refByValue.get(value);
            if (ref) commit(withPick(stored, section.slot, ref));
          }}
          onRemove={(index) => commit(withoutPick(stored, index))}
          onPatterns={(patterns) => commit(withPatterns(stored, patterns))}
          onDrop={(e) => onDrop(section, e)}
        />
      ))}
      {spec.params.map((param) => (
        <ParamField
          key={param.key}
          param={param}
          definition={stored}
          onChange={(value) => commit(withParam(stored, param, value))}
        />
      ))}
      <label className="math-editor-field">
        <span>Name</span>
        <ValidatedInput
          value={record.name}
          ariaLabel="Name"
          placeholder={
            spec.arity === "set"
              ? "fn(pattern) when pattern-only; otherwise name it"
              : "name it"
          }
          title="the display name — Enter or clicking away applies it, Escape abandons the edit"
          // Any text, blank included: clearing a name is an edit like
          // any other, and the host marks the definition unnamed.
          parse={(text) => text}
          onCommit={(name) => commit({ ...stored, name })}
        />
      </label>
      <label className="math-editor-field">
        <span>Units</span>
        <ValidatedInput
          value={record.unit ?? ""}
          ariaLabel="Units"
          placeholder={
            record.unitResolved ? `${record.unitResolved} (from the operands)` : "(from the operands)"
          }
          title="the unit this series carries; blank derives it from the operands"
          parse={(text) => text}
          onCommit={(unit) => commit({ ...stored, unit: unit === "" ? null : unit })}
        />
      </label>
      {error && (
        <div className="math-editor-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/// The creation menu: every function, on the surface the user
/// right-clicked. Picking one creates the definition there and then —
/// there is no staging step between the two.
export function MathFunctionMenu({
  position,
  onPick,
  onClose,
}: {
  position: { x: number; y: number };
  onPick: (kind: MathFunctionKind) => void;
  onClose: () => void;
}) {
  const ref = useDismissableMenu<HTMLDivElement>(true, onClose);
  return (
    <div
      ref={ref}
      className="sources-context-menu math-function-menu"
      role="menu"
      aria-label="Add math signal"
      style={{ left: position.x, top: position.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="math-function-menu-title">Add math signal</div>
      {MATH_FUNCTIONS.map((f) => (
        <button key={f.kind} type="button" role="menuitem" onClick={() => onPick(f.kind)}>
          {f.label}
        </button>
      ))}
    </div>
  );
}

/// A reference to another math signal, by its stable id.
function mathRef(id: string): MathOperandRef {
  return { busId: null, messageId: 0, extended: false, signalName: id, math: true };
}

/// A catalog descriptor as an operand reference — the same
/// provenance-keyed shape a drag carries.
function refOfDescriptor(s: SignalDescriptorRecord): MathOperandRef {
  return {
    busId: s.bus_id,
    messageId: s.message_id,
    extended: s.extended,
    signalName: s.signal_name,
    ...(s.file_backed ? { fileBacked: true as const } : {}),
  };
}

/// One prepopulated operand section: the Signals panel's header row
/// (disclosure glyph, label, count) with its rename, delete, drag and
/// add affordances gone, its own validity, and the rows it holds
/// stacked underneath at full width.
function OperandSectionView({
  section,
  definition,
  validity,
  describe,
  matched,
  busNames,
  catalog,
  options,
  onPick,
  onRemove,
  onPatterns,
  onDrop,
}: {
  section: OperandSection;
  definition: MathDefinition;
  validity: SectionValidity;
  describe: (ref: MathOperandRef) => OperandDescription;
  matched: readonly SignalDescriptorRecord[];
  busNames: ReadonlyMap<string, string>;
  catalog: readonly SignalDescriptorRecord[];
  options: readonly ComboboxOption[];
  onPick: (value: string) => void;
  onRemove: (index: number) => void;
  onPatterns: (patterns: string[]) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  // Viewport-fixed at the button's measured position — an anchored
  // popover is clipped by the hosting panel's scroll container.
  const [patternsAt, setPatternsAt] = useState<{ x: number; y: number } | null>(
    null,
  );
  const popoverRef = useDismissableMenu<HTMLDivElement>(patternsAt !== null, () =>
    setPatternsAt(null),
  );
  const isSet = section.slot === "set";
  const picks = definition.operands.picks;
  const filled = isSet
    ? picks.map((ref, index) => ({ ref, index }))
    : picks[section.slot as number] === undefined
      ? []
      : [{ ref: picks[section.slot as number], index: section.slot as number }];
  const count = filled.length + (isSet ? matched.length : 0);
  return (
    <div
      className="math-operand-section"
      role="group"
      aria-label={`${section.label} operands`}
      onDragOver={(e) => {
        if (dragHasSignals(e.dataTransfer.types)) e.preventDefault();
      }}
      onDrop={onDrop}
    >
      <div className="trace-row signals-section-header">
        <span className="signals-section-label">{section.label}</span>
        <span className="hint">({count})</span>
        {!isSet && (
          <Combobox
            options={options}
            value=""
            ariaLabel={`${section.label} signal`}
            className="math-operand-combobox"
            placeholder="choose…"
            title="pick one signal — or drag one in from the database"
            onChange={onPick}
          />
        )}
        {isSet && (
          <span className="math-operand-patterns">
            <button
              type="button"
              aria-label={`patterns for ${section.label}`}
              title="regex patterns this section collects (bus/ecu/message/signal)"
              onClick={(e) => {
                if (patternsAt) {
                  setPatternsAt(null);
                  return;
                }
                const r = e.currentTarget.getBoundingClientRect();
                setPatternsAt({
                  x: Math.max(4, Math.min(r.left, window.innerWidth - 360)),
                  y: r.bottom + 4,
                });
              }}
            >
              /…/{definition.operands.patterns.length > 0
                ? ` ${definition.operands.patterns.length}`
                : ""}
            </button>
            {patternsAt &&
              // Portalled to <body>, like the Combobox dropdown and for
              // the same reason: the editor's hosts sit inside dockview
              // containers whose GPU-layer styles (will-change /
              // translate3d) make them the containing block for fixed
              // descendants, so viewport coordinates rendered in place
              // land offset. On <body>, fixed means the viewport.
              createPortal(
                <div
                  ref={popoverRef}
                  className="signals-section-patterns math-operand-pattern-popover"
                  style={{ left: patternsAt.x, top: patternsAt.y }}
                  role="group"
                  aria-label={`patterns in ${section.label}`}
                >
                  <div className="signals-section-patterns-title">
                    {section.label} patterns
                  </div>
                  <SignalPatternEditor
                    patterns={definition.operands.patterns}
                    catalog={catalog}
                    busNames={busNames}
                    placeholder="regex, e.g. Cell\d+ (Enter to add)"
                    onChange={onPatterns}
                  />
                </div>,
                document.body,
              )}
          </span>
        )}
        <span className={`math-operand-validity${validity.ok ? " ok" : " warn"}`}>
          {validity.message}
        </span>
      </div>
      {filled.length === 0 && matched.length === 0 && (
        <div className="math-operand-empty">
          {isSet
            ? "drag signals here, or add a pattern (/…/)"
            : "drag a signal here, or choose…"}
        </div>
      )}
      {filled.map(({ ref, index }) => {
        const d = describe(ref);
        return (
          <div
            className={`math-operand-row${d.missing ? " missing" : ""}`}
            key={`${operandRefKey(ref)}-${index}`}
          >
            <span className="math-operand-name" title={d.path}>
              {d.label}
            </span>
            <span className="math-operand-unit">{d.unit}</span>
            <button
              type="button"
              aria-label={`remove ${d.label}`}
              title="remove this operand"
              onClick={() => onRemove(index)}
            >
              <Icon name="x" />
            </button>
          </div>
        );
      })}
      {isSet &&
        matched.map((s) => (
          <div className="math-operand-row derived" key={recordSignalKey(s)}>
            <span className="math-operand-name" title={catalogPath(s, busNames)}>
              {s.signal_name}
            </span>
            <span className="math-operand-unit">{s.unit}</span>
            <span className="math-operand-derived" title="collected by a pattern">
              ◇
            </span>
          </div>
        ))}
    </div>
  );
}

/// One parameter field, its label stacked above its control so the
/// whole editor fits a narrow panel (a plot's side list is the narrow
/// case).
///
/// A field whose governing select does not hold its value is **not
/// rendered at all** (owner ruling): a percentile behind a
/// non-percentile statistic is not part of the form the user is
/// filling, and a disabled field reads as one they failed to reach. The
/// value stays in the definition either way.
function ParamField({
  param,
  definition,
  onChange,
}: {
  param: MathParamSpec;
  definition: MathDefinition;
  onChange: (value: number | string) => void;
}) {
  if (!parameterEnabled(param, definition.function)) return null;
  const value = definition.function[param.key] ?? param.default;
  return (
    <label className="math-editor-field">
      <span>{param.label}</span>
      {param.kind === "select" ? (
        <Combobox
          options={(param.options ?? []).map((o) => ({ value: o, label: o }))}
          value={String(value)}
          ariaLabel={param.label}
          proseLabels
          onChange={onChange}
        />
      ) : (
        <ValidatedInput
          value={String(value)}
          ariaLabel={param.label}
          title="Enter or clicking away applies it, Escape abandons the edit"
          parse={parseFiniteNumber}
          onCommit={onChange}
        />
      )}
    </label>
  );
}
