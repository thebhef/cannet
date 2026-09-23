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

## math-signals.html (task 135)

Open it in a browser; self-contained, no build step. Faithful chrome:
the plot side list is the app's real `.plot-signal-row` grid and the
database panel the real `.dbc-row` tree (classes, tokens, and type
scale transcribed from `index.css` / `PlotArea.tsx` / `DatabasePanel.tsx`;
dark and light via the toggle). Math signals are created from the
database view (right-click the tree), land under **Computed**, and
compute live over mock two-bus BMS sources; expandable rows share one
detail/edit view across the plot side list and the database. The
gallery at the bottom renders every function type's edit controls at
once.
