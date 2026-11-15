import { ForbiddenError } from "../errors.ts";
import type { AuthPrincipal } from "../auth.ts";
import { isTestOwner } from "./realm.ts";

/**
 * What the owner of the test team (`t-owner`: a login with the owner's role whose person is test) may call: THIS TABLE
 * AND NOTHING ELSE. Every other operation answers 403 to it, before its handler runs (api/server.ts, the policy hook),
 * whatever the route's own declaration admits — so an operation added later is closed to it until it is written here.
 *
 * On it: the team's operations and the people registry's, each cut to the test realm (its page scope is the test pages,
 * `pageScopeFor`; the registry lists the test realm, `PeopleRealm`). Not on it, ever: the agency's money, costs, traffic,
 * model applications, settings, system, agent keys, AI, sync, publications of live pages, the ledger, pay terms.
 * tests/sandbox-realm-wall.integration.test.ts calls every operation of the contract as `t-owner` and requires 403 for
 * each one that is not here.
 */
export const SANDBOX_OWNER_OPERATIONS: ReadonlySet<string> = new Set([
  // Who am I; signing out of a device.
  "me",
  "authListDevices",
  "authRevokeDevice",
  "authRevokeAllDevices",
  "authChangePassword",
  // The pages and models it sees: the test ones (pageScopeFor).
  "pages",
  "models",
  // The people registry, of the test realm.
  "teamPeople",
  "adminPerson",
  "adminPersonCreate",
  "adminPersonUpdate",
  // The team: shifts, numbers, sales, the review, on the test pages.
  "teamShifts",
  "teamChatterStats",
  "teamChatterNumbers",
  "teamShiftSales",
  "teamSalesPpv",
  "teamSalesReplies",
  "teamSalesList",
  // A sale's chain, opened from «Список продаж»: a sale of the test realm only (else 404), the ledger never asked.
  "saleChain",
  // «Обучение»: the pages are the live agency's, so a test principal reads none (learn-pages.ts); approving is not here.
  "learnPages",
  "learnPage",
  "teamQuestions",
  "teamQuestionAsk",
  "teamQuestionAnswer",
  "teamQuestionClose",
  "teamAuthorship",
  "teamEmptyHours",
  "teamGreetings",
  "teamShiftReview",
  "teamWinBackResults",
  "shiftReportNotes",
  "shiftReportsList",
  "shiftReport",
  // Workboard «Сегодня», «Смены → Мои/График» and «Команда → Новички» (products package W): its own shifts (none: an
  // owner works none), the teams of the test realm (the models of its realm, `workboardToday`), the test realm's newcomers.
  "workboardToday",
  "accountShifts",
  "teamNewcomers",
  // What waits for it: the test realm's matters.
  "mattersList",
  "mattersWaiting",
  // Customs of the test pages.
  "customOrdersBoard",
  "customOrder",
  // The owner's word on whose a sale is: a dispute or a question (the pot's too), «мимо площадки». Each names a sale or a
  // line of the test realm, else 404 (the sale-claims module's `requireDecidedOfRealm`; the list is cut to the realm).
  "saleDispute",
  "saleDisputeOfClaim",
  "saleDisputeDecide",
  "offPlatformPending",
  "offPlatformDecide",
  // Teams (package T): the records of the test models (a person and a model of the test realm, else 404) and the
  // notes on the test shifts.
  "teamRoles",
  "teamRoleSet",
  "reviewNotes",
  "reviewNoteAdd",
]);

/** The refusal of an operation off the table, for a test owner; null for anyone else or an operation on it. */
export function sandboxOwnerRefusal(routeKey: string, principal: AuthPrincipal | null | undefined): ForbiddenError | null {
  if (!principal || !isTestOwner(principal) || SANDBOX_OWNER_OPERATIONS.has(routeKey)) return null;
  return new ForbiddenError("Этого в тестовой команде нет");
}
