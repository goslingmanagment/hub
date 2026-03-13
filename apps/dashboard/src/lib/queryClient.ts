import {
  MutationCache,
  QueryCache,
  QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";

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

function isApiErrorLike(error: unknown): error is { status: number; message: string } {
  return typeof error === "object" && error !== null && "status" in error && "message" in error;
}

function handleGlobalError(
  error: unknown,
  meta?: { suppressGlobalError?: boolean },
) {
  if (meta?.suppressGlobalError) {
    return;
  }

  if (isApiErrorLike(error) && error.status === 401) {
    return;
  }

  toast.error(error instanceof Error ? error.message : "Request failed");
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => handleGlobalError(error, query.meta),
  }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) =>
      handleGlobalError(error, mutation.meta),
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
}
