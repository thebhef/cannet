import { forwardRef, useRef } from "react";
import type { MouseEvent, MutableRefObject } from "react";

export type ColorChipSize = "bar" | "dot";

export interface ColorChipProps {
  /// The colour the chip shows.
  color: string;
  /// Presence makes the chip a picker; absence renders a plain,
  /// non-interactive swatch (a `<span>`, not a `<button>`).
  onChange?: (hex: string) => void;
  /// `"bar"` (default): the events-panel shape every editable site
  /// standardises on — 1.5rem wide, stretches to fill the row it sits
  /// in, 2px radius, a `--border-wash` hairline. `"dot"`: a small
  /// non-interactive identity marker (a bus colour, a measurement's
  /// series colour) sized to sit inline with text.
  size?: ColorChipSize;
  /// Dims the chip — the plot series' "signal is hidden" state.
  hidden?: boolean;
  /// Renders no visible box at all — only the native picker input,
  /// invisible, for a site whose own trigger is something else (a
  /// coloured signal name, right-clicked). Pair with a forwarded ref
  /// and call `.click()` on it from that trigger's own handler.
  hideBox?: boolean;
  /// Overrides the swatch's default left-click behaviour (open the
  /// picker). Given this, the swatch click does this instead, and
  /// `onSwatchContextMenu` is how the picker opens — the plot series
  /// swatch's toggle-hidden-on-click / recolour-on-right-click split.
  onSwatchClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  /// Runs on right-click, then the picker opens (the swatch's own
  /// `ref` is what opens it — the caller only needs to
  /// `preventDefault`/`stopPropagation` as it likes). Omit for no
  /// special right-click handling.
  onSwatchContextMenu?: (e: MouseEvent<HTMLButtonElement>) => void;
  title?: string;
  swatchAriaLabel?: string;
  /// Accessible name for the underlying `<input type="color">`, when it
  /// differs from `swatchAriaLabel` (e.g. the swatch is unlabelled but
  /// the picker itself needs a name).
  pickerAriaLabel?: string;
  /// Extra class(es) on the visible box (button or span) — a site's own
  /// identity hook (existing tests and generator rules key off these),
  /// carrying no styling of its own.
  swatchClassName?: string;
  /// Extra class(es) on the underlying `<input type="color">`, for the
  /// same reason.
  inputClassName?: string;
}

const cx = (...classes: (string | false | undefined)[]) => classes.filter(Boolean).join(" ");

/// The one colour-picking / colour-identity control the app renders,
/// everywhere it renders one: an editable swatch (a trace event, a
/// plot series, a colour-map rule, a project bus's graph colour, a
/// signal's name colour) and a plain identity dot (the bus marker
/// beside a plotted signal, a measurement's series marker).
///
/// Standardised on the shape the events panel had already worked out —
/// 1.5rem bar, stretched to the row's full height, 2px radius, a
/// `--border-wash` hairline — because among the three prior
/// implementations it was also the only one that had solved the native
/// picker's anchoring correctly: `.color-chip-input` below covers the
/// swatch's own footprint (`inset: 0`) rather than collapsing to a
/// zero-size point, which is the fix for a macOS bug where a zero-size
/// anchor inside a virtualized, absolutely-positioned row makes the
/// picker pop up in the wrong place. The other two copies of this
/// control had the bug (a zero-size anchor) or never carried the
/// commentary explaining why it mattered; this is the one place that
/// knowledge now lives, so every site gets the fix.
export const ColorChip = forwardRef<HTMLInputElement, ColorChipProps>(function ColorChip(
  {
    color,
    onChange,
    size = "bar",
    hidden,
    hideBox,
    onSwatchClick,
    onSwatchContextMenu,
    title,
    swatchAriaLabel,
    pickerAriaLabel,
    swatchClassName,
    inputClassName,
  },
  ref,
) {
  const localInputRef = useRef<HTMLInputElement | null>(null);
  const setInputRef = (node: HTMLInputElement | null) => {
    localInputRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) (ref as MutableRefObject<HTMLInputElement | null>).current = node;
  };

  const boxClasses = cx(
    "color-chip",
    `color-chip-${size}`,
    hidden && "color-chip-hidden",
    swatchClassName,
  );

  // Display-only: no picker at all, just the coloured box.
  if (!onChange) {
    return (
      <span
        className={boxClasses}
        style={{ background: color }}
        title={title}
        aria-hidden={!swatchAriaLabel || undefined}
        aria-label={swatchAriaLabel}
      />
    );
  }

  // The trigger is something else entirely (a coloured signal name,
  // right-clicked) — render only the anchored-nowhere, invisible input,
  // and let the caller open it via the forwarded ref.
  if (hideBox) {
    return (
      <input
        ref={setInputRef}
        type="color"
        className={cx("color-chip-input-bare", inputClassName)}
        style={{ display: "none" }}
        aria-label={pickerAriaLabel ?? swatchAriaLabel}
        value={color}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <span className={cx("color-chip-wrap", `color-chip-wrap-${size}`)}>
      <button
        type="button"
        className={boxClasses}
        style={{ background: color }}
        title={title}
        aria-label={swatchAriaLabel}
        onClick={onSwatchClick ?? (() => localInputRef.current?.click())}
        onContextMenu={
          onSwatchContextMenu &&
          ((e) => {
            onSwatchContextMenu(e);
            localInputRef.current?.click();
          })
        }
      />
      <input
        ref={setInputRef}
        type="color"
        className={cx("color-chip-input", inputClassName)}
        aria-label={pickerAriaLabel ?? swatchAriaLabel}
        value={color}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => e.stopPropagation()}
      />
    </span>
  );
});
