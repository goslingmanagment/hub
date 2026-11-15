import { findLoginPersonScope } from "@agency_hub_core/db";
import type { UserRole } from "@agency_hub_core/shared";

import type { AuthPrincipal, HumanAuthPrincipal } from "./auth.ts";
import { AppError, ForbiddenError, UnauthorizedError } from "./errors.ts";
import type { AppContext } from "../bootstrap.ts";
import { hideObjectsOfOtherRealm } from "./sandbox/objects.ts";
import { sandboxOwnerRefusal } from "./sandbox/owner-operations.ts";
import { principalOfServerGrant } from "./signin-handoff.ts";

/**
 * ContentOps acts in Hub AS THE SIGNED-IN PERSON (products plan §2.4, package C2: «Публикации» and «Статистика» are
 * ContentOps' own screens, Hub stays the engine). Its server calls these routes with its own key (`signin:contentops`)
 * and the person's live sign-in grant; Hub resolves the grant to that person's principal (signin-handoff.ts
 * `principalOfServerGrant`) and runs the same service functions the console's routes run, so the rights are Hub's alone:
 * the owner every page of his realm, a content manager the pages of the models of her working pages (`pageScopeFor`),
 * anyone else nothing. Every change is recorded as the person's (`auditCtx` of the person), never as the key's.
 *
 * THIS TABLE is every operation of the door, AND NOTHING ELSE: a route of the door that is not here refuses (deny by
 * default, `doorPerson`). The mechanism is not publications': another package adds a row here and nothing else of it.
 *
 * Adding a row: (1) its contract entry in packages/contracts (key = the row's key, `auth: { kind: "agentKey" }`,
 * `tags: ["person-door"]`, body extends `{ client: "contentops", grant }`, path under `/api/v1/person/`); (2) its route
 * calls `doorPerson(app, agentKey, request.body, "<row key>")` and then the console's own service with the returned
 * person; (3) the row here with its `console` operation and `roles`; (4) its call in `CALLS` of
 * tests/person-door.integration.test.ts — the test fails until every `person-door` route of the contract is a row and
 * has a call, and walks it as every persona by `roles`. The owner's standing rules (a page's settings, the global
 * switches, deleting a live post, «Убрать всё», the pages' sign-in state) are rows of `OWNER`.
 */
/** Who opens a row: the owner and a content manager (her pages), or the owner alone. A row may name any roles. */
const SCREEN = ["owner", "content_manager"] as const satisfies readonly UserRole[];
const OWNER = ["owner"] as const satisfies readonly UserRole[];
/**
 * «Съёмка»'s custom orders: the owner, a content manager, and whoever leads customs of a model — a chatter's login
 * (package C3; a team lead's side of an order is the check, in Workboard). Who reads and moves which order is cut by
 * services/custom-orders/person.ts: a chatter who leads no customs reads none.
 */
const SHOOTING = ["owner", "content_manager", "chatter"] as const satisfies readonly UserRole[];
/**
 * A content manager's publications and statistics are HER WORKING PAGES' (plan §11 item 13: «КМ OF Лоры видит общую
 * библиотеку Лоры, а план и публикации — своих страниц»): Lora's OnlyFans content manager neither reads nor approves
 * the posts of Lora's Fansly pages. «Съёмка» keeps its own rule (custom-orders/person.ts); the owner, his realm.
 */
const OWN = "working" as const;

export const PERSON_DOOR_OPERATIONS = {
  // «Публикации»: the feed, the card, the platforms' schedules and the settings, and their actions.
  personPublicationList: { console: "adminPublicationList", roles: SCREEN, pages: OWN },
  personPublicationGet: { console: "adminPublicationGet", roles: SCREEN, pages: OWN },
  // The card's «Стена» and «Тиры»: the page's walls and tiers by name, never prices (the agents' read).
  personPublicationTargets: { console: "adminPublicationGet", roles: SCREEN, pages: OWN },
  personPublicationApprove: { console: "adminPublicationApprove", roles: SCREEN, pages: OWN },
  personPublicationCancel: { console: "adminPublicationCancel", roles: SCREEN, pages: OWN },
  personPublicationWithdraw: { console: "adminPublicationWithdraw", roles: SCREEN, pages: OWN },
  personPublicationReplace: { console: "adminPublicationReplace", roles: SCREEN, pages: OWN },
  personPublicationResolve: { console: "adminPublicationResolve", roles: SCREEN, pages: OWN },
  personPublicationQueueList: { console: "adminPublicationQueueList", roles: SCREEN, pages: OWN },
  personPublicationQueueRefresh: { console: "adminPublicationQueueRefresh", roles: SCREEN, pages: OWN },
  personPublicationSettingsList: { console: "adminPublicationSettingsList", roles: SCREEN, pages: OWN },
  // Read beside the settings: the publishing switches alone, never the rest of the config.
  personPublicationSwitches: { console: "adminPublicationSettingsList", roles: SCREEN, pages: OWN },
  personPublicationSettingsUpdate: { console: "adminPublicationSettingsUpdate", roles: OWNER, pages: OWN },
  personPublicationDeletePost: { console: "adminPublicationDeletePost", roles: OWNER, pages: OWN },
  personPublicationWithdrawPage: { console: "adminPublicationWithdrawPage", roles: OWNER, pages: OWN },
  personPublicationSwitchSet: { console: "adminConfigUpdate", roles: OWNER },
  personFanslyLoginPages: { console: "syncPages", roles: OWNER },
  // «Статистика»: what of a page's media is watched, bought and commented.
  personCreatorStatsContent: { console: "creatorStatsContent", roles: SCREEN, pages: OWN },
  personCreatorStatsMedia: { console: "creatorStatsMedia", roles: SCREEN, pages: OWN },
  personContentComments: { console: "contentComments", roles: SCREEN, pages: OWN },
  // «Съёмка» (package C3): the shooting side of custom orders, and its steps.
  personCustomOrderList: { console: "customOrdersBoard", roles: SHOOTING },
  personCustomOrderStep: { console: "customOrderAct", roles: SHOOTING },
} as const satisfies Record<string, PersonDoorRow>;

/**
 * A row of the door: `console` — the console's operation it does the same as (the test owner's table is asked by it);
 * `roles` — the Hub roles of the people it serves. What a person reads or changes within it is cut by the operation's
 * own service by the person's page scope and realm (`pageScopeFor`, `canAccessPage`, the realm's SQL), never here.
 */
export interface PersonDoorRow {
  console: string;
  roles: readonly UserRole[];
  /** `working`: a content manager acts on her own working pages alone, not every page of her models. */
  pages?: typeof OWN;
}

export type PersonDoorOperation = keyof typeof PERSON_DOOR_OPERATIONS;

/** The one client that acts as a person here: ContentOps, the content manager's product. */
export const PERSON_DOOR_CLIENT = "contentops";
const CAPABILITY = "signin:contentops";

/** The grant is over (signed out, revoked, expired, closed): ContentOps ends its own session or asks again. */
export const GRANT_OVER_REASON = "grant_inactive";

/**
 * The person a door request acts as, or the refusal: the key must be ContentOps' (`signin:contentops`), the grant live,
 * the operation on the table and open to the person's role; the test owner keeps to his own table.
 */
export async function doorPerson(
  app: AppContext,
  key: AuthPrincipal,
  body: { client: string; grant: string },
  operation: string,
): Promise<HumanAuthPrincipal> {
  if (key.kind !== "agent" || !key.capabilities.includes(CAPABILITY)) {
    throw new AppError(`agent key lacks the ${CAPABILITY} capability`, 403, "agent_capability_missing");
  }
  const row = (PERSON_DOOR_OPERATIONS as Readonly<Record<string, PersonDoorRow>>)[operation];
  if (row === undefined || body.client !== PERSON_DOOR_CLIENT) throw new ForbiddenError("Not an operation of the person's door");
  const person = await principalOfServerGrant(app, { client: body.client, grant: body.grant });
  if (person === null) throw new UnauthorizedError("The person's sign-in is over", { reason: null });
  if (!row.roles.includes(person.user.role)) throw new ForbiddenError("Это действие вашей роли не открыто");
  const sandbox = sandboxOwnerRefusal(row.console, person);
  if (sandbox) throw sandbox;
  // The wall by object, as the console's own operation would meet it (sandbox/objects.ts): the key is live, the person
  // may be test, so the request's objects are checked against the PERSON's realm (the body is the request's own, so the
  // operation below reads what was hidden).
  await hideObjectsOfOtherRealm(app, person, row.console, [body as unknown as Record<string, unknown>]);
  if (row.pages === OWN && person.user.role === "content_manager") {
    const scope = await findLoginPersonScope(app.db, person.user.id);
    const own = scope === null || scope.state === "left" ? [] : scope.workingPageIds;
    return { ...person, assignedPageIds: own.filter((id) => person.assignedPageIds.includes(id)) };
  }
  return person;
}
