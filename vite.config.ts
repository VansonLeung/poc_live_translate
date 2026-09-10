import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Keep the AudioWorklet on the app origin for Electron's content security policy.
  build: { assetsInlineLimit: 0 },
  server: {
    host: "127.0.0.1",
    port: 6005,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:6006" },
  },
  preview: {
    host: "127.0.0.1",
    port: 6005,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:6006" },
  },
});
