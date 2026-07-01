import { useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import {
  defaultSettings,
  loadSettings,
  saveSettings,
  type Settings,
} from "./hostSettings";

const BYTES_PER_MB = 1024 * 1024;

/**
 * Settings panel — a flat, hand-rolled editor over the host's
 * `settings.json` (ADR 0034). User intent only (the disk-spill scratch
 * cap and clear-on-exit), distinct from the machine state in `hostState`.
 * The file is the durable contract; this panel loads it on mount and
 * writes the whole struct back on each edit. A singleton panel (one
 * instance, fixed dockview id), opened from the command palette.
 */
export function SettingsPanel(_props: IDockviewPanelProps) {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    void loadSettings().then((s) => {
      if (live) {
        setSettings(s);
        setLoaded(true);
      }
    });
    return () => {
      live = false;
    };
  }, []);

  // Persist the whole struct on each edit; the host is authoritative.
  const update = (patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      void saveSettings(next).catch(() => {
        /* host logs the failure; the in-memory value still holds */
      });
      return next;
    });
  };

  const capMb =
    settings.scratch_cap_bytes == null
      ? ""
      : String(Math.round(settings.scratch_cap_bytes / BYTES_PER_MB));

  const onCapChange = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === "") {
      update({ scratch_cap_bytes: null });
      return;
    }
    const mb = Number(trimmed);
    if (!Number.isFinite(mb) || mb < 0) return; // ignore non-numeric / negative
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
            min={0}
            step={64}
            placeholder="unbounded"
            value={capMb}
            onChange={(e) => onCapChange(e.target.value)}
          />
          <span className="settings-desc">
            Drop the oldest history once the on-disk cache exceeds this.
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
