import {
  MutationCache,
  QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";

import { usePageFilterStore } from "@/stores/pageFilterStore";

declare module "@tanstack/react-query" {
  interface Register {
    mutationMeta: {
      suppressGlobalError?: boolean;
    };
    queryMeta: {
      suppressGlobalError?: boolean;
    };
  }
}

function isApiErrorLike(error: unknown): error is { status: number | null; message: string } {
  return typeof error === "object" && error !== null && "status" in error && "message" in error;
}

/**
 * A write's fallback, when its screen says nothing itself. A read has none: the
 * screen shows «Hub не ответил» in its place, and the raw English of the API is
 * never put over it (design-language.md §5.19, §7.2).
 */
function handleMutationError(
  error: unknown,
  meta?: { suppressGlobalError?: boolean },
) {
  if (meta?.suppressGlobalError) {
    return;
  }

  const status = isApiErrorLike(error) ? error.status : null;
  if (status === 401) {
    return;
  }

  toast.error(status === null || status >= 500
    ? "Hub не ответил: неизвестно, сохранилось ли."
    : "Не получилось. Hub вернул ошибку.");
}

export const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) =>
      handleMutationError(error, mutation.meta),
  }),
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

export function clearDashboardSession() {
  queryClient.clear();
  usePageFilterStore.getState().clear();
}
