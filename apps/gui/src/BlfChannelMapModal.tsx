import { useState } from "react";

import type { Bus } from "./types";

/// One row's worth of state in the modal: which logical bus the user
/// picked for a given BLF channel. `""` means "skip this channel".
export type ChannelChoice = string;

/// Phase-6 BLF channel → bus mapping step. Shown after the user picks
/// a BLF and before frames start flowing. The user maps each distinct
/// channel observed in the file to a project bus (or to "skip"). The
/// host applies the mapping by tagging each frame with the chosen
/// `bus_id` (or dropping it on the floor for skipped channels).
///
/// Kept deliberately small and self-contained; the parent owns the bus
/// list and resolves the resulting `Map<channel, bus_id | null>` into
/// the wire shape `open_log` consumes.
export function BlfChannelMapModal(props: {
  blfPath: string;
  channels: number[];
  buses: readonly Bus[];
  initial?: Record<number, ChannelChoice>;
  onConfirm: (choices: Record<number, ChannelChoice>) => void;
  onCancel: () => void;
}) {
  const { blfPath, channels, buses, initial, onConfirm, onCancel } = props;
  const [choices, setChoices] = useState<Record<number, ChannelChoice>>(() => {
    const seeded: Record<number, ChannelChoice> = {};
    for (const ch of channels) {
      seeded[ch] = initial?.[ch] ?? (buses[0]?.id ?? "");
    }
    return seeded;
  });

  const set = (ch: number, value: ChannelChoice) =>
    setChoices((prev) => ({ ...prev, [ch]: value }));

  return (
    <div className="modal-overlay" role="dialog" aria-labelledby="blf-map-title">
      <div className="modal">
        <h3 id="blf-map-title">Map BLF channels to logical buses</h3>
        <p className="modal-subtitle" title={blfPath}>
          {basename(blfPath)} — {channels.length} channel
          {channels.length === 1 ? "" : "s"}
        </p>
        {buses.length === 0 && (
          <p className="modal-empty">
            No logical buses are defined yet. Add at least one bus in
            the project panel, or skip every channel below.
          </p>
        )}
        <div className="blf-map-rows">
          {channels.map((ch) => (
            <div className="blf-map-row" key={ch}>
              <span className="blf-map-channel">Channel {ch}</span>
              <select
                value={choices[ch] ?? ""}
                onChange={(e) => set(ch, e.target.value)}
                aria-label={`channel ${ch} bus`}
              >
                <option value="">(skip)</option>
                {buses.map((b) => (
                  <option value={b.id} key={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
        <div className="modal-buttons">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={() => onConfirm(choices)}>
            Open
          </button>
        </div>
      </div>
    </div>
  );
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}
