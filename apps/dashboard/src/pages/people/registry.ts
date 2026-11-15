/**
 * Hub «Люди» — the registry's reads and writes (contracts people.ts), the owner's (products plan §2.2, §4.3). A person
 * is one record whatever their logins: the list is one row per person, the card is `/people/<code>`. The types and the
 * pure helpers are shared with Workboard «Команда» (packages/ui/src/people/registry.ts); the login's access writes are
 * ./data.ts.
 *
 * Reads:
 *   - `teamPeople` — everyone (the owner also gets the logins no person holds); the test owner its test realm.
 *   - `adminPerson` { code } — the owner's card of one person: the record, every slot, the agents' proposals.
 *   - `adminPeopleProposals` { state: open } — the agency's owner's alone (the test owner may not read it, `fullOwner`):
 *     an agent's proposal of a new person waits on the list (it has no card yet).
 *   - `teamRoles` — the team records of every model.
 *
 * Writes: `adminPersonCreate` — a person with the invitation and the pay terms in one call; `adminPersonUpdate` — the
 * record and the rights; `adminPersonImportNoteSettle` — «Сверено»; `adminPersonProposalDecide`; `teamRoleSet`. Each
 * answer of a person's write is the card after it: it goes into the cache as is, and the list is read again.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  AdminPersonCreateBody,
  AdminPersonImportNoteSettleBody,
  AdminPersonUpdateBody,
} from "@agency_hub_core/contracts";
import { PEOPLE_REGISTRY_KEY, teamPeopleQuery } from "@agency_hub_core/ui/people";
import type { OwnerCard, TeamPeople } from "@agency_hub_core/ui/people/registry";
import type { TeamRoleChange } from "@agency_hub_core/ui/people/TeamRoles";
import { useAuthMe } from "@/api/auth";
import { kernel } from "@/api/sdk";
import { USERS_KEY } from "./data";

const MINUTE = 60_000;
const cardKey = (code: string) => ["people", "person", code] as const;
const OPEN_PROPOSALS_KEY = ["people", "proposals", "open"] as const;
const TEAM_ROLES_KEY = ["team", "roles"] as const;

/**
 * Who is looking: the owner (Hub's screens are the owner's alone), and whether it is the agency's owner or the test
 * team's (`me.test`: Hub refuses the test owner the agents' proposals, so the screens do not ask for them).
 */
export function useViewer(): { meId: number | null; fullOwner: boolean } {
  const me = useAuthMe().data;
  return { meId: me?.user.id ?? null, fullOwner: me?.user.role === "owner" && me.test !== true && me.narrow !== true };
}

/** Everyone of the registry (`teamPeople`): the list, every card and every team screen's names read the same entry. */
export function useTeamPeople() {
  return useQuery(teamPeopleQuery(kernel));
}

/** The owner's card of one person (`adminPerson`). */
export function useOwnerCard(code: string, enabled = true) {
  return useQuery({
    queryKey: cardKey(code),
    queryFn: () => kernel.adminPerson({ params: { code } }),
    enabled: enabled && code !== "",
    staleTime: MINUTE,
  });
}

/** The agents' open proposals (`adminPeopleProposals`): a proposed new person waits on the list. */
export function useOpenProposals(enabled: boolean) {
  return useQuery({
    queryKey: OPEN_PROPOSALS_KEY,
    queryFn: () => kernel.adminPeopleProposals({ query: { state: "open" } }),
    enabled,
    staleTime: MINUTE,
  });
}

/** The card the write answered with goes into the cache; the list and the proposals are read again. */
function settle(qc: QueryClient, card: OwnerCard) {
  qc.setQueryData(cardKey(card.person.code), card);
  qc.setQueryData<TeamPeople>(PEOPLE_REGISTRY_KEY, (list) => list && {
    ...list,
    people: list.people.map((one) => (one.id === card.person.id ? card.person : one)),
  });
  return Promise.all([
    qc.invalidateQueries({ queryKey: PEOPLE_REGISTRY_KEY, exact: true }),
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
        qc.invalidateQueries({ queryKey: PEOPLE_REGISTRY_KEY, exact: true }),
        qc.invalidateQueries({ queryKey: USERS_KEY, exact: true }),
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
      qc.invalidateQueries({ queryKey: PEOPLE_REGISTRY_KEY, exact: true }),
      qc.invalidateQueries({ queryKey: OPEN_PROPOSALS_KEY, exact: true }),
    ]),
  });
}

/** The team records of every model (`teamRoles`), for «Команды и права». */
export function useTeamRoles() {
  return useQuery({ queryKey: TEAM_ROLES_KEY, queryFn: () => kernel.teamRoles(), staleTime: MINUTE });
}

/** Grant or take back one record (`teamRoleSet`): the owner may every kind. */
export function useSetTeamRole(code: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (change: TeamRoleChange) => kernel.teamRoleSet({ body: { personCode: code, ...change } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: TEAM_ROLES_KEY }),
  });
}
