import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { hydrateState } from "./hostState";
import { hydrateSettings } from "./hostSettings";
import { hydrateUnits } from "./unitLibrary";
import { startThemeSync } from "./themeSync";
import "dockview/dist/styles/dockview.css";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");

// Load machine-local UI state and user settings (ADR 0032 / 0034) before
// first render so the app's synchronous boot reads (recents, last project,
// layout snapshot; keybindings and the scratch-cache knobs) see the
// persisted values rather than empty defaults. The unit library rides
// along: it never changes while the app runs, and the pickers that offer
// it read it synchronously.
void Promise.all([hydrateState(), hydrateSettings(), hydrateUnits()]).finally(() => {
  // Applies the stored theme and follows it thereafter. Before the first
  // render, so a stored `light` never shows a dark frame.
  startThemeSync();
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
