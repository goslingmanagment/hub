import {
  isTestPage,
  isTestShift,
  listTestTransactionIds,
  listLivePageIds,
  isTestUser,
  listTestPageIds,
  listTestUserIds,
  type Database,
} from "@agency_hub_core/db";

import { NotFoundError } from "../errors.ts";
import type { AuthenticatedUser, AuthPrincipal, HumanAuthPrincipal } from "../auth.ts";

/**
 * THE WALL of the test realm (migration 0412; products plan 2026-11-13 §8 «Тестовая команда на проде»).
 *
 * A model and a person can be test; a page is test through its model, a login through its person. The test team
 * lives on production beside the agency, and the wall runs both ways:
 *
 * - a LIVE principal (the owner, a chatter, every agent key) never reads or writes anything of the test realm: not
 *   in a list, a sum, a count, a search, a feed, a matter. Pages: `canAccessPage` refuses a test page to a live
 *   owner; the rest have no test page by the database (a live login never opens one, a live key is never granted
 *   one). Everything an owner reads WITHOUT a page filter cuts test rows with the conditions of
 *   `packages/db/src/repositories/realm.ts` (`livePageSql`, `liveUserSql`, …): each such read names them, and the
 *   proof test (tests/sandbox-realm-wall.integration.test.ts) walks every read of the contract before and after the
 *   seed and requires the same answers;
 * - a TEST principal reads and writes only the test realm. Its page scope is test pages only (a test owner's: every
 *   test page). A test OWNER («the owner of the test team», `t-owner`) is denied by default: it may call only the
 *   operations of `SANDBOX_OWNER_OPERATIONS` (sandbox/owner-operations.ts), each cut to the test realm.
 * - background work treats a test page like any page where that is what makes it testable (shift rows, whose a sale
 *   is, matters, custom-order checks), and never where it would reach the world: no platform sync, no egress, no
 *   Telegram, no AI spend, no ledger read (`SANDBOX_NO_DATA`).
 *
 * Nothing real is ever written under the test realm: the seed (`sandbox:seed`, sandbox/seed.ts) writes only rows
 * findable by the test marks, and removing them is the owner's word (`sandbox:remove`, sandbox/remove.ts).
 */

/** What a human principal carries about the realm. Absent on a live non-owner (their pages are live by the database). */
export interface PrincipalSandbox {
  /** The principal is a test person's login. */
  test: boolean;
  /** Every test page (deleted ones too): what a test owner sees, what a live owner never opens. */
  testPageIds: number[];
  /**
   * A live owner's page scope while a test realm exists: every live page, deleted and inactive ones included (an
   * owner's read keeps every row it reads today). Null when there is no test page: the owner's scope stays "no
   * filter", exactly as before the test realm.
   */
  livePageIds: number[] | null;
}

/** The answer of a read whose source is never asked for the test realm (the ledger, a platform). */
export const SANDBOX_NO_DATA = "нет данных" as const;

/**
 * The realm of a freshly authenticated human: the test mark of its person, and for an owner of either realm (or any
 * test login) the test pages. One small read per request; none for a live chatter beyond the mark itself.
 */
export async function principalSandboxOf(
  app: { db: Database },
  user: Pick<AuthenticatedUser, "id" | "role">,
): Promise<PrincipalSandbox | undefined> {
  const test = await isTestUser(app.db, user.id);
  if (!test && user.role !== "owner") {
    return undefined;
  }
  const testPages = await listTestPageIds(app.db);
  const livePages = !test && testPages.length > 0 ? await listLivePageIds(app.db) : null;
  return { test, testPageIds: testPages, livePageIds: livePages };
}

/** Whether a principal is a test person's login. Agent keys are always live. */
export function isTestPrincipal(principal: AuthPrincipal): principal is HumanAuthPrincipal & { sandbox: PrincipalSandbox } {
  return principal.kind !== "agent" && principal.sandbox?.test === true;
}

/** The test owner («the owner of the test team»): denied by default outside its table. */
export function isTestOwner(principal: AuthPrincipal): boolean {
  return isTestPrincipal(principal) && principal.user.role === "owner";
}

/**
 * The owner's page decision, for both realms: a live owner opens every page but a test one; a test owner only test
 * pages. Null for a principal that is not an owner (its grant decides).
 */
export function ownerCanAccessPage(principal: HumanAuthPrincipal, pageId: number): boolean {
  const testPages = principal.sandbox?.testPageIds ?? [];
  return principal.sandbox?.test === true ? testPages.includes(pageId) : !testPages.includes(pageId);
}

/**
 * The page scope of an OWNER (`pageScopeFor`): a test owner's is the test pages; a live owner's is "no filter" while
 * no test page exists, and every live page while one does. Undefined: no filter.
 */
export function ownerPageScope(principal: HumanAuthPrincipal): number[] | undefined {
  if (principal.sandbox?.test === true) return principal.sandbox.testPageIds;
  return principal.sandbox?.livePageIds ?? undefined;
}

/** Whether a page is a test page (for background work deciding what reaches the world). */
export async function pageIsTest(app: { db: Database }, pageId: number): Promise<boolean> {
  return isTestPage(app.db, pageId);
}

/** Whether a login is a test person's (for background work: no ledger, no Telegram, no AI). */
export async function userIsTest(app: { db: Database }, userId: number): Promise<boolean> {
  return isTestUser(app.db, userId);
}

/** The test logins, for a read that must drop them from a live answer computed in memory. */
export async function testUserIds(app: { db: Database }): Promise<Set<number>> {
  return new Set(await listTestUserIds(app.db));
}

/** The test pages, for a read that must drop them from a live answer computed in memory. */
export async function testPageIds(app: { db: Database }): Promise<Set<number>> {
  return new Set(await listTestPageIds(app.db));
}

/** The realm a principal reads and writes: test for a test person's login, live for everyone else (agents too). */
export function realmOf(principal: AuthPrincipal): "live" | "test" {
  return isTestPrincipal(principal) ? "test" : "live";
}

/**
 * THE OBJECT CHECK, one place for every operation that decides by the role alone: a principal acts on and sees
 * objects of its own realm only, whatever its role. An object of the other realm is «not found», as if it did not
 * exist (no oracle across the wall).
 */
export function requireSameRealm(principal: AuthPrincipal, objectIsTest: boolean, notFound: () => Error): void {
  if ((realmOf(principal) === "test") !== objectIsTest) throw notFound();
}

/** A shift of the principal's realm, or «not found» (an unknown shift is left to the operation's own answer). */
export async function requireShiftOfRealm(app: { db: Database }, principal: AuthPrincipal, shiftId: number): Promise<void> {
  const test = await isTestShift(app.db, shiftId);
  if (test !== null) requireSameRealm(principal, test, () => new NotFoundError("Shift not found"));
}

/** Sales of the principal's realm only, or «not found» (the deciders of whose a sale is, whatever the role). */
export async function requireSalesOfRealm(app: { db: Database }, principal: AuthPrincipal, transactionIds: readonly number[]): Promise<void> {
  if (transactionIds.length === 0) return;
  const test = new Set(await listTestTransactionIds(app.db, transactionIds));
  for (const id of transactionIds) requireSameRealm(principal, test.has(id), () => new NotFoundError("The sale was not found"));
}
