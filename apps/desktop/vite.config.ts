import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and no browser auto-open.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    // Templates and the Godot runtime live at the repository root and are bundled with ?raw imports.
    fs: { allow: ["../.."] },
  },
  build: {
    target: "safari16",
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 3000,
  },
});
