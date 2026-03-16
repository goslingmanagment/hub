import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    modulePreload: {
      resolveDependencies: (_filename, deps) => deps.filter((dep) => !dep.includes("recharts-")),
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@agency_hub_core/shared": resolve(__dirname, "../../packages/shared/src/browser.ts"),
      "@agency_hub_core/contracts": resolve(__dirname, "../../packages/contracts/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/documentation": "http://localhost:3000",
    },
  },
});
