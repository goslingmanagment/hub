import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import type { ClientSendCustodyListItem, ClientSendCustodyResolveBody, KernelOperationResponse } from "@agency_hub_core/contracts";
import { kernel } from "@/shared/hub";

/**
 * A held send's resolve — its data (the window is HeldSends.tsx; «Ждут вас»,
 * screens/waiting, opens it from the send's line):
 *   - held sends: `clientSendCustodyList`, state `held` (the shared key of
 *     src/shared/decisions.ts);
 *   - fan names: `pageFanCard` per fan — Hub sends the number only.
 *
 * The one write keeps the console's request and body: a held send's resolve,
 * `clientSendCustodyResolve` { params: { pageLabel, attemptId }, body }.
 * It says its refusals itself (no global toast) and never repeats by itself.
 */

export type HeldSend = ClientSendCustodyListItem;

const MINUTE = 60_000;

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

/** A fan's reference Hub can look up: the platform's user number. */
export const isPlatformFanRef = (fan: FanRefOnPage): boolean => /^[1-9]\d{0,29}$/u.test(fan.fanRef);

/**
 * The names of a few fans (`pageFanCard`, one read each, long cached): the
 * questions and held sends carry the number only. A fan Hub does not
 * know, or a read that failed, stays «фан ·4821» — never the 18 digits.
 */
export function useFanNames(fans: readonly FanRefOnPage[]): (fan: FanRefOnPage) => KnownFan | undefined {
  // Only a platform's fan number can be looked up. A question from the ledger may name its fan by a username or a
  // label («общак …»): that row shows the name it came with, and no read is sent for it.
  const unique = [...new Map(fans.filter(isPlatformFanRef).map((fan) => [fanKey(fan), fan])).values()];
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
 * What a resolve changes: the held sends — not the fans' names
 * (`["decisions","fan",…]`) or the ledger's questions, which a write here
 * never changes (Р10: no N `pageFanCard` reads after every decision).
 */
function isQueueKey(query: { queryKey: readonly unknown[] }): boolean {
  const [area, kind] = query.queryKey;
  return area === "decisions" && kind !== "fan" && kind !== "sale-questions";
}

/**
 * A held send's resolve: the console's request (`clientSendCustodyResolve`).
 * Settled, not only succeeded: after a refusal the row may be gone, after a
 * lost answer the resolve may be recorded — the held sends are read again.
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
