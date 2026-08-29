/// The app's icon registry: one shared module over a single
/// `name -> shape data` record, consumed through the `<Icon>` component.
///
/// The set is hand-drawn on a 14px grid with a 1.4px rounded stroke — no
/// external icon library (a rejected dependency). Every icon's shape data
/// is copied verbatim from the design prototype's inline `<symbol>`
/// definitions, so the app and the prototype cannot drift on day one;
/// when the app's set changes, the prototype's inventory changes with it
/// in the same commit.
///
/// `ICON_NAMES` is the reviewable set itself — adding, removing or
/// renaming an entry here is a deliberate, visible change (pinned by
/// `Icon.dom.test.tsx`), not a side effect of drawing one new glyph.
/// `ICON_REGISTRY` is typed `Record<IconName, ...>`, so the compiler
/// already refuses a registry that is missing an entry or carries one
/// that `ICON_NAMES` does not name.

/// One drawable shape inside an icon's 14x14 viewBox. A handful of icons
/// need `circle` / `ellipse` / `rect` alongside `path` (the clock face,
/// the database drum, the bus taps, the stop square) — kept as typed
/// shape data rather than a markup string so no icon can smuggle in
/// attributes the registry doesn't account for.
export type IconShape =
  | { readonly tag: "path"; readonly d: string }
  | { readonly tag: "circle"; readonly cx: number; readonly cy: number; readonly r: number }
  | {
      readonly tag: "ellipse";
      readonly cx: number;
      readonly cy: number;
      readonly rx: number;
      readonly ry: number;
    }
  | {
      readonly tag: "rect";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };

/// The full inventory, in the order the design prototype's "icon set —
/// full inventory" section lists it. That section — not this file's
/// commentary — is the source of truth for what the set means; this
/// array is the source of truth for what the set *is*.
export const ICON_NAMES = [
  "folder",
  "save",
  "import",
  "export",
  "clock",
  "db",
  "db-add",
  "bus",
  "plug",
  "clear",
  "plus",
  "rows",
  "chart",
  "signals",
  "send",
  "loop",
  "palette",
  "wave",
  "eye",
  "graph",
  "flag",
  "tree",
  "bell",
  "play",
  "pause",
  "stop",
  "fit-x",
  "fit-y",
  "search",
  "cursors-clear",
  "cursor-x",
  "cursor-y",
  "note",
  "goto",
  "edit",
  "link",
  "x",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

/// Shape data for every icon, copied verbatim from the prototype's
/// `<symbol>` bodies (`viewBox="0 0 14 14"` throughout).
export const ICON_REGISTRY: Readonly<Record<IconName, readonly IconShape[]>> = {
  folder: [{ tag: "path", d: "M1.5 3.5h4l1.5 1.5h5.5v6h-11z" }],
  save: [
    { tag: "path", d: "M2 2h8l2 2v8H2z" },
    { tag: "path", d: "M4.5 2v3h5V2M4.5 12V8h5v4" },
  ],
  import: [
    { tag: "path", d: "M7 1.5v7M4.5 6L7 8.5 9.5 6" },
    { tag: "path", d: "M1.5 9.5v3h11v-3" },
  ],
  export: [
    { tag: "path", d: "M7 8.5v-7M4.5 4L7 1.5 9.5 4" },
    { tag: "path", d: "M1.5 9.5v3h11v-3" },
  ],
  clock: [
    { tag: "circle", cx: 7, cy: 7, r: 5.5 },
    { tag: "path", d: "M7 4v3.2l2 1.4" },
  ],
  db: [
    { tag: "ellipse", cx: 7, cy: 3, rx: 5, ry: 1.8 },
    { tag: "path", d: "M2 3v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V3" },
    { tag: "path", d: "M2 7c0 1 2.2 1.8 5 1.8s5-.8 5-1.8" },
  ],
  "db-add": [
    { tag: "ellipse", cx: 5.5, cy: 3.2, rx: 4, ry: 1.5 },
    {
      tag: "path",
      d: "M1.5 3.2v7.3c0 .9 1.8 1.5 4 1.5 .8 0 1.6-.1 2.2-.2M9.5 3.2v3.3",
    },
    { tag: "path", d: "M11.5 8.5v4M9.5 10.5h4" },
  ],
  bus: [
    { tag: "path", d: "M1.5 7h11" },
    { tag: "path", d: "M4.5 7V4.2M9.5 7v2.8" },
    { tag: "circle", cx: 4.5, cy: 3, r: 1.2 },
    { tag: "circle", cx: 9.5, cy: 11, r: 1.2 },
  ],
  plug: [
    { tag: "path", d: "M4.5 1.5v3M9.5 1.5v3" },
    { tag: "path", d: "M3 4.5h8v2.5a4 4 0 0 1-8 0z" },
    { tag: "path", d: "M7 11v1.8" },
  ],
  clear: [{ tag: "path", d: "M2.5 3.5h9M5.5 3.5V2h3v1.5M3.5 3.5l.7 8h5.6l.7-8" }],
  plus: [{ tag: "path", d: "M7 2.5v9M2.5 7h9" }],
  rows: [{ tag: "path", d: "M2 3.5h10M2 7h10M2 10.5h10" }],
  chart: [
    { tag: "path", d: "M1.5 12.5v-11M1.5 12.5h11" },
    { tag: "path", d: "M3 9.5l3-3.5 2.5 2 3-4.5" },
  ],
  signals: [{ tag: "path", d: "M1.5 7h2l1.5-4 2.5 8 1.5-4h3.5" }],
  send: [{ tag: "path", d: "M1.5 7L12.5 2 9.5 12.5 6.5 8.5z M6.5 8.5L12.5 2" }],
  loop: [
    { tag: "path", d: "M2.5 6a4.5 4.5 0 0 1 8.4-1.5M11.5 8a4.5 4.5 0 0 1-8.4 1.5" },
    { tag: "path", d: "M11 2v2.8h-2.8M3 12V9.2h2.8" },
  ],
  palette: [
    {
      tag: "path",
      d: "M7 1.5a5.5 5.5 0 1 0 0 11c1 0 1.2-.9.7-1.5-.6-.8-.2-2 1-2h1.3c1.4 0 2.5-1 2.5-2.5C12.5 3.8 10 1.5 7 1.5z",
    },
    { tag: "circle", cx: 4.5, cy: 5, r: 0.7 },
    { tag: "circle", cx: 7.5, cy: 3.8, r: 0.7 },
    { tag: "circle", cx: 9.8, cy: 5.6, r: 0.7 },
  ],
  wave: [{ tag: "path", d: "M1.5 7c1.5-4 3-4 4.5 0s3 4 4.5 0 1.5-2 2 0" }],
  eye: [
    { tag: "path", d: "M1.5 7S3.5 3.5 7 3.5 12.5 7 12.5 7 10.5 10.5 7 10.5 1.5 7 1.5 7z" },
    { tag: "circle", cx: 7, cy: 7, r: 1.6 },
  ],
  graph: [
    { tag: "circle", cx: 3, cy: 7, r: 1.6 },
    { tag: "circle", cx: 11, cy: 3, r: 1.3 },
    { tag: "circle", cx: 11, cy: 7, r: 1.3 },
    { tag: "circle", cx: 11, cy: 11, r: 1.3 },
    { tag: "path", d: "M4.5 6.3L9.7 3.5M4.7 7h4.9M4.5 7.7L9.7 10.5" },
  ],
  flag: [
    { tag: "path", d: "M3 12.5V1.5" },
    { tag: "path", d: "M3 2h7.5L8.5 4.5 10.5 7H3" },
  ],
  tree: [
    { tag: "path", d: "M3 2.5h8" },
    { tag: "path", d: "M4.5 4.5V11" },
    { tag: "path", d: "M4.5 7.5h4M4.5 11h4" },
  ],
  bell: [
    {
      tag: "path",
      d: "M7 1.8c-2.2 0-3.5 1.6-3.5 3.7 0 3-1.3 4-1.3 4h9.6s-1.3-1-1.3-4c0-2.1-1.3-3.7-3.5-3.7z",
    },
    { tag: "path", d: "M5.8 11.5a1.3 1.3 0 0 0 2.4 0" },
  ],
  play: [{ tag: "path", d: "M4 2.5l7 4.5-7 4.5z" }],
  pause: [{ tag: "path", d: "M4.5 2.5v9M9.5 2.5v9" }],
  stop: [{ tag: "rect", x: 3.5, y: 3.5, width: 7, height: 7 }],
  "fit-x": [{ tag: "path", d: "M1.5 7h11M3.5 4.5L1.5 7l2 2.5M10.5 4.5l2 2.5-2 2.5" }],
  "fit-y": [{ tag: "path", d: "M7 1.5v11M4.5 3.5L7 1.5l2.5 2M4.5 10.5l2.5 2 2.5-2" }],
  search: [
    { tag: "circle", cx: 6, cy: 6, r: 4 },
    { tag: "path", d: "M9 9l3.5 3.5" },
  ],
  // The cursor family is dashed — the oscilloscope idiom for a
  // measurement cursor over the trace; clear crosses the pair out.
  "cursors-clear": [
    { tag: "path", d: "M4.5 1.5v2.6M4.5 5.7v2.6M4.5 9.9v2.6M9.5 1.5v2.6M9.5 5.7v2.6M9.5 9.9v2.6" },
    { tag: "path", d: "M1.5 12.5L12.5 1.5" },
  ],
  "cursor-x": [
    { tag: "path", d: "M4.5 1.5v2.6M4.5 5.7v2.6M4.5 9.9v2.6M9.5 1.5v2.6M9.5 5.7v2.6M9.5 9.9v2.6" },
  ],
  "cursor-y": [
    { tag: "path", d: "M1.5 4.5h2.6M5.7 4.5h2.6M9.9 4.5h2.6M1.5 9.5h2.6M5.7 9.5h2.6M9.9 9.5h2.6" },
  ],
  note: [
    { tag: "path", d: "M2.5 1.5h9v8l-3 3h-6z" },
    { tag: "path", d: "M8.5 12.5v-3h3" },
    { tag: "path", d: "M4.5 5h5M4.5 7.5h3" },
  ],
  goto: [
    { tag: "path", d: "M11.5 2.5v9" },
    { tag: "path", d: "M2 7h6.5M6 4.5L8.5 7 6 9.5" },
  ],
  edit: [
    { tag: "path", d: "M2.5 11.5l.8-2.8 6.4-6.4 2 2-6.4 6.4z" },
    { tag: "path", d: "M8.7 3.3l2 2" },
  ],
  link: [
    { tag: "path", d: "M6 8l2-2" },
    { tag: "path", d: "M8.5 8.5l2-2a2.1 2.1 0 0 0-3-3l-2 2M5.5 5.5l-2 2a2.1 2.1 0 0 0 3 3l2-2" },
  ],
  x: [{ tag: "path", d: "M3.5 3.5l7 7M10.5 3.5l-7 7" }],
};

export interface IconProps {
  name: IconName;
  /// Extra class(es) on the `<svg>` — sizing and layout are the caller's
  /// (a chip's own `svg` rule), never this component's.
  className?: string;
}

/// Renders one registry icon. Always decorative (`aria-hidden`): the
/// name for assistive tech belongs to the control the icon sits inside
/// (a button's `aria-label`/`title`), never to the icon itself.
export function Icon({ name, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 14 14"
      width={14}
      height={14}
      className={className}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICON_REGISTRY[name].map((shape, i) => {
        switch (shape.tag) {
          case "path":
            return <path key={i} d={shape.d} />;
          case "circle":
            return <circle key={i} cx={shape.cx} cy={shape.cy} r={shape.r} />;
          case "ellipse":
            return <ellipse key={i} cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} />;
          case "rect":
            return <rect key={i} x={shape.x} y={shape.y} width={shape.width} height={shape.height} />;
        }
      })}
    </svg>
  );
}
