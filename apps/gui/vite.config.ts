import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  // Tauri expects a fixed port and never closes it on connection errors.
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
    hmr: { protocol: "ws", host: "127.0.0.1", port: 5173 },
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
