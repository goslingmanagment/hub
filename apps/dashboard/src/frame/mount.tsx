import { QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { ConsoleToaster } from "@/components/layout/ConsoleToaster";
import { setFrameModel } from "@/lib/frameScope";
import { queryClient } from "@/lib/queryClient";
import { ContentScreen, type ContentScreenId } from "./ContentScreen.js";
import "../globals.css";

/** Starts one content screen (frame/*.html): its model from the first address, then the screen alone. */
export function mountContentScreen(screen: ContentScreenId, load: () => Promise<ComponentType>) {
  setFrameModel(new URLSearchParams(window.location.search).get("model"));
  const Screen = lazy(() => load().then((component) => ({ default: component })));
  const router = createBrowserRouter([
    {
      path: "*",
      element: (
        <>
          <ContentScreen screen={screen}>
            <Suspense fallback={<div role="status" className="py-16 text-center text-sm text-text-muted">Загружаем экран…</div>}>
              <Screen />
            </Suspense>
          </ContentScreen>
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
}
