import {
  CLIENT_MANUAL_GROUP_REF_PREFIX,
  type ClientClaimGroup,
  type ClientClaimSendGroup,
  type ClientFanClaimBody,
  type ClientFanClaimResponse,
  type ClientSendCustodyItem,
  type ClientSendCustodyResolveBody,
} from "@agency_hub_core/contracts";
import {
  applyClientClaimAction,
  findClientSendCustodyItem,
  findPageSummaryByLabel,
  getClientConfigRevision,
  readClientFanClaimStatus,
  readClientPreviewSendRetryAfterMs,
  resolveClientSendCustody,
  type ClientBootstrapPageRow,
  type ClientClaimActionInput,
  type ClientClaimRejectionCode,
  type ClientFanClaimView,
  type ClientSendRate,
  type Database,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { canAccessPage, requireApiKeyUser, requireDashboardUser, type AuthPrincipal, type HumanAuthPrincipal } from "./auth.ts";
import {
  admitClientSend,
  clientClaimGroupKind,
  clientCustodyExistsOn,
  type ClientSendAdmission,
} from "./client-claim-admission.ts";
import { clientVersionRefusal } from "./client-features.ts";
import {
  CLIENT_BOOTSTRAP_CONFIG_KEYS,
  clientFeatureRefusal,
  loadClientSwitchesForSend,
  requireClientFeature,
  requireClientGrantedPage,
  requireClientPage,
  type ClientFeatureRequest,
} from "./client-switches.ts";
import {
  BadRequestError,
  ClientClaimRefusedError,
  ClientFeatureDisabledError,
  ClientPreviewSendRateLimitedError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "./errors.ts";

/**
 * chat-extension H-7b: the greeting lease and the send custody of one fan, as
 * routes (`clientFanClaim`, `clientFanClaimStatus`, `clientSendCustodyResolve`).
 *
 * The rules are the repository's (packages/db client-claim.ts, the pure
 * decideClaimTransition): this file decides who may ask, which of the owner's
 * switches an action waits for, and how a view and a refusal travel.
 *
 * WHICH SWITCH AN ACTION WAITS FOR (what a platform takes is the admission
 * table, client-claim-admission.ts: R20 architecture §11.1)
 * - `claim`, `renew`: the `newcomers` feature, like every flagged client route.
 * - `dispatch`: the platform's admission of its purpose and group, then the
 *   flags that admission names (OnlyFans: `previewSend`, and `newcomers` too
 *   for a greeting; Fansly: a greeting only, under `newcomers` without
 *   `previewSend`), all read INSIDE the dispatch's transaction from rows held
 *   locked (loadClientSwitchesForSend), after the repeat check: a repeat of an
 *   attempt the hub already holds reads its state whatever the switches say
 *   now, so a client that lost the first answer learns it has no ticket and
 *   reports `failed`. The rate it counts toward is the admission's too.
 * - the status read: no flag, so the master switch and the minimum version only
 *   (requireClientPage), on a page of a platform where the custody exists. It
 *   answers while `previewSend` and `newcomers` are off.
 * - `release`, `sent`, `failed`: the page grant only. They end a lease or a send
 *   the hub already admitted; a switch turned off in between must not strand it
 *   (an unreported send holds the fan until someone resolves it by hand).
 * - `registerNativeSend`: the page grant and the platform's admission of its
 *   purpose and group only, no flag. The message is already in the chat when
 *   the report comes, and the client ends a registration on any answer.
 *   Refused by the master switch, a flag or the minimum version, the fan would
 *   read as not greeted and a colleague would greet again. It admits nothing: a
 *   dispatch after it waits for its switches.
 *
 * Database only: nothing here asks OnlyFans or queues work. The hub never sends
 * the message; the ticket only marks the page-world command of the client.
 */

const NEWCOMERS_FLAG = "newcomers";
const PREVIEW_SEND_FLAG = "previewSend";
/** How a refusal names the claim actions and the status read, which have no flag of their own. */
const CLAIM_FEATURE = "claim";

/** Postgres spells a uuid in lower case, and the repository compares ids as text. */
const id = (value: string) => value.toLowerCase();

function toWire(view: ClientFanClaimView, flagRevision: number): ClientFanClaimResponse {
  return {
    greeting: {
      state: view.greeting.state,
      at: view.greeting.at?.toISOString() ?? null,
      messageRef: view.greeting.messageRef,
      source: view.greeting.source,
    },
    lease: {
      state: view.lease.state,
      leaseToken: view.lease.leaseToken,
      expiresAt: view.lease.expiresAt?.toISOString() ?? null,
      heldBy: view.lease.heldBy,
    },
    group: view.group && {
      generationRef: view.group.generationRef,
      variant: view.group.variant,
      partCount: view.group.partCount,
      sentParts: view.group.sentParts,
      heldParts: view.group.heldParts,
    },
    custody: view.custody && {
      attemptId: view.custody.attemptId,
      state: view.custody.state,
      ticket: view.custody.ticket,
      ticketExpiresAt: view.custody.ticketExpiresAt?.toISOString() ?? null,
    },
    serverNow: view.serverNow.toISOString(),
    flagRevision,
  };
}

/** Whose rate window a 429 advises on: the dispatch's user, page and rate. */
interface RateScope {
  userId: number;
  pageId: number;
  rate?: ClientSendRate;
}

/** The repository's refusal as the route answers it (docs/error-handling.md §3). */
async function refuse(app: AppContext, code: ClientClaimRejectionCode, scope: RateScope): Promise<never> {
  switch (code) {
    case "invalid_request":
      throw new BadRequestError("The request contradicts itself");
    case "not_found":
      throw new NotFoundError("Send attempt not found");
    case "custody_not_held":
      throw new ConflictError("The send attempt is not held: it was already reported sent or failed", {
        reason: "custody_not_held",
      });
    case "ticket_live":
      throw new ConflictError(
        "The send attempt is still inside its ticket: the page may yet send the part. Resolve it as not sent once the ticket has run out",
        { reason: "ticket_live" },
      );
    case "preview_send_rate_limited":
      throw new ClientPreviewSendRateLimitedError(await readClientPreviewSendRetryAfterMs(app.db, scope));
    default:
      throw new ClientClaimRefusedError(code);
  }
}

/**
 * A group as the repository keeps it. A manual group is one part named by its
 * text's fingerprint, kept as `generation_ref` `manual:<fingerprint>`: the
 * custody rules see one more group, and no table changes (an AI group's ref
 * never takes that form: the body schema refuses it).
 */
function storedGroup(group: ClientClaimSendGroup): ClientClaimGroup {
  return "kind" in group
    ? { generationRef: `${CLIENT_MANUAL_GROUP_REF_PREFIX}${group.textFingerprint}`, variant: 0, partCount: 1 }
    : group;
}

/**
 * The body as the repository takes it: the caller and the page are the hub's,
 * never the client's. Exported for the repository's tests, so they drive the
 * rules with exactly what the route hands over.
 */
export function clientClaimActionInput(
  body: ClientFanClaimBody,
  actor: { pageId: number; fanRef: string; userId: number },
  rate?: ClientSendRate,
): ClientClaimActionInput {
  switch (body.action) {
    case "claim":
    case "renew":
    case "release":
      return { ...actor, action: body.action, leaseToken: id(body.leaseToken), instanceId: id(body.instanceId) };
    case "dispatch":
      return {
        ...actor,
        action: "dispatch",
        attemptId: id(body.attemptId),
        instanceId: id(body.instanceId),
        purpose: body.purpose,
        group: storedGroup(body.group),
        partIndex: body.partIndex,
        textRevision: body.textRevision,
        leaseToken: body.leaseToken === undefined ? null : id(body.leaseToken),
        flagRevision: body.flagRevision,
        ...(rate === undefined ? {} : { rate }),
      };
    case "sent":
      return {
        ...actor,
        action: "sent",
        attemptId: id(body.attemptId),
        instanceId: id(body.instanceId),
        platformMessageId: body.platformMessageId,
      };
    case "failed":
      return {
        ...actor,
        action: "failed",
        attemptId: id(body.attemptId),
        instanceId: id(body.instanceId),
        reason: body.reason,
        httpStatus: body.httpStatus ?? null,
      };
    case "registerNativeSend":
      return {
        ...actor,
        action: "registerNativeSend",
        attemptId: id(body.attemptId),
        instanceId: id(body.instanceId),
        purpose: body.purpose,
        group: storedGroup(body.group),
        partIndex: body.partIndex,
        platformMessageId: body.platformMessageId,
      };
  }
}

/**
 * The admission and the switches of one dispatch, decided inside its
 * transaction after the repeat check: the platform's admission of the send
 * (`platform_unsupported`, which no switch lifts), then each flag it names
 * (OnlyFans: `previewSend`, and `newcomers` too for a greeting; Fansly:
 * `newcomers`), then the extension's version. Throws 409
 * `client_feature_disabled`; the transaction rolls back and no attempt is
 * recorded.
 */
async function requireDispatchSwitches(
  app: AppContext,
  tx: Database,
  request: ClientFeatureRequest,
  page: ClientBootstrapPageRow,
  admission: ClientSendAdmission,
): Promise<void> {
  if (!admission.admitted) {
    throw new ClientFeatureDisabledError(admission.feature, admission.reason);
  }
  const { flags } = admission.rule;
  const switches = await loadClientSwitchesForSend(app, tx);
  for (const flag of flags) {
    const reason = clientFeatureRefusal(switches, page, flag);
    if (reason !== null) {
      throw new ClientFeatureDisabledError(flag, reason);
    }
  }
  const outdated = clientVersionRefusal(switches.minVersion, request.headers["x-client-version"]);
  if (outdated !== null) {
    throw new ClientFeatureDisabledError(flags[0] ?? PREVIEW_SEND_FLAG, outdated);
  }
}

export async function applyClientFanClaim(
  app: AppContext,
  request: ClientFeatureRequest,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; fanRef: string; body: ClientFanClaimBody },
): Promise<ClientFanClaimResponse> {
  // A cookie session → 403: the route is a client's, not the dashboard's.
  requireApiKeyUser(principal);
  const { body } = input;
  const stored = await findPageSummaryByLabel(app.db, input.pageLabel);

  let page: ClientBootstrapPageRow;
  /** A dispatch's: what the platform takes of it, decided once the page is known. */
  let admission: ClientSendAdmission | null = null;
  switch (body.action) {
    case "claim":
    case "renew":
      if (!stored) {
        // A missing page answers like one not granted: the refusal reveals nothing.
        throw new ClientFeatureDisabledError(NEWCOMERS_FLAG, "not_granted");
      }
      page = await requireClientFeature(app, request, principal, stored, NEWCOMERS_FLAG);
      break;
    case "dispatch":
      // The grant only: the admission and the switches are decided in the
      // dispatch's transaction, after the repeat check.
      page = await requireClientGrantedPage(app, principal, stored, PREVIEW_SEND_FLAG);
      admission = admitClientSend({ platform: page.platform, purpose: body.purpose, group: clientClaimGroupKind(body.group) });
      break;
    case "registerNativeSend": {
      // A proven send is recorded whatever the switches and the client's
      // version say now: the grant, and a send the page's platform takes.
      page = await requireClientGrantedPage(app, principal, stored, CLAIM_FEATURE);
      const native = admitClientSend({ platform: page.platform, purpose: body.purpose, group: clientClaimGroupKind(body.group) });
      if (!native.admitted) {
        throw new ClientFeatureDisabledError(CLAIM_FEATURE, native.reason);
      }
      break;
    }
    case "release":
    case "sent":
    case "failed":
      page = await requireClientGrantedPage(app, principal, stored, CLAIM_FEATURE);
      break;
  }

  const userId = principal.user.id;
  // Read before the action, like the bootstrap reads it before the switches: a
  // change that lands in between is answered under the older revision, and the
  // client's next call sees the revision move.
  const flagRevision = await getClientConfigRevision(app.db, CLIENT_BOOTSTRAP_CONFIG_KEYS);
  // An admitted dispatch counts toward its platform's rate; a refused one is
  // refused before the rate is read, so it names none.
  const dispatch = admission;
  const rate = dispatch?.admitted ? dispatch.rule.rate : undefined;
  const result = await applyClientClaimAction(
    app.db,
    clientClaimActionInput(body, { pageId: page.id, fanRef: input.fanRef, userId }, rate),
    dispatch !== null
      ? { beforeDispatch: (tx) => requireDispatchSwitches(app, tx, request, page, dispatch) }
      : {},
  );
  if (!result.ok) {
    return refuse(app, result.code, { userId, pageId: page.id, ...(rate === undefined ? {} : { rate }) });
  }
  return toWire(result.view, flagRevision);
}

export async function getClientFanClaimStatus(
  app: AppContext,
  request: ClientFeatureRequest,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; fanRef: string },
): Promise<ClientFanClaimResponse> {
  requireApiKeyUser(principal);
  const page = await requireClientPage(
    app,
    request,
    principal,
    await findPageSummaryByLabel(app.db, input.pageLabel),
    CLAIM_FEATURE,
    (platform) => clientCustodyExistsOn(platform),
  );
  const flagRevision = await getClientConfigRevision(app.db, CLIENT_BOOTSTRAP_CONFIG_KEYS);
  // The request names no client install and no lease token: the caller's own
  // live lease reads `held` by `you-elsewhere`. It names no attempt either: the
  // repository reports the fan's open send, else the caller's own last
  // dispatched one in the state it ended.
  const view = await readClientFanClaimStatus(app.db, {
    pageId: page.id,
    fanRef: input.fanRef,
    userId: principal.user.id,
    instanceId: null,
    leaseToken: null,
  });
  return toWire(view, flagRevision);
}

/**
 * The manual resolve of a held send, for the owner and team leads in the
 * cabinet. No chat-extension switch gates it: a held send must stay resolvable
 * while the extension is switched off. The repository audits it
 * (`client.send_custody_resolved`) in the transaction that resolves.
 */
export async function resolveClientSendCustodyByStaff(
  app: AppContext,
  principal: AuthPrincipal,
  input: { pageLabel: string; attemptId: string; body: ClientSendCustodyResolveBody },
): Promise<ClientSendCustodyItem> {
  // A cookie session of a role that uses the dashboard: the owner or a team lead.
  requireDashboardUser(principal);
  const page = await findPageSummaryByLabel(app.db, input.pageLabel);
  if (!page) {
    throw new NotFoundError(`Page "${input.pageLabel}" was not found`);
  }
  if (!canAccessPage(principal, page.id)) {
    throw new ForbiddenError("Page access denied");
  }
  const attemptId = id(input.attemptId);
  const result = await resolveClientSendCustody(app.db, {
    pageId: page.id,
    attemptId,
    resolverUserId: principal.user.id,
    outcome: input.body.outcome,
    platformMessageId: input.body.platformMessageId ?? null,
    note: input.body.note,
  });
  if (!result.ok) {
    return refuse(app, result.code, { userId: principal.user.id, pageId: page.id });
  }
  const item = await findClientSendCustodyItem(app.db, { pageId: page.id, attemptId });
  if (!item) {
    throw new NotFoundError("Send attempt not found");
  }
  return {
    attemptId: item.attemptId,
    fanRef: item.fanRef,
    userId: item.userId,
    purpose: item.purpose,
    state: item.state,
    generationRef: item.generationRef,
    partIndex: item.partIndex,
    partCount: item.partCount,
    createdAt: item.createdAt.toISOString(),
    ticketExpiresAt: item.ticketExpiresAt?.toISOString() ?? null,
  };
}
