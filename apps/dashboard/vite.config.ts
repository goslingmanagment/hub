import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@fansly-connect/contracts": resolve(__dirname, "../../packages/contracts/src/index.ts"),
      "@fansly-connect/shared": resolve(__dirname, "../../packages/shared/src/browser.ts"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": apiProxyTarget,
      "/documentation": apiProxyTarget,
    },
  },
  build: {
    outDir: "dist",
  },
});
