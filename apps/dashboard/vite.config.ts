import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@fansly-connect/shared": resolve(__dirname, "../../packages/shared/src/browser.ts"),
      "@fansly-connect/contracts": resolve(__dirname, "../../packages/contracts/src/index.ts"),
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
