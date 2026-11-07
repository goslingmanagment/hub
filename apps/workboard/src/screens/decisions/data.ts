import { queryOptions, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ClientSendCustodyListItem, ClientSendCustodyResolveBody, KernelOperationResponse, TeamShiftResolveBody } from "@agency_hub_core/contracts";
import { hubErrorStatus } from "@agency_hub_core/ui/hubClient";
import { moscowDayOf, moscowToday } from "@agency_hub_core/ui/moscow";
import { customsQuery, disputesQuery, heldSendsQuery } from "@/shared/decisions";
import { kernel } from "@/shared/hub";

/**
 * Решения — the data layer (spec §4.6). The screen reads only this file.
 *
 * Phase 1 adapter over today's operations; the reads and their keys are the
 * shared ones (src/shared/decisions.ts), so a decision made here moves the
 * sidebar's count at once:
 *   - disputes: `teamShiftDisputes` (31 days, the owner's only);
 *   - customs: `teamCustoms`;
 *   - held sends: `clientSendCustodyList` (held: the shared key; resolved: ours);
 *   - fan names: `pageFanCard` per fan — Hub sends the number only (phase 2: the
 *     name in each answer, see the report);
 *   - a dispute's evidence: `teamShiftSales` of the sale's two days — whose shift
 *     held the sale, to open that chatter's conversation with the fan (read only).
 *
 * Writes keep the console's requests and bodies:
 *   - a dispute's split: `teamShiftResolve` { params: { saleRef }, body: { shares } } —
 *     apps/dashboard/src/api/team.ts:134-145 (useResolveShiftDispute),
 *     apps/dashboard/src/pages/team/TeamPayoutsPage.tsx:93-134 (ResolveDialog);
 *   - a held send's resolve: `clientSendCustodyResolve` { params: { pageLabel, attemptId }, body } —
 *     apps/dashboard/src/api/clientHeldSends.ts:59-78, apps/dashboard/src/pages/ClientHeldSendsPage.tsx:421-432.
 * Both say their refusals themselves (no global toast) and never repeat by themselves.
 */

export type Dispute = KernelOperationResponse<"teamShiftDisputes">["disputes"][number];
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
  disputes: { open: Dispute[]; settled: Dispute[]; elsewhere: number } | null;
  customs: { paid: Custom[]; ordered: Custom[]; other: Custom[]; elsewhere: number; capped: boolean; serverNow: string } | null;
  held: { items: HeldSend[]; total: number; elsewhere: number; serverNow: string } | null;
}

export function useDecisions(options: { owner: boolean; page: string | null }) {
  const { owner, page } = options;
  const [disputes, customs, held, heldAll] = useQueries({
    queries: [
      { ...disputesQuery, enabled: owner, refetchInterval: MINUTE },
      { ...customsQuery, refetchInterval: MINUTE },
      { ...heldSendsQuery({ limit: HELD_LIMIT, offset: 0, ...(page ? { pageLabel: page } : {}) }), refetchInterval: MINUTE },
      // The queue of every page (the sidebar's own read): how many a page filter hides.
      { ...heldSendsQuery(), enabled: page !== null, refetchInterval: MINUTE },
    ],
  });

  const onPage = (label: string) => page === null || label === page;
  const view: DecisionsView = {
    disputes: disputes.data
      ? {
        open: disputes.data.disputes.filter((one) => one.resolution === null && onPage(one.pageLabel)),
        settled: disputes.data.disputes.filter((one) => one.resolution !== null && onPage(one.pageLabel)),
        elsewhere: disputes.data.disputes.filter((one) => one.resolution === null && !onPage(one.pageLabel)).length,
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

  const reads = owner ? [disputes, customs, held] : [customs, held];
  return {
    view,
    disputes,
    customs,
    held,
    /** The first load of anything: one skeleton for the screen. */
    loading: reads.some((query) => query.isLoading),
    fetching: reads.some((query) => query.isFetching),
    updatedAt: Math.max(0, ...reads.map((query) => query.dataUpdatedAt)),
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

// ── a dispute's evidence ─────────────────────────────────────────────────────

/** The shift of one claimant around the sale: the one holding it, else their last one before it that day. */
export interface SaleShift {
  userId: number;
  startedAt: string;
  endedAt: string;
  ongoing: boolean;
  /** The sale fell inside it. */
  holds: boolean;
}

/**
 * Whose shift held a disputed sale (`teamShiftSales` of the sale's Moscow day
 * and the day before: a night shift starts the evening before). Read only: the
 * owner opens each claimant's conversation with the fan in that shift's review.
 */
export function useSaleShifts(dispute: Pick<Dispute, "saleRef" | "occurredAt">) {
  const day = moscowDayOf(dispute.occurredAt);
  const today = moscowToday();
  const until = day > today ? today : day;
  return useQuery({
    queryKey: ["decisions", "sale-shifts", until] as const,
    queryFn: () => kernel.teamShiftSales({ query: { days: 2, until } }),
    staleTime: 5 * MINUTE,
    select: (data: KernelOperationResponse<"teamShiftSales">) => {
      const at = Date.parse(dispute.occurredAt);
      const byUser = new Map<number, SaleShift>();
      // Newest first: the first shift that holds the sale wins; else the latest that ended before it.
      for (const shift of data.shifts) {
        const start = Date.parse(shift.startedAt);
        const end = Date.parse(shift.endedAt);
        const holds = start <= at && at <= end;
        const before = end < at;
        const known = byUser.get(shift.userId);
        if (holds && !known?.holds) byUser.set(shift.userId, { userId: shift.userId, startedAt: shift.startedAt, endedAt: shift.endedAt, ongoing: shift.ongoing, holds: true });
        else if (before && !known) byUser.set(shift.userId, { userId: shift.userId, startedAt: shift.startedAt, endedAt: shift.endedAt, ongoing: shift.ongoing, holds: false });
      }
      return byUser;
    },
  });
}

// ── writes ───────────────────────────────────────────────────────────────────

/**
 * What a decision changes: the queues and their counts — not the fans' names
 * (`["decisions","fan",…]`), the people list or a sale's shifts, which a write
 * never changes (Р10: no N `pageFanCard` reads after every decision).
 */
function isQueueKey(query: { queryKey: readonly unknown[] }): boolean {
  const [area, kind] = query.queryKey;
  return area === "decisions" && kind !== "fan" && kind !== "users" && kind !== "sale-shifts";
}

/** The owner's split of a disputed sale: the console's request (`teamShiftResolve`), its refresh widened to Workboard's keys. */
export function useResolveDispute() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (input: { saleRef: string; body: TeamShiftResolveBody }) =>
      kernel.teamShiftResolve({ params: { saleRef: input.saleRef }, body: input.body }),
    onSettled: () => Promise.all([
      qc.invalidateQueries({ predicate: isQueueKey }),
      qc.invalidateQueries({ queryKey: ["payouts"] }),
    ]),
  });
}

/** Hub's answer to a resolve, in the owner's words (TeamPayoutsPage.tsx:77-86); nothing is retried by itself. */
export function disputeProblem(error: unknown): string {
  const status = hubErrorStatus(error);
  if (status === 409) return "Это больше не спор: отметки чаттеров сошлись. Ничего не записано.";
  if (status === 400) return "Hub не принял решение. Ничего не записано.";
  if (status === 403) return "Решать споры может только владелец. Ничего не записано.";
  if (status === 404) return "Hub не нашёл эту продажу. Ничего не записано.";
  if (status === 401) return "Вход закончился. Войдите снова и повторите: ничего не записано.";
  return "Hub не подтвердил запись: неизвестно, записано ли решение. Список перечитан: посмотрите, что стоит в строке спора.";
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
