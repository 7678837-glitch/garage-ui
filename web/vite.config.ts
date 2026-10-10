import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/healthz": "http://127.0.0.1:3909",
      "/api": "http://127.0.0.1:3909",
    },
  },
  build: {
    outDir: "dist",
  },
  test: {
    environment: "jsdom",
  },
});
