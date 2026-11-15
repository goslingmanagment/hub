/**
 * The people registry as «Команда» reads it (contracts people.ts): the team at work. Who a person is and what they may
 * (logins, page access, rights, the invite, proposals) is Hub «Люди» (apps/dashboard/src/pages/people); the types and
 * the pure helpers both draw with are packages/ui/src/people/registry.ts.
 *
 * Reads:
 *   - `teamPeople` — the owner everyone, anyone else the people of their teams (products package T).
 *   - `adminPerson` { code } — the owner's card of one person: every slot with its dates, the pay terms by model.
 *     Money: never asked for in anyone else's session.
 *   - `teamLedgerPayouts` { today } — the owner's: only the ledger's word on which terms price the days.
 *
 * Writes (the owner's): `adminPersonUpdate` — working pages and a slot from a day; `adminPersonPayTermSet` — terms of a
 * model from a day. Each answer is the card after the write: it goes into the cache as is, and the list is read again.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { AdminPersonPayTermBody, AdminPersonUpdateBody } from "@agency_hub_core/contracts";
import { moscowToday } from "@agency_hub_core/ui/moscow";
import { PEOPLE_REGISTRY_KEY } from "@agency_hub_core/ui/people";
import type { OwnerCard, TeamPeople } from "@agency_hub_core/ui/people/registry";
import { kernel } from "@/shared/hub";

export {
  lastSeenOf, liveLogins, onPagesOf, personOfLogin, refusal, slotSummary, unsettledNotes,
  type OwnerCard, type PayTerm, type Proposal, type RegistryLogin, type RegistryPerson, type Slot, type TeamPeople,
} from "@agency_hub_core/ui/people/registry";

const MINUTE = 60_000;
export const REGISTRY_KEY = PEOPLE_REGISTRY_KEY;
const cardKey = (code: string) => ["people", "person", code] as const;

export { useTeamPeople } from "./teamPeople";

/** The owner's card of one person (`adminPerson`): never enabled for anyone else. */
export function useOwnerCard(code: string, enabled: boolean) {
  return useQuery({
    queryKey: cardKey(code),
    queryFn: () => kernel.adminPerson({ params: { code } }),
    enabled: enabled && code !== "",
    staleTime: MINUTE,
  });
}

/**
 * Since when the ledger prices a day by the terms of this registry (`termsHubFrom` of `teamLedgerPayouts`, its switch
 * `payroll_terms_hub_from`): a day; null — not switched, the payout sheets price the days; undefined — not known yet
 * (asking, or the ledger did not answer). The owner's only.
 */
export function useTermsHubFrom(enabled: boolean): string | null | undefined {
  const today = moscowToday();
  const query = useQuery({
    queryKey: ["people", "terms-hub-from", today] as const,
    queryFn: () => kernel.teamLedgerPayouts({ query: { from: today, to: today } }),
    enabled,
    staleTime: 10 * MINUTE,
    retry: false,
  });
  return query.data?.termsHubFrom;
}

/** The card the write answered with goes into the cache; the list is read again. */
function settle(qc: QueryClient, card: OwnerCard) {
  qc.setQueryData(cardKey(card.person.code), card);
  qc.setQueryData<TeamPeople>(REGISTRY_KEY, (list) => list && {
    ...list,
    people: list.people.map((one) => (one.id === card.person.id ? card.person : one)),
  });
  return qc.invalidateQueries({ queryKey: REGISTRY_KEY, exact: true });
}

export function useUpdatePerson(code: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminPersonUpdateBody) => kernel.adminPersonUpdate({ params: { code }, body }),
    onSuccess: (card) => settle(qc, card),
  });
}

/** Money: the owner's only. */
export function useSetPayTerm(code: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminPersonPayTermBody) => kernel.adminPersonPayTermSet({ params: { code }, body }),
    onSuccess: (card) => settle(qc, card),
  });
}

/** The pages of the catalog, for choosing working pages (`adminPages`, the owner's). */
export function useCatalogPages(enabled = true) {
  return useQuery({ queryKey: ["access", "pages"] as const, queryFn: () => kernel.adminPages(), enabled, staleTime: 5 * MINUTE });
}
