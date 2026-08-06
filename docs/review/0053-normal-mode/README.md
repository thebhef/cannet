# Normal mode — review captures

The nine steps of the `cannet-perf-measurement screenshot` scenario,
rendered with `theme: light` and `normal_mode: true`. Committed so the
setting can be reviewed without a Windows machine and a build; the dark
and plain-light parity checks from the same session are diffs rather
than pictures and live in the task's status log.

Captured from a `tauri build --no-bundle` release build against
`examples/ev-demo`, 1600×1000 at device-scale 1, with the harness's
usual masks (status-bar readings, system-log text, wall-clock stamps,
the plot perf badge, the About version) hidden — see the crate README
for what that leaves outside the frame.

| capture | what to look at |
| --- | --- |
| `01-saved-layout` | the surface ramp: app / panel / row, the RBS tree, both plot side panels |
| `02-dbc-system-messages` | log level chips against a row, the DBC tree's semantic tints |
| `03-settings` | the settings tree and the tag chips |
| `04-transmit` | table chrome and the per-bus tints |
| `05-colormap` | authored rule colors, which no theme touches |
| `06-project-graph` | node fills and outlines per kind, and the bus-colored wires |
| `07-about` | the license disclosure tree |
| `08-shortcuts` | the shortcut chips and the conflict copy |
| `09-palette` | the command palette over a dimmed window: backdrop, selection, shadow |

Two things are deliberately not in frame. The **Normal mode** row itself
is developer-tagged, so it is hidden unless `show_developer_settings` is
on and `03-settings` shows the same rows the light captures do. Plot
**series** colors are stored project data (`ev-demo` was saved with
them) and render verbatim under every theme by design — the wheels show
up on a project that has not stored colors, and in the panels that hash
a color per signal.
