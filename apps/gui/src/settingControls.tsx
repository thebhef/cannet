// The settings panel's controls, generated from a descriptor's
// `control.type` (ADR 0034). Nothing here is written per setting: a
// `bool` gets a checkbox, an `enum` a select over its options, an `int`
// or `number` a number box with its unit, and `text` a text box.
//
// The one escape hatch is `type: "custom"`, which names a renderer
// dispatched through `CUSTOM_SETTING_RENDERERS`. **That table is the
// entire extension surface** — a setting is either a generated control
// or one named renderer, and there is no third case. A custom row still
// carries the standard header (label, key, tags) from the panel, so it
// stays searchable and still teaches the file.

import { useEffect, useState, type ReactNode } from "react";

import type { SettingDescriptor } from "./settingDescriptors";

export interface CustomRendererProps {
  descriptor: SettingDescriptor;
  value: unknown;
}

/// Every custom renderer, keyed by the descriptor's `renderer` name.
///
/// `keybindings` is a *pointer*, not an editor: the shortcuts panel is
/// the one place bindings are edited (ADR 0018), and a second editor
/// here would be a second home for one fact. It exists because
/// `keybindings` is a field of `settings.json` like any other, and every
/// field carries a descriptor.
export const CUSTOM_SETTING_RENDERERS: Record<
  string,
  (props: CustomRendererProps) => ReactNode
> = {
  keybindings: ({ value }) => {
    const count = Array.isArray(value) ? value.length : 0;
    return (
      <p className="setting-custom">
        {count === 0
          ? "Using the app's built-in default bindings."
          : `${count} binding${count === 1 ? "" : "s"} customised.`}{" "}
        Edited in the Keyboard Shortcuts panel.
      </p>
    );
  },
};

export interface SettingControlProps {
  descriptor: SettingDescriptor;
  value: unknown;
  /// Persist a new value for this setting. Called with the *stored*
  /// representation (bytes, not MB) — the display scale never leaves
  /// this module.
  onCommit: (value: unknown) => void;
}

/// The control for one setting, generated from its descriptor.
export function SettingControl({ descriptor, value, onCommit }: SettingControlProps) {
  const control = descriptor.control;
  switch (control.type) {
    case "custom": {
      const render = CUSTOM_SETTING_RENDERERS[control.renderer];
      if (render === undefined) {
        // An unregistered renderer is a bug in the descriptor table, so
        // it is shown rather than swallowed.
        return (
          <p className="setting-custom setting-missing-renderer">
            No renderer registered for “{control.renderer}”.
          </p>
        );
      }
      return <>{render({ descriptor, value })}</>;
    }
    case "bool":
      return (
        <label className="setting-checkbox">
          <input
            type="checkbox"
            aria-label={descriptor.label}
            checked={value === true}
            onChange={(e) => onCommit(e.target.checked)}
          />
          <span>{value === true ? "Enabled" : "Disabled"}</span>
        </label>
      );
    case "enum":
      return (
        <select
          aria-label={descriptor.label}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onCommit(e.target.value)}
        >
          {control.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    case "text":
      return (
        <TextBox
          label={descriptor.label}
          value={typeof value === "string" ? value : ""}
          placeholder={control.placeholder ?? ""}
          onCommit={onCommit}
        />
      );
    case "int":
      return (
        <NumberBox
          label={descriptor.label}
          value={value}
          scale={control.scale}
          min={control.min}
          unit={control.unit}
          unset={control.unset}
          integer
          onCommit={onCommit}
        />
      );
    case "number":
      return (
        <NumberBox
          label={descriptor.label}
          value={value}
          scale={1}
          min={control.min}
          unit={control.unit}
          unset={null}
          integer={false}
          onCommit={onCommit}
        />
      );
  }
}

/// A text box that commits on blur / Enter rather than per keystroke,
/// so a half-typed value is never written through.
function TextBox({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder: string;
  onCommit: (value: unknown) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // A value that changed underneath us (a hand-edit, another panel)
  // replaces an untouched box.
  useEffect(() => setDraft(null), [value]);
  const commit = () => {
    if (draft === null) return;
    const text = draft;
    setDraft(null);
    if (text !== value) onCommit(text);
  };
  return (
    <input
      type="text"
      aria-label={label}
      placeholder={placeholder}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

/// A number box that commits on blur / Enter.
///
/// Per-keystroke writes are impossible here: the host refuses an
/// out-of-range value, so a minimum-100-MB cap typed as "500" would be
/// refused (and the box reset) at "5". `scale` converts between the
/// stored unit and the displayed one; `unset` marks blank as legal and
/// is what the box writes `null` for.
function NumberBox({
  label,
  value,
  scale,
  min,
  unit,
  unset,
  integer,
  onCommit,
}: {
  label: string;
  value: unknown;
  scale: number;
  min: number | null;
  unit: string | null;
  unset: string | null;
  integer: boolean;
  onCommit: (value: unknown) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [value]);
  const shown = typeof value === "number" ? String(value / scale) : "";
  const commit = () => {
    if (draft === null) return;
    const text = draft.trim();
    setDraft(null);
    if (text === "") {
      // Blank is only a value where the descriptor says so; otherwise
      // it reverts to what is stored.
      if (unset !== null) onCommit(null);
      return;
    }
    const typed = Number(text);
    if (!Number.isFinite(typed) || typed < 0) return;
    onCommit(integer ? Math.round(typed * scale) : typed);
  };
  return (
    <>
      <input
        type="number"
        aria-label={label}
        min={min === null ? undefined : min / scale}
        placeholder={unset ?? ""}
        value={draft ?? shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      {unit !== null && <span className="setting-unit">{unit}</span>}
    </>
  );
}
