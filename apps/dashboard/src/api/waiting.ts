import { useCallback } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { SyncBlocksPage } from "@agency_hub_core/contracts";

import type { OfapiStatus } from "@/lib/statusWords";
import { enginePageStatus } from "@/pages/settings/engine/enginePageSummary";
import { engineStatusState } from "@/pages/settings/engine/engineDisplay";
import { kernel } from "./sdk.js";

const MINUTE = 60_000;

/**
 * Whether the OnlyFans API is on, with the read behind it (design/screens/system.md
 * §0.2). `off` is said only when every process reported the key unset; a process
 * that does not know makes the answer `unknown`, and so does no answer. A team lead
 * cannot read the config: always `unknown`, without a request.
 *
 * The config is a large read and the key changes by the owner's hand (a change in
 * the console refreshes it): a screen reads it when it opens, not on a timer.
 */
export function useOfapiStatusQuery(role: string): { status: OfapiStatus; isLoading: boolean; refetch: () => void } {
  const config = useQuery({
    queryKey: ["admin", "config"],
    queryFn: () => kernel.adminConfig(),
    enabled: role === "owner",
    meta: { suppressGlobalError: true },
  });
  const { refetch } = config;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  // The secret's own state, not `runningState`: that is always `unknown` for a secret.
  const states = config.data?.subsystems.flatMap((subsystem) => subsystem.items).find((item) => item.key === "ofapiApiKey")?.running.map((entry) => entry.state) ?? [];
  const status: OfapiStatus = states.length === 0 || states.some((state) => state !== "set" && state !== "unset")
    ? "unknown"
    : states.every((state) => state === "unset") ? "off" : "on";
  return { status, isLoading: config.isLoading, refetch: retry };
}

/** The one answer every screen asks: `on`, `off`, or `unknown` when it cannot be said. */
export function useOfapiStatus(role: string): OfapiStatus {
  return useOfapiStatusQuery(role).status;
}

/**
 * The Fansly pages that need a login, the owner's read («Публикации» says it beside a page that cannot publish):
 * the same rule Hub's matter «Нужен вход в Fansly» follows (tests/matters-rules.test.ts runs both).
 */
export function useFanslyLoginPages(role: string): readonly string[] {
  const [overview, enginePages] = useQueries({
    queries: [
      {
        queryKey: ["syncBlocks", "overview"],
        queryFn: () => kernel.syncOverview(),
        enabled: role === "owner",
        refetchInterval: MINUTE,
        meta: { suppressGlobalError: true },
      },
      {
        queryKey: ["syncEngine", "pages"],
        queryFn: () => kernel.syncPages(),
        enabled: role === "owner",
        refetchInterval: MINUTE,
        meta: { suppressGlobalError: true },
      },
    ],
  });
  return fanslyPagesNeedingLogin(overview.data?.pages, enginePages.data?.pages);
}

/** The Fansly pages whose browser was signed out or whose login Fansly refuses. */
function fanslyPagesNeedingLogin(
  blocks: readonly SyncBlocksPage[] | undefined,
  engine: Parameters<typeof engineStatusState>[0][] | undefined,
): string[] {
  if (!blocks) return [];
  return blocks
    .filter((page) => page.platform === "fansly")
    .filter((page) => {
      const status = engine?.find((candidate) => candidate?.pageLabel === page.pageLabel);
      return enginePageStatus(page, engineStatusState(status)).kind === "login";
    })
    .map((page) => page.pageLabel);
}
