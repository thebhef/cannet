import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { hydrateState } from "./hostState";
import "dockview/dist/styles/dockview.css";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");

// Load machine-local UI state (ADR 0032 / 0034) before first render so
// the app's synchronous boot reads (recents, last project, layout
// snapshot) see the persisted values rather than empty defaults.
void hydrateState().finally(() => {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
