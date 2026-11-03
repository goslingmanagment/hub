import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { Toaster } from "sonner";
import { App } from "./App.js";
import { prefetchPages } from "./api/pages.js";
import { queryClient } from "./lib/queryClient.js";
import { useThemeStore } from "./lib/theme.js";
import { applySiteTitle } from "./lib/sites.js";
import "./globals.css";

applySiteTitle();

// «Статистика» can fire nothing until it has the page catalog. Starting that
// request here — before React, before the lazily-chunked route, before the first
// render — is worth ~0.5 s of the cold page. Route-scoped on purpose: a `/pages`
// request on `/login` would be a request nobody reads.
if (window.location.pathname.startsWith("/stats") || window.location.pathname.startsWith("/analytics")) {
  prefetchPages();
}

/** A short result, in the console's theme and look: no loud colours. */
function ConsoleToaster() {
  const theme = useThemeStore((state) => state.theme);
  return (
    <Toaster
      position="bottom-right"
      theme={theme}
      toastOptions={{
        unstyled: true,
        classNames: { toast: "toast", success: "toast-success", error: "toast-error", warning: "toast-warning" },
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <App />
      <ConsoleToaster />
    </BrowserRouter>
  </QueryClientProvider>,
);
