import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import logoUrl from "./assets/logo.svg";

const win = getCurrentWindow();

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  // Track the maximized state so the middle button's icon stays in sync
  // with the actual window state, including when the user double-clicks
  // the drag region.
  useEffect(() => {
    let cancelled = false;
    win.isMaximized().then((m) => !cancelled && setMaximized(m));
    const unlisten = win.onResized(() => {
      win.isMaximized().then((m) => !cancelled && setMaximized(m));
    });
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div className="titlebar" data-tauri-drag-region>
      <img className="titlebar-logo" src={logoUrl} alt="" data-tauri-drag-region />
      <span className="titlebar-name" data-tauri-drag-region>cannet</span>
      <div className="titlebar-spacer" data-tauri-drag-region />
      <button
        className="titlebar-button"
        aria-label="Minimize"
        onClick={() => win.minimize()}
      >
        <MinimizeIcon />
      </button>
      <button
        className="titlebar-button"
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={() => win.toggleMaximize()}
      >
        {maximized ? <RestoreIcon /> : <MaximizeIcon />}
      </button>
      <button
        className="titlebar-button titlebar-close"
        aria-label="Close"
        onClick={() => win.close()}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

// Stroke-based glyphs so they pick up `currentColor` from the button.
// Sized for a 12px viewport — the buttons themselves are 46×30, the
// Windows-conventional control size.

function MinimizeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12">
      <line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12">
      <rect
        x="2"
        y="2"
        width="8"
        height="8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12">
      <rect x="3" y="3" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
      <path d="M2 4 V2 H8 V3" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12">
      <line x1="3" y1="3" x2="9" y2="9" stroke="currentColor" strokeWidth="1" />
      <line x1="9" y1="3" x2="3" y2="9" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}
