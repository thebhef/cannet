import { useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import {
  defaultSettings,
  loadSettings,
  loadSettingsBounds,
  saveSettings,
  type Settings,
  type SettingsBounds,
} from "./hostSettings";

const BYTES_PER_MB = 1024 * 1024;

/**
 * Settings panel — a flat, hand-rolled editor over the host's
 * `settings.json` (ADR 0034). User intent only (the disk-spill scratch
 * cap and clear-on-exit), distinct from the machine state in `hostState`.
 * The file is the durable contract; this panel loads it on mount and, on
 * each edit, re-reads it and writes the whole struct back with the edit
 * merged over the current contents. Field limits come from the host
 * (`loadSettingsBounds`) rather than being restated here, and the host is
 * the one that enforces them — this panel displays whatever the host says
 * it stored. A singleton panel (one instance, fixed dockview id), opened
 * from the command palette.
 */
export function SettingsPanel(_props: IDockviewPanelProps) {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [bounds, setBounds] = useState<SettingsBounds | null>(null);
  const [loaded, setLoaded] = useState(false);
  // In-progress text for the cap box. `null` = show the stored value. The
  // box can't be written through on every keystroke: the host refuses a
  // below-minimum cap, so "500" typed one digit at a time would be refused
  // (and the box reset) before the last digit arrived.
  const [capDraft, setCapDraft] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void loadSettings().then((s) => {
      if (live) {
        setSettings(s);
        setLoaded(true);
      }
    });
    void loadSettingsBounds()
      .then((b) => {
        if (live) setBounds(b);
      })
      .catch(() => {
        /* no host: render without the limit rather than inventing one */
      });
    return () => {
      live = false;
    };
  }, []);

  // Persist an edit: show it immediately, then re-read the file and write
  // the whole struct back with the patch merged over *that* — not over this
  // panel's mount-time snapshot — so a concurrent write (the shortcuts
  // panel persisting a keybinding) isn't clobbered. Same shape as
  // `useCommands`' `persistUserBindings`. The host is authoritative and
  // answers with what it stored, which is what ends up displayed.
  const update = (patch: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    void loadSettings()
      .then((current) => saveSettings({ ...current, ...patch }))
      .then((accepted) => setSettings(accepted))
      .catch(() => {
        /* host logs the failure; the in-memory value still holds */
      });
  };

  const minCapMb = bounds == null ? undefined : Math.ceil(bounds.minScratchCapBytes / BYTES_PER_MB);
  const storedCapMb =
    settings.scratch_cap_bytes == null
      ? ""
      : String(Math.round(settings.scratch_cap_bytes / BYTES_PER_MB));

  // Commit the typed cap on blur / Enter. Blank = unbounded; anything
  // unparseable reverts to the stored value. A too-small number is *sent* —
  // the host is the one that judges it, and reports the refusal.
  const commitCap = () => {
    if (capDraft == null) return;
    const trimmed = capDraft.trim();
    setCapDraft(null);
    if (trimmed === "") {
      update({ scratch_cap_bytes: null });
      return;
    }
    const mb = Number(trimmed);
    if (!Number.isFinite(mb) || mb < 0) return;
    update({ scratch_cap_bytes: Math.round(mb * BYTES_PER_MB) });
  };

  return (
    <div className="settings-panel">
      <fieldset className="settings-group" disabled={!loaded}>
        <legend>Disk-spill Cache</legend>
        <label className="settings-field">
          <span className="settings-label">Cache size cap (MB)</span>
          <input
            type="number"
            min={minCapMb}
            step={64}
            placeholder="unbounded"
            value={capDraft ?? storedCapMb}
            onChange={(e) => setCapDraft(e.target.value)}
            onBlur={commitCap}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitCap();
            }}
          />
          <span className="settings-desc">
            Drop the oldest history once the on-disk cache exceeds this.
            {minCapMb != null && (
              <> Minimum {minCapMb} MB — below that, pre-allocated segments
              dominate and the cap can't be honored, so a smaller value is
              refused.</>
            )}{" "}
            Blank = unbounded.
          </span>
        </label>
        <label className="settings-field settings-field-checkbox">
          <input
            type="checkbox"
            checked={settings.clear_scratch_on_exit}
            onChange={(e) => update({ clear_scratch_on_exit: e.target.checked })}
          />
          <span className="settings-label">Clear cache on exit</span>
          <span className="settings-desc">
            Wipe the disk-spill cache when the app closes cleanly, instead of
            reloading the prior session on the next launch.
          </span>
        </label>
      </fieldset>
    </div>
  );
}
