import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { App } from "./App.js";
import { ConsoleToaster } from "./components/layout/ConsoleToaster.js";
import { prefetchPages } from "./api/pages.js";
import { queryClient } from "./lib/queryClient.js";
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

// A data router, for `useBlocker`: a long edit warns before it is left. The routes
// themselves stay `<Routes>` inside <App>, under this one catch-all.
const router = createBrowserRouter([
  {
    path: "*",
    element: (
      <>
        <App />
        <ConsoleToaster />
      </>
    ),
  },
]);

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
