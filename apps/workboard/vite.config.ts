import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";
import { WORKBOARD_BASE } from "./src/base.ts";

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:3000";
const root = resolve(__dirname, "../..");

/** `/workboard/` by default; `WORKBOARD_BASE=/` for an own host. Always with both slashes. */
function base(): string {
  const value = process.env.WORKBOARD_BASE ?? WORKBOARD_BASE;
  return `/${value.replace(/^\/+|\/+$/g, "")}/`.replace("//", "/");
}

export default defineConfig(({ mode }) => {
  // `vite --mode demo` (pnpm dev:workboard:demo): Workboard with the invented
  // agency of packages/demo and no hub behind it — the same fixtures as the
  // console's demo. Imported lazily so no other mode loads it.
  const demo = mode === "demo";
  const plugins: PluginOption[] = [react(), tailwindcss()];
  if (demo) {
    plugins.push(import("../../packages/demo/plugin.ts").then((module) => module.demoApi({
      // The role switch lands on Workboard's home (an anonymous visitor too:
      // Workboard says itself that nobody is signed in).
      home: () => base(),
    })));
  }

  return {
    base: base(),
    plugins,
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
        "@agency_hub_core/ui": resolve(root, "packages/ui/src"),
        "@agency_hub_core/shared": resolve(root, "packages/shared/src/browser.ts"),
        "@agency_hub_core/contracts": resolve(root, "packages/contracts/src/index.ts"),
        "@kernel/sdk": resolve(root, "packages/sdk/src/index.ts"),
      },
      // One React, one router, one query client across the app and packages/ui.
      dedupe: ["react", "react-dom", "react-router", "@tanstack/react-query", "zustand", "sonner", "lucide-react"],
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      // The main chunk carries the SDK's contract schemas (~1 MB, as the console's own).
      chunkSizeWarningLimit: 1200,
    },
    server: {
      port: demo ? 5190 : 5191,
      strictPort: demo,
      proxy: demo
        ? undefined
        : {
            // As the console's dev server: the browser's Host goes to the API as it is.
            "/api": { target: apiProxyTarget, changeOrigin: false, ws: true },
          },
    },
  };
});
