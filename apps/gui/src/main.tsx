import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "dockview/dist/styles/dockview.css";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
