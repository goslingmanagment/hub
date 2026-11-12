import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

// Long-lived third-party code in chunks of its own, so their file names (content hashes) stay the
// same across deploys and a returning browser downloads only the app's code again. Without this,
// React & co. sit in the entry chunk, whose hash changes with every app change, and every lazy chunk
// that imports it is renamed too. `charts` holds recharts and what only it pulls in — never a package
// the shell needs as well, or the entry would import the charts chunk eagerly.
const vendorPackages = new Set([
  "react",
  "react-dom",
  "scheduler",
  "react-router",
  "cookie",
  "set-cookie-parser",
  "@tanstack/query-core",
  "@tanstack/react-query",
  "sonner",
  "zustand",
  "zod",
]);
const chartsPackages = new Set([
  "recharts",
  "victory-vendor",
  "@reduxjs/toolkit",
  "redux",
  "redux-thunk",
  "react-redux",
  "reselect",
  "immer",
  "es-toolkit",
  "decimal.js-light",
  "eventemitter3",
  "internmap",
  "tiny-invariant",
]);

function packageOf(id: string): string | undefined {
  const at = id.lastIndexOf("/node_modules/");
  if (at < 0) return undefined;
  const [scope, name] = id.slice(at + "/node_modules/".length).split("/");
  return scope?.startsWith("@") ? `${scope}/${name}` : scope;
}

function manualChunks(id: string): string | undefined {
  const name = packageOf(id);
  if (!name) return undefined;
  if (vendorPackages.has(name)) return "vendor";
  if (chartsPackages.has(name) || name.startsWith("d3-")) return "charts";
  return undefined;
}

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
        // Hub's look as data: token values, formats, the dictionary (packages/look).
        "@agency_hub_core/look": resolve(__dirname, "../../packages/look/src"),
      },
    },
    build: { rollupOptions: { output: { manualChunks } } },
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
