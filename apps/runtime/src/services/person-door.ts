import type { AuthPrincipal, HumanAuthPrincipal } from "./auth.ts";
import { AppError, ForbiddenError, UnauthorizedError } from "./errors.ts";
import type { AppContext } from "../bootstrap.ts";
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
 * default, `doorPerson`). `who`: `content_manager` — the owner and a content manager; `owner` — the owner alone (his
 * standing rules: a page's settings, the global switches, deleting a live post, «Убрать всё», the pages' sign-in state).
 * `console`: the console's operation it does the same as — the test owner's table (sandbox/owner-operations.ts) is asked
 * by it. tests/person-door.integration.test.ts walks every row.
 */
export const PERSON_DOOR_OPERATIONS = {
  // «Публикации»: the feed, the card, the platforms' schedules and the settings, and their actions.
  personPublicationList: { console: "adminPublicationList", who: "content_manager" },
  personPublicationGet: { console: "adminPublicationGet", who: "content_manager" },
  personPublicationApprove: { console: "adminPublicationApprove", who: "content_manager" },
  personPublicationCancel: { console: "adminPublicationCancel", who: "content_manager" },
  personPublicationWithdraw: { console: "adminPublicationWithdraw", who: "content_manager" },
  personPublicationReplace: { console: "adminPublicationReplace", who: "content_manager" },
  personPublicationResolve: { console: "adminPublicationResolve", who: "content_manager" },
  personPublicationQueueList: { console: "adminPublicationQueueList", who: "content_manager" },
  personPublicationQueueRefresh: { console: "adminPublicationQueueRefresh", who: "content_manager" },
  personPublicationSettingsList: { console: "adminPublicationSettingsList", who: "content_manager" },
  personPublicationSwitches: { console: "adminConfig", who: "content_manager" },
  personPublicationSettingsUpdate: { console: "adminPublicationSettingsUpdate", who: "owner" },
  personPublicationDeletePost: { console: "adminPublicationDeletePost", who: "owner" },
  personPublicationWithdrawPage: { console: "adminPublicationWithdrawPage", who: "owner" },
  personPublicationSwitchSet: { console: "adminConfigUpdate", who: "owner" },
  personFanslyLoginPages: { console: "syncPages", who: "owner" },
  // «Статистика»: what of a page's media is watched, bought and commented.
  personCreatorStatsContent: { console: "creatorStatsContent", who: "content_manager" },
  personCreatorStatsMedia: { console: "creatorStatsMedia", who: "content_manager" },
  personContentComments: { console: "contentComments", who: "content_manager" },
} as const satisfies Record<string, { console: string; who: "content_manager" | "owner" }>;

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
  const row = (PERSON_DOOR_OPERATIONS as Readonly<Record<string, { console: string; who: "content_manager" | "owner" }>>)[operation];
  if (row === undefined || body.client !== PERSON_DOOR_CLIENT) throw new ForbiddenError("Not an operation of the person's door");
  const person = await principalOfServerGrant(app, { client: body.client, grant: body.grant });
  if (person === null) throw new UnauthorizedError("The person's sign-in is over", { reason: null });
  const role = person.user.role;
  const allowed = row.who === "owner" ? role === "owner" : role === "owner" || role === "content_manager";
  if (!allowed) throw new ForbiddenError("Публикации и статистика контента открыты владельцу и контент-менеджеру");
  const sandbox = sandboxOwnerRefusal(row.console, person);
  if (sandbox) throw sandbox;
  return person;
}
