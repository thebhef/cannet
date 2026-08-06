import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { hydrateState } from "./hostState";
import { hydrateSettings } from "./hostSettings";
import { startThemeSync } from "./themeSync";
import "dockview/dist/styles/dockview.css";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");

// Load machine-local UI state and user settings (ADR 0032 / 0034) before
// first render so the app's synchronous boot reads (recents, last project,
// layout snapshot; keybindings and the scratch-cache knobs) see the
// persisted values rather than empty defaults.
void Promise.all([hydrateState(), hydrateSettings()]).finally(() => {
  // Applies the stored theme and follows it thereafter. Before the first
  // render, so a stored `light` never shows a dark frame.
  startThemeSync();
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
