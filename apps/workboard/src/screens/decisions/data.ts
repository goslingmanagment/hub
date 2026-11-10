import { queryOptions, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ClientSendCustodyListItem, ClientSendCustodyResolveBody, KernelOperationResponse, TeamLedgerReportPost } from "@agency_hub_core/contracts";
import { pendingChangesOf, postOnPage, unparsedPosts, type PendingChange } from "@agency_hub_core/ui/shiftReports";
import { customsQuery, heldSendsQuery, reportChangesQuery, reportPostsQuery } from "@/shared/decisions";
import { kernel } from "@/shared/hub";

/**
 * Решения — the data layer (spec §4.6). The screen reads only this file.
 *
 * Phase 1 adapter over today's operations; the reads and their keys are the
 * shared ones (src/shared/decisions.ts), so a decision made here moves the
 * sidebar's count at once:
 *   - the shift reports' questions (the owner's only, the agency ledger's, the
 *     last month): the posts it could not use (`teamLedgerReports`) and the paid
 *     days whose report changed (`teamLedgerPayouts`) — read only: the owner's
 *     word on them is given to the ledger, not here;
 *   - customs: `teamCustoms`;
 *   - held sends: `clientSendCustodyList` (held: the shared key; resolved: ours);
 *   - fan names: `pageFanCard` per fan — Hub sends the number only (phase 2: the
 *     name in each answer, see the report).
 *
 * The one write keeps the console's request and body: a held send's resolve,
 * `clientSendCustodyResolve` { params: { pageLabel, attemptId }, body } —
 * apps/dashboard/src/api/clientHeldSends.ts:59-78, apps/dashboard/src/pages/ClientHeldSendsPage.tsx:421-432.
 * It says its refusals itself (no global toast) and never repeats by itself.
 */

export type Custom = KernelOperationResponse<"teamCustoms">["customs"][number];
export type HeldSend = ClientSendCustodyListItem;

const MINUTE = 60_000;
/** One page of the journal of resolved sends. */
export const RESOLVED_PAGE_SIZE = 25;
/** The held queue on this screen: Hub answers at most 100 a page; production has had 0–11. */
const HELD_LIMIT = 100;
/** The most rows `teamCustoms` answers. */
export const CUSTOMS_LIMIT = 200;
/** A custom paid longer ago than this is overdue. An assumption of the console's audit, not the owner's rule. */
export const CUSTOM_OVERDUE_DAYS = 7;

/** Future contract (phase 2, `teamDecisions`): one read of the screen, already cut to the page filter on the server. */
export interface DecisionsView {
  /** The posts the ledger could not use (on the page: a post of no known page is every page's) and the paid days whose report changed. */
  reports: { posts: TeamLedgerReportPost[]; changes: PendingChange[]; elsewhere: number } | null;
  customs: { paid: Custom[]; ordered: Custom[]; other: Custom[]; elsewhere: number; capped: boolean; serverNow: string } | null;
  held: { items: HeldSend[]; total: number; elsewhere: number; serverNow: string } | null;
}

export function useDecisions(options: { owner: boolean; page: string | null }) {
  const { owner, page } = options;
  const [posts, changes, customs, held, heldAll] = useQueries({
    queries: [
      { ...reportPostsQuery(), enabled: owner, refetchInterval: 5 * MINUTE },
      { ...reportChangesQuery(), enabled: owner, refetchInterval: 5 * MINUTE },
      { ...customsQuery, refetchInterval: MINUTE },
      { ...heldSendsQuery({ limit: HELD_LIMIT, offset: 0, ...(page ? { pageLabel: page } : {}) }), refetchInterval: MINUTE },
      // The queue of every page (the sidebar's own read): how many a page filter hides.
      { ...heldSendsQuery(), enabled: page !== null, refetchInterval: MINUTE },
    ],
  });

  const onPage = (label: string) => page === null || label === page;
  const view: DecisionsView = {
    reports: posts.data && changes.data
      ? {
        posts: unparsedPosts(posts.data).filter((post) => postOnPage(post, page)),
        changes: pendingChangesOf(changes.data),
        elsewhere: unparsedPosts(posts.data).filter((post) => !postOnPage(post, page)).length,
      }
      : null,
    customs: customs.data
      ? {
        paid: customs.data.customs.filter((one) => one.state === "paid" && onPage(one.pageLabel)),
        ordered: customs.data.customs.filter((one) => one.state === "ordered" && onPage(one.pageLabel)),
        other: customs.data.customs.filter((one) => one.state !== "paid" && one.state !== "ordered" && onPage(one.pageLabel)),
        elsewhere: customs.data.customs.filter((one) => one.state === "paid" && !onPage(one.pageLabel)).length,
        capped: customs.data.customs.length >= CUSTOMS_LIMIT,
        serverNow: customs.data.serverNow,
      }
      : null,
    held: held.data
      ? {
        items: held.data.items,
        total: held.data.total,
        elsewhere: page !== null && heldAll.data ? Math.max(0, heldAll.data.total - held.data.total) : 0,
        serverNow: held.data.serverNow,
      }
      : null,
  };

  const reads = owner ? [posts, changes, customs, held] : [customs, held];
  return {
    view,
    posts,
    changes,
    customs,
    held,
    /** The first load of anything: one skeleton for the screen. */
    loading: reads.some((query) => query.isLoading),
    fetching: reads.some((query) => query.isFetching),
    updatedAt: Math.max(0, ...reads.map((query) => query.dataUpdatedAt)),
    /** A read again failed: what the screen shows is the last good answer. */
    stale: reads.some((query) => query.isRefetchError),
    refetch: () => {
      for (const query of [...reads, heldAll]) if (query.isEnabled ?? true) void query.refetch();
    },
  };
}

/** The journal of sends resolved by hand, the last first (`clientSendCustodyList`, state `resolved`). */
export function resolvedSendsQuery(params: { offset: number; pageLabel?: string }) {
  return queryOptions({
    queryKey: ["decisions", "held-resolved", params] as const,
    queryFn: () => kernel.clientSendCustodyList({ query: { state: "resolved", limit: RESOLVED_PAGE_SIZE, ...params } }),
    placeholderData: (previous) => previous,
  });
}

export function useResolvedSends(params: { offset: number; pageLabel?: string }) {
  return useQuery(resolvedSendsQuery(params));
}

// ── fan names ────────────────────────────────────────────────────────────────

export interface FanRefOnPage {
  pageLabel: string;
  fanRef: string;
}

export interface KnownFan {
  name: string | null;
  username: string | null;
}

const fanKey = (fan: FanRefOnPage) => `${fan.pageLabel}\u0000${fan.fanRef}`;

/**
 * The names of a few fans (`pageFanCard`, one read each, long cached): the
 * disputes, customs and held sends carry the number only. A fan Hub does not
 * know, or a read that failed, stays «фан ·4821» — never the 18 digits.
 */
export function useFanNames(fans: readonly FanRefOnPage[]): (fan: FanRefOnPage) => KnownFan | undefined {
  const unique = [...new Map(fans.map((fan) => [fanKey(fan), fan])).values()];
  const results = useQueries({
    queries: unique.map((fan) => ({
      queryKey: ["decisions", "fan", fan.pageLabel, fan.fanRef] as const,
      queryFn: () => kernel.pageFanCard({ params: { pageLabel: fan.pageLabel, platformUserId: fan.fanRef } }),
      staleTime: 30 * MINUTE,
      select: (card: KernelOperationResponse<"pageFanCard">): KnownFan | null => {
        const account = card.accounts.find((one) => one.fanRef === fan.fanRef) ?? card.accounts[0];
        return account ? { name: account.displayName ?? null, username: account.username ?? null } : null;
      },
    })),
  });
  const known = new Map<string, KnownFan>();
  unique.forEach((fan, index) => {
    const data = results[index]?.data;
    if (data) known.set(fanKey(fan), data);
  });
  return (fan) => known.get(fanKey(fan));
}

// ── writes ───────────────────────────────────────────────────────────────────

/**
 * What a decision changes: the queues and their counts — not the fans' names
 * (`["decisions","fan",…]`) or the ledger's reads, which a write here never
 * changes (Р10: no N `pageFanCard` reads after every decision).
 */
function isQueueKey(query: { queryKey: readonly unknown[] }): boolean {
  const [area, kind] = query.queryKey;
  return area === "decisions" && kind !== "fan" && kind !== "report-posts" && kind !== "report-changes";
}

/**
 * A held send's resolve: the console's request (`clientSendCustodyResolve`).
 * Settled, not only succeeded: after a refusal the row may be gone, after a
 * lost answer the resolve may be recorded — both lists are read again.
 */
export function useResolveHeldSend() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (input: { pageLabel: string; attemptId: string; body: ClientSendCustodyResolveBody }) =>
      kernel.clientSendCustodyResolve({ params: { pageLabel: input.pageLabel, attemptId: input.attemptId }, body: input.body }),
    onSettled: () => qc.invalidateQueries({ predicate: isQueueKey }),
  });
}
