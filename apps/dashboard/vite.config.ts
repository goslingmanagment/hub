import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:3000";

export default defineConfig(({ mode }) => {
  // `vite --mode demo` (pnpm dev:demo): the console with invented data and no
  // hub behind it — see packages/demo/core.ts (one harness and one set of
  // fixtures with Workboard). Imported lazily so no other mode loads it.
  const demo = mode === "demo";
  const plugins: PluginOption[] = [react(), tailwindcss()];
  // «Команда» is Workboard at /workboard/ on the console's host (Hub serves both in
  // production). Here it is Workboard's own dev server, behind the same origin:
  // `pnpm dev:workboard:demo` (5190) beside `pnpm dev:demo`, `pnpm dev:workboard` (5191) beside this one.
  const workboard = { target: process.env.VITE_WORKBOARD_PROXY_TARGET ?? `http://localhost:${demo ? 5190 : 5191}`, ws: true };
  if (demo) plugins.push(import("../../packages/demo/plugin.ts").then((module) => module.demoApi()));

  return {
    plugins,
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
        "@agency_hub_core/shared": resolve(__dirname, "../../packages/shared/src/browser.ts"),
        "@agency_hub_core/contracts": resolve(__dirname, "../../packages/contracts/src/index.ts"),
        "@kernel/sdk": resolve(__dirname, "../../packages/sdk/src/index.ts"),
        // The shared design system and helpers (packages/ui): format, plural, theme, the Hub client.
        "@agency_hub_core/ui": resolve(__dirname, "../../packages/ui/src"),
      },
    },
    server: {
      port: 5173,
      proxy: demo
        ? { "/workboard": workboard }
        : {
            "/workboard": workboard,
            // The browser's Host goes to the API as it is (Vite's string shorthand
            // rewrites it to the target's): the API takes a change only from a
            // page whose Origin names the host it came to, as in production behind
            // nginx. `ws`: the page browser's screen (its WebSocket) too.
            "/api": { target: apiProxyTarget, changeOrigin: false, ws: true },
            "/documentation": apiProxyTarget,
          },
    },
  };
});
