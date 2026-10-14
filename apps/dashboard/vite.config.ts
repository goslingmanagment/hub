import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@agency_hub_core/shared": resolve(__dirname, "../../packages/shared/src/browser.ts"),
      "@agency_hub_core/contracts": resolve(__dirname, "../../packages/contracts/src/index.ts"),
      "@kernel/sdk": resolve(__dirname, "../../packages/sdk/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // The browser's Host goes to the API as it is (Vite's string shorthand
      // rewrites it to the target's): the API takes a change only from a
      // page whose Origin names the host it came to, as in production behind
      // nginx. `ws`: the page browser's screen (its WebSocket) too.
      "/api": { target: apiProxyTarget, changeOrigin: false, ws: true },
      "/documentation": apiProxyTarget,
    },
  },
});
