import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { Toaster } from "sonner";
import { App } from "./App.js";
import { prefetchPages } from "./api/pages.js";
import { queryClient } from "./lib/queryClient.js";
import "./globals.css";

// Analytics is the only surface that needs the page catalog, and it can fire
// nothing until it has one. Starting that request here — before React, before
// the lazily-chunked route, before the first render — is worth ~0.5 s of the
// cold page. Route-scoped on purpose: a `/pages` request on `/login` or on any
// other dashboard load would be a request nobody reads.
if (window.location.pathname.startsWith("/analytics")) {
  prefetchPages();
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <App />
      <Toaster position="top-right" richColors />
    </BrowserRouter>
  </QueryClientProvider>,
);

// Temporary frontend-only CI validation; removed before merging.
