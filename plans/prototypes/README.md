# plans/prototypes

Interactive HTML prototypes groomed with the owner. Not shipped code —
behavioural references for task grooming (see the task file that names
each one).

## gui-chip-redesign.html

The chip-language GUI polish prototype (predates this README). Its
`:root` blocks carry the app's theme tokens verbatim from
`apps/gui/src/index.css` — the starting point for any prototype that
should look like the real app.

## export-dialog.html (task 137)

Open it in a browser. The export dialog, the project-logger panel, the
status-bar progress chip, and the name/folder template tokens are all
live simulations; the "Prototype rig" box drives the simulated
environment (project name, connection, wall-clock anchor, write rate).

The logger's file list runs the **real gridview layer** —
`useGridview` / `gridviewRows` / `gridviewSelection` bundled from
`apps/gui/src` — so its cursor, selection, and keyboard behaviour are
the app's, not a mock. `export-dialog.html` is generated: edit
`export-dialog.src.html` (page) or `grid-entry.tsx` (grid wrapper),
then rebuild from this directory:

```sh
ESBUILD=../../apps/gui/node_modules/.pnpm/@esbuild+win32-x64@0.21.5/node_modules/@esbuild/win32-x64/esbuild.exe
"$ESBUILD" grid-entry.tsx --bundle --format=iife --minify \
  --alias:react=./react-shim.cjs \
  --alias:react-dom/client=./react-dom-client-shim.cjs \
  --outfile=grid-bundle.js
node -e "const fs=require('fs');fs.writeFileSync('export-dialog.html','<!doctype html>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n'+fs.readFileSync('export-dialog.src.html','utf8').split('__GRID_BUNDLE__').join(fs.readFileSync('grid-bundle.js','utf8').trimEnd()))"
```

React/ReactDOM load from a CDN at view time; the shims map the bundle's
imports onto those globals.

## units.html (task 139)

Open it in a browser. The units-rework walkthrough: the base-unit x
SI-prefix selector, operand chips showing recognition state at edit
time, the reworked Settings - Units mapping control led by the
project's observed unit strings, and a live probe of the proposed
recognition rules (customizations, built-in spellings,
`[prefix][base]` exact-case, nothing guessed). Round 2: the control sits inside the Database panel's in-place editor at real size, the prefix picker is exponent-ordered and opens on the current selection, ratio scales replace SI prefixes for %, units chain in settings, and the View-signals mock carries resolved-unit chips. Self-contained; the parse engine is a miniature of the design, not app code.

## math-signals.html (task 135)

Open it in a browser; self-contained, no build step. Faithful chrome:
the plot side list is the app's real `.plot-signal-row` grid and the
database panel the real `.dbc-row` tree (classes, tokens, and type
scale transcribed from `index.css` / `PlotArea.tsx` / `DatabasePanel.tsx`;
dark and light via the toggle). Math signals are created from the
database view (right-click the tree), land under **Computed**, and
compute live over mock two-bus BMS sources. Expanding a math row opens
its **editor directly, in place** on whichever surface invoked it
(under the Computed branch for creation) — one stage, no detail view,
never a dialog; operand sections stack full-width under their
headings so the same editor fits the narrow plot signal area. The
editor has no Save/Cancel/Remove buttons: creation materializes the
definition immediately, fields commit on blur, Ctrl+Z / Ctrl+Y
(registry-level undo/redo) covers mistakes, and deletion is the
Database view's two-stage ✕ → "delete?" button. The gallery at the
bottom renders every function type's edit controls at once.

## project-element-controls.html (task 140)

Open it in a browser; self-contained, no build step. The project
panel's Elements section in its real chrome (`.project-element`,
`.project-bus-name-input`, the panel's tokens): the Remove text
button becomes the app's trash glyph (`Icon name="clear"`,
single-click — element removal is undoable), Focus/Open becomes one
icon affordance — the ruled **enter** glyph, an arrow into a
doorway — and RBS / Logger rows carry a play/stop toggle. No state labels — the toggle button alone conveys state,
prototyped as an **intent latch**: green while running, amber when
started-but-disconnected (armed: engages on connect), stop latches
off regardless. The Logical-buses row's Connect/Disconnect is live
so the armed↔running transition can be exercised.
