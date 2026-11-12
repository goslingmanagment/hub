/**
 * Who a login is, on a team screen: the people registry's person (the one
 * read «Люди» lists, `teamPeople`), by any of their logins. One thing has one
 * name: a team screen shows the person's display name and the login only where
 * the login itself is the subject (the card's «Доступ и входы») or when no
 * person holds it. A person with several logins (an old and a new one, the
 * owner's own and their chatter's) is one person: `keyOf` groups their rows.
 * Both apps read it so: Workboard's screens and the console's Главная.
 */
import type { KernelClient } from "@kernel/sdk";
import type { TeamPeopleResponse } from "@agency_hub_core/contracts";

export type RegistryPerson = TeamPeopleResponse["people"][number];

/** The query key «Люди» reads the registry under: every screen shares the one answer. */
export const PEOPLE_REGISTRY_KEY = ["people", "registry"] as const;

/** The registry read (a team read: the owner's and team leads'; a chatter is refused it). */
export function teamPeopleQuery(kernel: KernelClient) {
  return {
    queryKey: PEOPLE_REGISTRY_KEY,
    queryFn: () => kernel.teamPeople(),
    staleTime: 60_000,
  };
}

export interface PeopleIndex {
  /** The person holding a login, if any. */
  personOf: (userId: number) => RegistryPerson | null;
  /** The person's display name; the login's own name when no person holds it (or the registry is not read). */
  nameOf: (userId: number, username: string) => string;
  /** One key per person (`person:<id>`), a login no person holds its own (`login:<id>`). */
  keyOf: (userId: number) => string;
  /**
   * The login's rows belong in a table of who works shifts: a chatter's, or a
   * login no person holds. The owner's and a team lead's logins only while they
   * have a shift there (as «Люди» lists them).
   */
  worksShifts: (userId: number) => boolean;
}

export function peopleIndex(people: readonly RegistryPerson[] | undefined): PeopleIndex {
  const byLogin = new Map<number, RegistryPerson>();
  for (const person of people ?? []) for (const login of person.logins) byLogin.set(login.userId, person);
  return {
    personOf: (userId) => byLogin.get(userId) ?? null,
    nameOf: (userId, username) => byLogin.get(userId)?.displayName ?? username,
    keyOf: (userId) => {
      const person = byLogin.get(userId);
      return person ? `person:${person.id}` : `login:${userId}`;
    },
    worksShifts: (userId) => {
      const person = byLogin.get(userId);
      return person === undefined || person.role === "chatter";
    },
  };
}

/** No registry (a chatter's session, or not read yet): every login is itself. */
export const LOGINS_ONLY: PeopleIndex = peopleIndex(undefined);
