import {
  CLIENT_FAN_CARD_MAX_SUGGESTIONS,
  type ClientFanCardPage,
  type ClientFanCardResponse,
  type ClientFanLinkDecideBody,
  type ClientFanLinkDecideResponse,
} from "@agency_hub_core/contracts";
import {
  findCardFan,
  findFanLinkDecision,
  findPageSummaryByLabel,
  listCardPages,
  listFanLinkSuggestions,
  listPersonFans,
  recordFanLinkDecision,
  type CardFan,
  type CardPageRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { canAccessPage, requireApiKeyUser, type HumanAuthPrincipal } from "./auth.ts";
import { requireClientGrantedPage } from "./client-switches.ts";
import { ConflictError } from "./errors.ts";

/**
 * Chat Memory week 2 (docs/plans/2026-10-24-chat-memory/week-2.md §1–2): the
 * fan's card across pages (`clientFanCard`) and the chatter's «same person»
 * decision (`clientFanLinkDecide`).
 *
 * The person is the asked fan and every account linked to it by a `same`
 * decision (fan_links, 0307). A Fansly fan is already one account on every
 * Fansly page, so his lora-1 marks reach ari-1 with no decision at all.
 *
 * WHAT ANOTHER PAGE SHOWS. A page the caller does not work shows what the card
 * shows of any page — the team's alias with its marks, the subscription and the
 * money — and nothing else: no message, no note, no text. The roadmap's own
 * rule (whoever writes to a fan sees the same picture).
 *
 * Database only: nothing here asks a platform or queues work.
 */

export const FAN_CARD_FEATURE = "fan-card";
/** Suggestions a decision is checked against: more than the card shows, so a pair just past its tail still counts. */
const DECIDABLE_SUGGESTIONS = 50;

const iso = (at: Date | null) => (at === null ? null : at.toISOString());

function pageOf(row: CardPageRow, fans: ReadonlyMap<number, CardFan>, principal: HumanAuthPrincipal): ClientFanCardPage {
  return {
    pageLabel: row.pageLabel,
    platform: row.platform,
    modelName: row.modelName,
    fanRef: fans.get(row.fanId)?.platformUserId ?? "0",
    granted: canAccessPage(principal, row.pageId),
    alias: row.alias,
    subscribed: row.isSubscriber,
    subscribedSince: iso(row.subscriberSince),
    subscriptionEndsAt: iso(row.subscriptionExpiresAt),
    spentMills: row.lifetimeGrossMills,
    last30Mills: row.last30GrossMills,
    lastPurchaseAt: iso(row.lastPurchaseAt),
  };
}

const accountOf = (fan: CardFan) => ({
  platform: fan.platform,
  fanRef: fan.platformUserId,
  username: fan.username,
  displayName: fan.displayName,
  gone: fan.gone,
});

async function cardOf(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; fanRef: string; fan: CardFan | null },
): Promise<ClientFanCardResponse> {
  const now = new Date();
  if (input.fan === null) {
    return { pageLabel: input.pageLabel, fanRef: input.fanRef, known: false, accounts: [], pages: [], suggestions: [], serverNow: now.toISOString() };
  }
  const person = await listPersonFans(app.db, input.fan.id);
  const personIds = person.map((fan) => fan.id);
  const suggestions = await listFanLinkSuggestions(app.db, { personFanIds: personIds, limit: CLIENT_FAN_CARD_MAX_SUGGESTIONS });
  const fans = new Map<number, CardFan>([...person, ...suggestions.map((suggestion) => suggestion.fan)].map((fan) => [fan.id, fan]));
  const pages = await listCardPages(app.db, [...fans.keys()], now);
  const personSet = new Set(personIds);

  return {
    pageLabel: input.pageLabel,
    fanRef: input.fanRef,
    known: true,
    accounts: person.map((fan, index) => ({ ...accountOf(fan), linkedBy: index === 0 ? null : fan.linkedByUsername })),
    pages: pages.filter((row) => personSet.has(row.fanId)).map((row) => pageOf(row, fans, principal)),
    suggestions: suggestions.map((suggestion) => ({
      ...accountOf(suggestion.fan),
      reason: suggestion.reasonKind,
      shared: suggestion.shared,
      sharedOn: suggestion.pageLabel,
      pages: pages.filter((row) => row.fanId === suggestion.fan.id).map((row) => pageOf(row, fans, principal)),
    })),
    serverNow: now.toISOString(),
  };
}

export async function readClientFanCard(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; fanRef: string },
): Promise<ClientFanCardResponse> {
  // A cookie session → 403: the card is a client's.
  requireApiKeyUser(principal);
  const page = await requireClientGrantedPage(app, principal, await findPageSummaryByLabel(app.db, input.pageLabel), FAN_CARD_FEATURE);
  const fan = await findCardFan(app.db, page.platform, input.fanRef);
  return cardOf(app, principal, { pageLabel: page.label, fanRef: input.fanRef, fan });
}

export async function decideClientFanLink(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; fanRef: string; body: ClientFanLinkDecideBody },
): Promise<ClientFanLinkDecideResponse> {
  requireApiKeyUser(principal);
  const page = await requireClientGrantedPage(app, principal, await findPageSummaryByLabel(app.db, input.pageLabel), FAN_CARD_FEATURE);
  const fan = await findCardFan(app.db, page.platform, input.fanRef);
  if (fan === null) throw new ConflictError("The fan is not suggested anything", { reason: "not_suggested" });
  // A pair decided before keeps its decision: a repeat (its answer was lost) reads it back.
  const other = await findCardFan(app.db, input.body.otherPlatform, input.body.otherFanRef);
  const decided = other === null ? null : await findFanLinkDecision(app.db, fan.id, other.id);
  if (decided !== null) {
    return { decision: decided, recorded: false, card: await cardOf(app, principal, { pageLabel: page.label, fanRef: input.fanRef, fan }) };
  }
  const person = await listPersonFans(app.db, fan.id);
  const suggestions = await listFanLinkSuggestions(app.db, { personFanIds: person.map((one) => one.id), limit: DECIDABLE_SUGGESTIONS });
  const suggestion = suggestions.find((one) =>
    one.fan.platform === input.body.otherPlatform && one.fan.platformUserId === input.body.otherFanRef);
  if (suggestion === undefined) {
    // Never suggested: a chatter links only what Hub put in front of them.
    throw new ConflictError("This account is not suggested for this fan", { reason: "not_suggested" });
  }
  // The pair is the asked fan and the suggested account: a person of several accounts joins through it.
  const result = await recordFanLinkDecision(app.db, {
    fanId: fan.id,
    otherFanId: suggestion.fan.id,
    decision: input.body.decision,
    reasonKind: suggestion.reasonKind,
    reasonDetail: suggestion.pageLabel === null ? suggestion.shared : `${suggestion.shared} (${suggestion.pageLabel})`,
    userId: principal.user.id,
  });
  app.logger?.info(
    { pageId: page.id, userId: principal.user.id, decision: result.decision, recorded: result.recorded, reason: suggestion.reasonKind },
    "fan link decided",
  );
  const card = await cardOf(app, principal, { pageLabel: page.label, fanRef: input.fanRef, fan });
  return { decision: result.decision, recorded: result.recorded, card };
}
