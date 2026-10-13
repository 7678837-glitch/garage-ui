import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
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
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
