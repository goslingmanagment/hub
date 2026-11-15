import { listPersonLoginsOf, type Database } from "@agency_hub_core/db";

/**
 * Numbers by person, not by login (products plan 2026-11-13 §4.2, package N): ONE place joins a person's logins for
 * the numbers reads, next to the teams (teams.ts). A person is the registry's (`person_logins`): a disabled or
 * deleted login stays theirs, so a chatter who got a new login keeps their old shifts. A login of nobody is a person
 * of its own.
 */

export interface LoginGroup {
  /** The registry's person; null — a login of nobody. */
  personId: number | null;
  /** The logins of the group among those asked, ascending. */
  userIds: number[];
}

/** The asked logins grouped by person, in the order of each group's first login asked. */
export async function groupLoginsByPerson(db: Database, userIds: readonly number[]): Promise<LoginGroup[]> {
  const personOf = new Map((await listPersonLoginsOf(db, userIds)).map((row) => [row.userId, row.personId]));
  const groups = new Map<string, LoginGroup>();
  for (const userId of userIds) {
    const personId = personOf.get(userId) ?? null;
    const key = personId === null ? `login:${userId}` : `person:${personId}`;
    const group = groups.get(key) ?? { personId, userIds: [] };
    if (!group.userIds.includes(userId)) group.userIds.push(userId);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({ ...group, userIds: [...group.userIds].sort((a, b) => a - b) }));
}

/** Every login of the person behind this one (the login alone when it is nobody's), ascending. */
export async function loginsOfPersonOf(db: Database, userId: number): Promise<LoginGroup> {
  const [own] = await listPersonLoginsOf(db, [userId]);
  if (own === undefined) return { personId: null, userIds: [userId] };
  const all = await listPersonLoginsOf(db);
  return { personId: own.personId, userIds: all.filter((row) => row.personId === own.personId).map((row) => row.userId).sort((a, b) => a - b) };
}

/** Every login of these people, ascending. */
export async function loginsOfPeople(db: Database, personIds: readonly number[]): Promise<number[]> {
  const wanted = new Set(personIds);
  return (await listPersonLoginsOf(db)).filter((row) => wanted.has(row.personId)).map((row) => row.userId).sort((a, b) => a - b);
}
