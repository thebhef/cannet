import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  // Tauri expects a fixed port and never closes it on connection errors.
  clearScreen: false,
  // Vitest blanks every CSS import by default, `?raw` included, which
  // makes the stylesheet unreadable from a test. `dockPanelScrolling`
  // asserts declarations that no jsdom rendering test can reach (jsdom
  // does no layout), so let that one file through as text.
  test: { css: { include: [/index\.css/] } },
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
    hmr: { protocol: "ws", host: "127.0.0.1", port: 5173 },
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
