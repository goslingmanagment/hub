import { useCallback } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { SyncBlocksPage, WaitingGroupId } from "@agency_hub_core/contracts";

import type { OfapiStatus } from "@/lib/statusWords";
import { enginePageStatus } from "@/pages/settings/engine/enginePageSummary";
import { engineStatusState } from "@/pages/settings/engine/engineDisplay";
import { kernel } from "./sdk.js";

/**
 * «Ждут вас»: everything that waits for the person, as counts by the groups of
 * the list (design/ia.md §5; contracts waiting-groups.ts), each leading to its
 * group of the list in Workboard. Hub counts them from matters in one read: the
 * menu's number is that read's `total` and the home block shows its groups, so
 * they cannot differ. Neither the period nor the page filter touches it.
 *
 * No answer is not a zero: a group whose source did not answer says «не удалось
 * проверить» (or «N+» when it has some), and so does the block when Hub did not
 * answer at all. Read every minute, only while the tab is visible.
 */
export interface WaitingRow {
  /** The list's group. */
  id: WaitingGroupId;
  /** The group's words, as the list says them. */
  label: string;
  /** The group's tone (contracts waiting-groups.ts): `bad` something is broken, `warn` its outcome is not known. */
  tone: "bad" | "warn" | null;
  /** null: the group's source did not answer, and nothing of it is known to wait. */
  count: number | null;
  /** The group's source did not answer: there are at least this many. */
  capped: boolean;
  to: string;
}

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

export interface WaitingCounts {
  /** The groups to show, in the list's order: nothing with a zero. */
  rows: WaitingRow[];
  /** What waits, as Hub sums it: the menu's number. */
  total: number;
  /** The groups that could not be checked. */
  failed: WaitingRow[];
  loading: boolean;
  /** Hub did not answer at all: nothing is known, which is not «nothing waits». */
  unanswered: boolean;
  refetchAll: () => void;
}

export function useWaitingCounts(role: string): WaitingCounts {
  const team = role === "owner" || role === "team_lead";
  // The menu's read and key (packages/ui place.ts `waitingQuery`): the chips and the number are one answer.
  const waiting = useQuery({
    queryKey: ["matters", "waiting", ""],
    queryFn: () => kernel.mattersWaiting({ query: {} }),
    enabled: team,
    refetchInterval: MINUTE,
    meta: { suppressGlobalError: true },
  });
  // The chips are the list's groups (contracts waiting-groups.ts, counted by Hub): the list's titles and numbers,
  // summing to the menu's number. A group whose source did not answer says «не удалось проверить», or «N+» when it
  // has some.
  const rows: WaitingRow[] = (waiting.data?.groups ?? []).map((group) => ({
    id: group.id, label: group.title, tone: group.tone,
    count: !group.checked && group.count === 0 ? null : group.count, capped: !group.checked, to: group.to,
  }));
  return {
    rows,
    total: waiting.data?.total ?? 0,
    failed: rows.filter((row) => row.count === null),
    loading: team && waiting.data === undefined && !waiting.isError,
    unanswered: waiting.data === undefined && waiting.isError,
    refetchAll: () => void waiting.refetch(),
  };
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
