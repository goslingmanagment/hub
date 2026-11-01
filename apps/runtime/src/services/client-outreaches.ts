import { createHash } from "node:crypto";

import {
  OUTREACH_KEEP_DAYS,
  OUTREACH_LIST_MAX,
  OUTREACH_SETTINGS_MAX_BYTES,
  OUTREACH_TOUCH_HOURS,
  type ClientOutreach,
  type ClientOutreachesResponse,
  type ClientOutreachFan,
  type ClientOutreachFanChange,
  type ClientOutreachPerson,
  type ClientOutreachSaveBody,
  type ClientOutreachSaveResponse,
  type ClientOutreachSendBody,
  type ClientOutreachSendResponse,
  type ClientOutreachTouchesResponse,
} from "@agency_hub_core/contracts";
import {
  applyClientOutreachSend,
  deleteStaleClientOutreaches,
  findPageSummaryByLabel,
  insertObservation,
  listClientOutreachArchiveMessages,
  listClientOutreachFanRows,
  listClientOutreachOutcomes,
  listClientOutreachSummaries,
  listClientOutreachTouches,
  outreachCreatedAt,
  outreachEvidenceDue,
  outreachEvidenceWindow,
  outreachRecordClickedAt,
  outreachSendViewState,
  pickOutreachEvidence,
  readClientOutreachRow,
  resolveClientOutreachFans,
  saveClientOutreach as saveClientOutreachRow,
  settleClientOutreachSendByArchive,
  type ClientOutreachArchiveMessage,
  type ClientOutreachFanChangeInput,
  type ClientOutreachFanRow,
  type ClientOutreachOutcomeRow,
  type ClientOutreachPersonRow,
  type ClientOutreachRow,
  type Database,
  type OutreachSendRequest,
} from "@agency_hub_core/db";
import { normalizeDmMessageText } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { requireApiKeyUser, type HumanAuthPrincipal } from "./auth.ts";
import { requireClientGrantedPage } from "./client-switches.ts";
import { clientTokenIngestProducer } from "./client-token-profile.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
import { ingestProducerForClientVersion } from "./ingest-observations.ts";

/**
 * «Рассылки» kept by Hub (docs/plans/2026-11-01-outreach-store/spec.md): the
 * extension's outreach window, one outreach of one page, shared by the page's
 * team. Everyone granted the page lists its outreaches, opens any of them,
 * writes in it and sends from it; every person in an answer is named by their
 * login, `isMe` for the caller. The rules of a send are the pure
 * decideOutreachSend (packages/db/src/repositories/client-outreach-rules.ts),
 * the SQL client-outreaches.ts next to it. Database only: nothing here asks a
 * platform or sends anything.
 */

export const OUTREACH_FEATURE = "outreaches";
export const OUTREACH_SEND_OBSERVATION_KIND = "client.outreach_send.v1";
/** The fans a touches read answers at most. */
export const OUTREACH_TOUCHES_MAX = 10_000;
/** A fan's answer as the outreach shows it: its first characters. */
const REPLY_TEXT_MAX = 500;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const FAN_REF = /^[1-9][0-9]{0,29}$/;

interface OutreachPage {
  id: number;
  label: string;
  platform: string;
}

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());
const cut = (text: string, max: number) => Array.from(text).slice(0, max).join("");
const personOf = (row: ClientOutreachPersonRow, me: number): ClientOutreachPerson => ({ name: row.name, isMe: row.userId === me });

async function clientPage(app: AppContext, principal: HumanAuthPrincipal, pageLabel: string): Promise<OutreachPage> {
  // A cookie session → 403: the outreaches are a client's.
  requireApiKeyUser(principal);
  const page = await requireClientGrantedPage(app, principal, await findPageSummaryByLabel(app.db, pageLabel), OUTREACH_FEATURE);
  return { id: page.id, label: page.label, platform: page.platform };
}

function outreachNotFound(): NotFoundError {
  return new NotFoundError("No outreach of the page has this id", { reason: "outreach_not_found" });
}

function dateOf(value: string, field: string): Date {
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) throw new BadRequestError(`${field} is no date-time`);
  return at;
}

function assertJsonSize(value: Record<string, unknown> | null | undefined, field: string): void {
  if (value === null || value === undefined) return;
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > OUTREACH_SETTINGS_MAX_BYTES) {
    throw new BadRequestError(`${field} is larger than ${OUTREACH_SETTINGS_MAX_BYTES / 1024} KiB as JSON`);
  }
}

// ── the wire ───────────────────────────────────────────────────────────────

function outcomeWire(outcome: ClientOutreachOutcomeRow | undefined): NonNullable<ClientOutreachFan["outcome"]> {
  return {
    replied: outcome?.replied === null || outcome?.replied === undefined ? null : {
      at: outcome.replied.at.toISOString(),
      text: outcome.replied.text === null ? null : cut(normalizeDmMessageText(outcome.replied.text), REPLY_TEXT_MAX),
    },
    bought: outcome?.bought === null || outcome?.bought === undefined ? null : {
      mills: outcome.bought.mills,
      at: outcome.bought.at.toISOString(),
    },
  };
}

function fanWire(row: ClientOutreachFanRow, me: number, now: Date, outcome: ClientOutreachOutcomeRow | undefined): ClientOutreachFan {
  const send = row.send;
  const state = send === null ? null : outreachSendViewState(send, now);
  return {
    fanRef: row.fanRef,
    version: row.version,
    basis: row.basis,
    versionAt: iso(row.versionAt),
    edit: row.edit,
    editedBy: row.editedBy === null ? null : personOf(row.editedBy, me),
    editedAt: iso(row.editedAt),
    send: send === null ? null : {
      state: state!,
      attemptId: send.attemptId,
      by: personOf(send.by, me),
      clickedAt: send.clickedAt.toISOString(),
      ticketUntil: state === "sending" ? iso(send.ticketUntil) : null,
      sentAt: iso(send.sentAt),
      code: send.failureCode,
      text: send.text,
      media: send.media,
      platformMessageId: send.platformMessageId,
      resolvedBy: send.resolvedBy,
    },
    outcome: state === "sent" ? outcomeWire(outcome) : null,
  };
}

/** A fan of the outreach with nothing kept: no version, no words, no send. */
function emptyFan(fanRef: string): ClientOutreachFan {
  return {
    fanRef, version: null, basis: null, versionAt: null, edit: null, editedBy: null, editedAt: null, send: null, outcome: null,
  };
}

/**
 * The archive's proof (spec §5): each send of the outreach that reads uncertain and is younger than 30 days is looked
 * for among the page's own messages in the fan's chats, from a minute before its click to 30 minutes after, with its
 * text; the one found settles it as sent. Nothing proves a send did not go. Returns whether any was settled.
 */
async function settleByArchive(
  db: Database,
  page: OutreachPage,
  outreachId: string,
  fans: readonly ClientOutreachFanRow[],
  now: Date,
): Promise<boolean> {
  const due = fans.filter((fan) => fan.send !== null && outreachEvidenceDue(fan.send, now));
  if (due.length === 0) return false;
  const messages = await listClientOutreachArchiveMessages(db, {
    pageId: page.id,
    platform: page.platform,
    sends: due.map((fan) => ({ fanRef: fan.fanRef, fanId: fan.fanId, ...outreachEvidenceWindow(fan.send!.clickedAt) })),
  });
  const byFan = new Map<string, ClientOutreachArchiveMessage[]>();
  for (const message of messages) byFan.set(message.fanRef, [...(byFan.get(message.fanRef) ?? []), message]);
  let settled = false;
  for (const fan of due) {
    const send = fan.send!;
    const proof = pickOutreachEvidence({ clickedAt: send.clickedAt, text: send.text }, byFan.get(fan.fanRef) ?? []);
    if (proof === null) continue;
    settled = await settleClientOutreachSendByArchive(db, {
      outreachId, pageId: page.id, fanRef: fan.fanRef, attemptId: send.attemptId, sentAt: proof.at,
      platformMessageId: proof.messageRef, now,
    }) || settled;
  }
  return settled;
}

async function outreachWire(
  app: AppContext,
  page: OutreachPage,
  row: ClientOutreachRow,
  me: number,
  now: Date,
  options: { settle: boolean },
): Promise<ClientOutreach> {
  let fans = await listClientOutreachFanRows(app.db, { outreachId: row.id });
  if (options.settle && await settleByArchive(app.db, page, row.id, fans, now)) {
    fans = await listClientOutreachFanRows(app.db, { outreachId: row.id });
  }
  const outcomes = fans.some((fan) => fan.send?.state === "sent")
    ? await listClientOutreachOutcomes(app.db, { outreachId: row.id, pageId: page.id, platform: page.platform })
    : new Map<string, ClientOutreachOutcomeRow>();
  // The window's order first, then the fans out of it (a send is never lost).
  const position = new Map(row.order.map((ref, index) => [ref, index]));
  const rank = (ref: string) => position.get(ref) ?? Number.MAX_SAFE_INTEGER;
  fans.sort((a, b) => rank(a.fanRef) - rank(b.fanRef) || (a.fanRef < b.fanRef ? -1 : a.fanRef > b.fanRef ? 1 : 0));
  return {
    outreachId: row.id,
    author: personOf(row.author, me),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: personOf(row.updatedBy, me),
    text: row.text,
    withMedia: row.withMedia,
    settings: row.settings,
    order: row.order,
    fans: fans.map((fan) => fanWire(fan, me, now, outcomes.get(fan.fanRef))),
    serverNow: now.toISOString(),
  };
}

// ── the routes ─────────────────────────────────────────────────────────────

/** The page's outreaches changed within OUTREACH_KEEP_DAYS, newest change first; the untouched ones go here. */
export async function listClientOutreaches(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string },
): Promise<ClientOutreachesResponse> {
  const page = await clientPage(app, principal, input.pageLabel);
  const me = principal.user.id;
  const now = new Date();
  const since = new Date(now.getTime() - OUTREACH_KEEP_DAYS * DAY);
  await deleteStaleClientOutreaches(app.db, { pageId: page.id, before: since });
  const rows = await listClientOutreachSummaries(app.db, {
    pageId: page.id, platform: page.platform, now, since, limit: OUTREACH_LIST_MAX,
  });
  return {
    pageLabel: page.label,
    outreaches: rows.map((row) => ({
      outreachId: row.id,
      author: personOf(row.author, me),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: personOf(row.updatedBy, me),
      text: row.text,
      withMedia: row.withMedia,
      fans: row.fans,
      written: row.written,
      sent: row.sent,
      uncertain: row.uncertain,
      sending: row.sending,
      failed: row.failed,
      replied: row.replied,
      bought: row.bought,
      boughtMills: row.boughtMills,
      lastSentAt: iso(row.lastSentAt),
    })),
    serverNow: now.toISOString(),
  };
}

/** One outreach of the page with every fan; an uncertain send the archive proves is settled as sent here. */
export async function readClientOutreach(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; outreachId: string },
): Promise<ClientOutreach> {
  const page = await clientPage(app, principal, input.pageLabel);
  const row = await readClientOutreachRow(app.db, input.outreachId.toLowerCase());
  if (row === null || row.pageId !== page.id) throw outreachNotFound();
  return outreachWire(app, page, row, principal.user.id, new Date(), { settle: true });
}

/**
 * A save's fan changes, one per fan: a later change of the same fan in the body overrides the earlier one field by
 * field. A version comes with its basis; `basis` or `generationRef` without a version change nothing.
 */
function mergeFanChanges(changes: readonly ClientOutreachFanChange[]): Array<Omit<ClientOutreachFanChangeInput, "fanId">> {
  const merged = new Map<string, Omit<ClientOutreachFanChangeInput, "fanId">>();
  for (const change of changes) {
    const next = { ...(merged.get(change.fanRef) ?? { fanRef: change.fanRef }) };
    if (change.version === null) next.version = null;
    else if (typeof change.version === "string") {
      next.version = { text: change.version, basis: change.basis!, generationRef: change.generationRef ?? null };
    }
    if (change.edit !== undefined) next.edit = change.edit;
    merged.set(change.fanRef, next);
  }
  return [...merged.values()];
}

/**
 * Creates the outreach (the first save of its id, the caller its author) or changes it: each field given is the
 * latest word. A fan whose send was claimed keeps its version and words (`kept`). 409 `outreach_not_found` for an id
 * of another page's outreach, 409 `fan_not_found` for a fan Hub does not know on the page.
 */
export async function saveClientOutreach(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; outreachId: string; body: ClientOutreachSaveBody },
): Promise<ClientOutreachSaveResponse> {
  const page = await clientPage(app, principal, input.pageLabel);
  const me = principal.user.id;
  const now = new Date();
  const body = input.body;
  const outreachId = input.outreachId.toLowerCase();
  assertJsonSize(body.settings, "settings");
  const createdAt = body.createdAt === undefined ? null : dateOf(body.createdAt, "createdAt");
  const changes = mergeFanChanges(body.fans ?? []);
  const fanIds = await resolveClientOutreachFans(app.db, { pageId: page.id, platform: page.platform, refs: changes.map((change) => change.fanRef) });
  const unknown = changes.filter((change) => !fanIds.has(change.fanRef));
  if (unknown.length > 0) {
    throw new ConflictError(`Hub does not know ${unknown.length === 1 ? "this fan" : `${unknown.length} of these fans`} on the page`, { reason: "fan_not_found" });
  }
  const saved = await saveClientOutreachRow(app.db, {
    outreachId,
    pageId: page.id,
    userId: me,
    now,
    createdAt: outreachCreatedAt(createdAt, now),
    ...(body.text === undefined ? {} : { text: body.text }),
    ...(body.withMedia === undefined ? {} : { withMedia: body.withMedia }),
    ...(body.settings === undefined ? {} : { settings: body.settings }),
    ...(body.order === undefined ? {} : { order: [...new Set(body.order)] }),
    fans: changes.map((change) => ({ ...change, fanId: fanIds.get(change.fanRef)! })),
  });
  if (!saved.ok) throw new ConflictError("The id is another page's outreach", { reason: "outreach_not_found" });
  const row = await readClientOutreachRow(app.db, outreachId);
  if (row === null) throw outreachNotFound();
  return { ...(await outreachWire(app, page, row, me, now, { settle: false })), kept: saved.kept };
}

function producerOf(request: { headers: Record<string, string | string[] | undefined> }, principal: HumanAuthPrincipal): string {
  const header = request.headers["x-client-version"];
  const clientVersion = typeof header === "string" ? header : null;
  return principal.clientProfile === undefined
    ? ingestProducerForClientVersion(clientVersion ?? "unknown")
    : clientTokenIngestProducer(principal.clientProfile, clientVersion);
}

function sendRequestOf(body: ClientOutreachSendBody, me: number, now: Date): OutreachSendRequest {
  switch (body.action) {
    case "claim":
      assertJsonSize(body.media, "media");
      return { action: "claim", attemptId: body.attemptId, userId: me, text: body.text, media: body.media };
    case "sent":
      return { action: "sent", attemptId: body.attemptId, userId: me, platformMessageId: body.platformMessageId ?? null };
    case "failed":
      return { action: "failed", attemptId: body.attemptId, userId: me, code: body.code };
    case "uncertain":
      return { action: "uncertain", attemptId: body.attemptId, userId: me };
    case "record": {
      assertJsonSize(body.media, "media");
      const clickedAt = outreachRecordClickedAt(dateOf(body.clickedAt, "clickedAt"), now);
      if (clickedAt === null) throw new BadRequestError("clickedAt must be within the last 30 days and not in the future");
      return {
        action: "record", attemptId: body.attemptId, userId: me, state: body.state, clickedAt,
        sentAt: body.sentAt === undefined ? null : dateOf(body.sentAt, "sentAt"), text: body.text, media: body.media,
        platformMessageId: body.platformMessageId ?? null,
      };
    }
  }
}

/**
 * A fan's send of the outreach (spec §5): the claim before the platform is asked, its report (sent, failed proven,
 * uncertain), or the record of a send made before the outreach reached Hub. Every action but the claim is journaled
 * first (`client.outreach_send.v1`). Hub never retries anything by itself.
 */
export async function sendClientOutreach(
  app: AppContext,
  request: { headers: Record<string, string | string[] | undefined> },
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; outreachId: string; body: ClientOutreachSendBody },
): Promise<ClientOutreachSendResponse> {
  const page = await clientPage(app, principal, input.pageLabel);
  const me = principal.user.id;
  const now = new Date();
  const body = input.body;
  const outreachId = input.outreachId.toLowerCase();
  const send = sendRequestOf(body, me, now);
  const fanId = (await resolveClientOutreachFans(app.db, { pageId: page.id, platform: page.platform, refs: [body.fanRef] })).get(body.fanRef);
  if (fanId === undefined) throw new ConflictError("Hub does not know this fan on the page", { reason: "fan_not_found" });
  const producer = producerOf(request, principal);
  const result = await applyClientOutreachSend(app.db, { outreachId, pageId: page.id, fanRef: body.fanRef, fanId, now, request: send }, {
    journal: async (tx) => {
      const payload = {
        pageLabel: page.label,
        outreachId,
        fanRef: body.fanRef,
        action: body.action,
        attemptId: body.attemptId.toLowerCase(),
        ...(body.action === "sent" ? { platformMessageId: body.platformMessageId ?? null } : {}),
        ...(body.action === "failed" ? { code: body.code } : {}),
        ...(body.action === "record" ? {
          state: body.state, clickedAt: body.clickedAt, sentAt: body.sentAt ?? null, text: body.text, media: body.media,
          platformMessageId: body.platformMessageId ?? null,
        } : {}),
        at: now.toISOString(),
      };
      const journaled = await insertObservation(tx, {
        source: "client_capture",
        producer,
        platform: page.platform,
        accountId: page.id,
        kind: OUTREACH_SEND_OBSERVATION_KIND,
        payload,
        payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
        idempotencyKey: `${me}:outreach_send:${outreachId}:${body.fanRef}:${payload.attemptId}:${body.action}:${now.toISOString()}`,
        observedAt: now,
        actorPrincipalId: me,
      });
      return journaled.observationId;
    },
  });
  if (!result.ok) throw outreachNotFound();
  const fan = result.fan;
  const outcomes = fan?.send?.state === "sent"
    ? await listClientOutreachOutcomes(app.db, { outreachId, pageId: page.id, platform: page.platform, fanRef: body.fanRef })
    : null;
  return {
    outcome: result.outcome,
    fan: fan === null ? emptyFan(body.fanRef) : fanWire(fan, me, now, outcomes?.get(body.fanRef)),
    serverNow: now.toISOString(),
  };
}

/**
 * The page's fans written to in the last OUTREACH_TOUCH_HOURS by an outreach (went, may have, or on its way), a fan
 * queue or «Онлайн»: the latest touch of each, newest first, at most OUTREACH_TOUCHES_MAX.
 */
export async function readClientOutreachTouches(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string },
): Promise<ClientOutreachTouchesResponse> {
  const page = await clientPage(app, principal, input.pageLabel);
  const me = principal.user.id;
  const now = new Date();
  const rows = await listClientOutreachTouches(app.db, {
    pageId: page.id, since: new Date(now.getTime() - OUTREACH_TOUCH_HOURS * HOUR), limit: OUTREACH_TOUCHES_MAX,
  });
  return {
    pageLabel: page.label,
    hours: OUTREACH_TOUCH_HOURS,
    // A fan's id in another shape than the contract's is no fan the window can name.
    fans: rows.filter((row) => FAN_REF.test(row.fanRef)).map((row) => ({
      fanRef: row.fanRef,
      at: row.at.toISOString(),
      kind: row.kind,
      by: row.by === null ? null : personOf(row.by, me),
      outreachId: row.outreachId,
    })),
    serverNow: now.toISOString(),
  };
}
