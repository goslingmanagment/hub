/**
 * The people registry on «Люди» and the person's card — the data layer
 * (contracts people.ts). A person is one record whatever their logins: the
 * list is one row per person, the card is `/people/<code>`.
 *
 * Reads:
 *   - `teamPeople` — everyone, no money: the owner's and a team lead's (Hub
 *     refuses a chatter). The owner also gets the logins no person holds.
 *   - `adminPerson` { code } — the owner's card of one person: every slot with
 *     its dates, the pay terms by model with their history, the agents'
 *     proposals. Money: never asked for in a team lead's session.
 *   - `adminPeopleProposals` { state: open } — the owner's: an agent's proposal
 *     of a new person waits on the list (it has no card yet).
 *   - `teamLedgerPayouts` { today } — the owner's: only the ledger's word on
 *     which terms price the days (`termsHubFrom`), for the terms card's line.
 *
 * Writes (the owner's): `adminPersonCreate` — a person with the invitation and
 * the pay terms in one call; `adminPersonUpdate` — working pages, a slot from
 * a day, rights, the record; `adminPersonPayTermSet` — terms of a model from a
 * day; `adminPersonImportNoteSettle` — «Сверено»; `adminPersonProposalDecide`.
 * Each answer is the card after the write: it goes into the cache as is, and
 * the list is read again. The access writes of a login stay in
 * src/screens/access/data.ts, unchanged.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  AdminPersonCreateBody,
  AdminPersonImportNoteSettleBody,
  AdminPersonPayTermBody,
  AdminPersonUpdateBody,
  KernelOperationResponse,
} from "@agency_hub_core/contracts";
import { KernelApiError } from "@agency_hub_core/ui/hubClient";
import { moscowToday } from "@agency_hub_core/ui/moscow";
import { kernel } from "@/shared/hub";
import { usersQuery } from "@/shared/reads";
import { PEOPLE_REGISTRY_KEY, teamPeopleQuery } from "@agency_hub_core/ui/people";

export type TeamPeople = KernelOperationResponse<"teamPeople">;
export type RegistryPerson = TeamPeople["people"][number];
export type RegistryLogin = RegistryPerson["logins"][number];
export type OwnerCard = KernelOperationResponse<"adminPerson">;
export type PayTerm = OwnerCard["payTerms"][number];
export type Slot = OwnerCard["scheduleSlots"][number];
export type Proposal = OwnerCard["proposals"][number];
export type CreatedPerson = KernelOperationResponse<"adminPersonCreate">;

const MINUTE = 60_000;
export const REGISTRY_KEY = PEOPLE_REGISTRY_KEY;
const cardKey = (code: string) => ["people", "person", code] as const;
const OPEN_PROPOSALS_KEY = ["people", "proposals", "open"] as const;

/** Everyone of the registry (`teamPeople`): the list, every card and every team screen's names read the same entry. */
export function useTeamPeople() {
  return useQuery(teamPeopleQuery(kernel));
}

/** The owner's card of one person (`adminPerson`): never enabled for anyone else. */
export function useOwnerCard(code: string, enabled: boolean) {
  return useQuery({
    queryKey: cardKey(code),
    queryFn: () => kernel.adminPerson({ params: { code } }),
    enabled: enabled && code !== "",
    staleTime: MINUTE,
  });
}

/** The agents' open proposals (`adminPeopleProposals`), the owner's: a proposed new person waits on the list. */
export function useOpenProposals(enabled: boolean) {
  return useQuery({
    queryKey: OPEN_PROPOSALS_KEY,
    queryFn: () => kernel.adminPeopleProposals({ query: { state: "open" } }),
    enabled,
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

/** The card the write answered with goes into the cache; the list and the proposals are read again. */
function settle(qc: QueryClient, card: OwnerCard) {
  qc.setQueryData(cardKey(card.person.code), card);
  qc.setQueryData<TeamPeople>(REGISTRY_KEY, (list) => list && {
    ...list,
    people: list.people.map((one) => (one.id === card.person.id ? card.person : one)),
  });
  return Promise.all([
    qc.invalidateQueries({ queryKey: REGISTRY_KEY, exact: true }),
    qc.invalidateQueries({ queryKey: OPEN_PROPOSALS_KEY, exact: true }),
  ]);
}

/** A new person, with the invitation and the pay terms, in ONE call; the link lives only in this mutation's result. */
export function useCreatePerson() {
  const qc = useQueryClient();
  return useMutation({
    gcTime: 0,
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminPersonCreateBody) => kernel.adminPersonCreate({ body }),
    onSuccess: async (created) => {
      const { invite: _secret, ...card } = created;
      qc.setQueryData(cardKey(card.person.code), card);
      await Promise.all([
        qc.invalidateQueries({ queryKey: REGISTRY_KEY, exact: true }),
        qc.invalidateQueries({ queryKey: usersQuery.queryKey, exact: true }),
      ]);
    },
  });
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

export function useSettleImportNote(code: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: AdminPersonImportNoteSettleBody) => kernel.adminPersonImportNoteSettle({ params: { code }, body }),
    onSuccess: (card) => settle(qc, card),
  });
}

/** «Принять» goes through the owner's own edit on Hub; the card is read again (its slots and pages may change). */
export function useDecideProposal() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: ({ proposalId, decision }: { proposalId: number; decision: "accept" | "reject"; code: string }) =>
      kernel.adminPersonProposalDecide({ params: { proposalId }, body: { decision } }),
    onSuccess: (_answer, { code }) => Promise.all([
      qc.invalidateQueries({ queryKey: cardKey(code), exact: true }),
      qc.invalidateQueries({ queryKey: REGISTRY_KEY, exact: true }),
      qc.invalidateQueries({ queryKey: OPEN_PROPOSALS_KEY, exact: true }),
    ]),
  });
}

// ── pure helpers ─────────────────────────────────────────────────────────────

/** The person holding a login, if any. */
export function personOfLogin(people: readonly RegistryPerson[], userId: number): RegistryPerson | null {
  return people.find((person) => person.logins.some((login) => login.userId === userId)) ?? null;
}

/** The logins that count: not deleted (a deleted login cannot be worked or switched off). */
export function liveLogins(person: Pick<RegistryPerson, "logins">): RegistryLogin[] {
  return person.logins.filter((login) => login.state !== "deleted");
}

/** The latest moment any of the person's logins was seen; null — never. */
export function lastSeenOf(person: Pick<RegistryPerson, "logins">): string | null {
  let best: string | null = null;
  for (const login of person.logins) if (login.lastSeenAt && (best === null || login.lastSeenAt > best)) best = login.lastSeenAt;
  return best;
}

/** Import notes the owner has not marked «Сверено». */
export function unsettledNotes(person: Pick<RegistryPerson, "importNotes">): number {
  return person.importNotes.filter((note) => note.settledAt === null).length;
}

/**
 * Whom a team lead's «Люди» shows: the people on the lead's pages — working
 * one of them, or with a shift there in the period (`worked`) — humans only.
 * The owner sees everyone.
 */
export function onPagesOf(person: RegistryPerson, pages: ReadonlySet<string> | null, worked: boolean): boolean {
  if (pages === null) return true;
  if (person.kind !== "human") return false;
  return worked || person.workingPages.some((page) => pages.has(page.pageLabel));
}

/** Hub's words of a refused write, for the screen: the reason it gave, else the status. */
export function refusal(error: unknown): { status: number | null; reason: string | null; message: string } {
  if (!(error instanceof KernelApiError)) return { status: null, reason: null, message: "" };
  const body = error.body as { reason?: unknown; message?: unknown } | null;
  return {
    status: error.status,
    reason: typeof body?.reason === "string" ? body.reason : null,
    message: typeof body?.message === "string" ? body.message : error.message,
  };
}
