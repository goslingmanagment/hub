import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { Toaster } from "@agency_hub_core/ui";
import { router } from "./app/routes.js";
import { queryClient } from "./shared/hub.js";
import "./app.css";

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
    <Toaster />
  </QueryClientProvider>,
);
