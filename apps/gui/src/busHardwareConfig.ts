/// Pure helpers backing the per-bus hardware configuration controls
/// in the logical-buses panel. Extracted from `ProjectPanel.tsx` so
/// the format/parse round-trip is unit-testable without React.

/// Standard nominal (arbitration-phase) bitrates offered as presets
/// in the bitrate input's datalist. Any value the user types is still
/// accepted — the input is a free-form text field with a `list=`
/// hint, not a constrained `<select>`.
export const NOMINAL_BITRATE_PRESETS_BPS = [
  100_000, 125_000, 250_000, 500_000, 800_000, 1_000_000,
];

/// The nominal bitrate the host sends when a bus has FD enabled but
/// no explicit `speed_bps`. Mirrors the sidecar's
/// `_FD_DEFAULT_NOMINAL_BITRATE_BPS`; kept in sync by convention,
/// since the wire carries `0 = unset` and the sidecar fills the
/// default. The UI renders this as the bitrate field's placeholder
/// when nothing is pinned so the user sees what will actually be
/// pushed.
export const DEFAULT_NOMINAL_BITRATE_BPS = 500_000;

/// Standard CAN-FD data-phase bitrates offered as presets. Same
/// free-form-input shape as {@link NOMINAL_BITRATE_PRESETS_BPS}.
export const FD_DATA_BITRATE_PRESETS_BPS = [
  1_000_000, 2_000_000, 4_000_000, 5_000_000, 8_000_000,
];

/// Render a bps value as a short SI string: `"500k"`, `"1M"`, or the
/// raw integer for values that aren't a clean k / M multiple.
export function formatBitrate(bps: number): string {
  if (bps % 1_000_000 === 0) return `${bps / 1_000_000}M`;
  if (bps % 1_000 === 0) return `${bps / 1_000}k`;
  return String(bps);
}

/// Parse a free-form bitrate string into bps. Accepts:
/// - raw decimal integers (`"500000"` → 500000)
/// - SI shorthand (`"500k"` / `"1M"` / `"1.5m"` — case-insensitive)
/// - leading / trailing whitespace
/// Returns `null` for empty, malformed, zero, or negative input.
export function parseBitrateInput(raw: string): number | null {
  const cleaned = raw.trim().toLowerCase();
  if (cleaned === "") return null;
  const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(cleaned);
  if (!m) {
    const n = Number(cleaned);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const multiplier =
    m[2] === "m" ? 1_000_000 : m[2] === "k" ? 1_000 : 1;
  return Math.round(value * multiplier);
}
