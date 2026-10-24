import {
  CLIENT_FAN_CARD_MAX_SUGGESTIONS,
  type ClientFanCardPage,
  type ClientFanCustomChangeBody,
  type ClientFanCustomCreateBody,
  type ClientFanFactChangeBody,
  type ClientFanFactChangeResponse,
  type ClientFanCardResponse,
  type ClientFanLinkDecideBody,
  type ClientFanLinkDecideResponse,
} from "@agency_hub_core/contracts";
import {
  changeFanCustom,
  changeFanFact,
  findFanConversationRef,
  findFanCustom,
  insertFanCustom,
  listCustomDeliverySuggestions,
  listCustomPaymentSuggestions,
  listPersonCustoms,
  findCardFan,
  findFanFact,
  findFanLinkDecision,
  findPageSummaryByLabel,
  listCardPages,
  listFanLinkSuggestions,
  listPersonFacts,
  listPersonFans,
  recordFanLinkDecision,
  type CardFan,
  type CardPageRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { canAccessPage, requireApiKeyUser, type HumanAuthPrincipal } from "./auth.ts";
import { requireClientGrantedPage } from "./client-switches.ts";
import { ClientFeatureDisabledError, ConflictError, NotFoundError } from "./errors.ts";

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
 * shows of any page — the team's alias with its marks, the subscription, the
 * money and the facts from its chats — and never a message or a note: the
 * roadmap's own rule (whoever writes to a fan sees the same picture). A fact of
 * such a page cannot be opened in its chat or changed (`granted: false`).
 *
 * Database only: nothing here asks a platform or queues work.
 */

export const FAN_CARD_FEATURE = "fan-card";
/** Chat Memory week 4: ended customs stay on the card this long. */
const CUSTOMS_RECENT_DAYS = 30;
/** Tips of this many days are offered as a custom's payment. */
const CUSTOM_PAYMENT_DAYS = 30;
const CUSTOM_SUGGESTIONS = 5;
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
  input: { pageLabel: string; fanRef: string; fan: CardFan | null; pageId?: number },
): Promise<ClientFanCardResponse> {
  const now = new Date();
  if (input.fan === null) {
    return {
      pageLabel: input.pageLabel, fanRef: input.fanRef, known: false, accounts: [], pages: [], suggestions: [], facts: [],
      customs: [], customPayments: [], serverNow: now.toISOString(),
    };
  }
  const person = await listPersonFans(app.db, input.fan.id);
  const personIds = person.map((fan) => fan.id);
  const suggestions = await listFanLinkSuggestions(app.db, { personFanIds: personIds, limit: CLIENT_FAN_CARD_MAX_SUGGESTIONS });
  const fans = new Map<number, CardFan>([...person, ...suggestions.map((suggestion) => suggestion.fan)].map((fan) => [fan.id, fan]));
  const pages = await listCardPages(app.db, [...fans.keys()], now);
  const facts = await listPersonFacts(app.db, personIds);
  const customs = await listPersonCustoms(app.db, { fanIds: personIds, now, recentDays: CUSTOMS_RECENT_DAYS });
  const askedPage = input.pageId === undefined ? null : input.pageId;
  const payments = askedPage === null ? [] : await listCustomPaymentSuggestions(app.db, {
    pageId: askedPage, fanIds: personIds, now, days: CUSTOM_PAYMENT_DAYS, limit: CUSTOM_SUGGESTIONS,
  });
  const deliveries = new Map<number, Awaited<ReturnType<typeof listCustomDeliverySuggestions>>>();
  for (const custom of customs) {
    if ((custom.state === "ordered" || custom.state === "paid") && custom.conversationRef !== null && canAccessPage(principal, custom.pageId)) {
      deliveries.set(custom.id, await listCustomDeliverySuggestions(app.db, {
        pageId: custom.pageId, conversationRef: custom.conversationRef, since: custom.paidAt ?? custom.createdAt, limit: CUSTOM_SUGGESTIONS,
      }));
    }
  }
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
    facts: facts.map((fact) => ({
      id: fact.id,
      kind: fact.kind,
      text: fact.text,
      pageLabel: fact.pageLabel,
      granted: canAccessPage(principal, fact.pageId),
      conversationRef: fact.conversationRef,
      messageRef: fact.messageRef,
      messageAt: iso(fact.messageAt),
      source: fact.source,
      author: fact.authorUsername,
      createdAt: fact.createdAt.toISOString(),
    })),
    customs: customs.map((custom) => ({
      id: custom.id,
      pageLabel: custom.pageLabel,
      granted: canAccessPage(principal, custom.pageId),
      description: custom.description,
      priceMills: custom.priceMills,
      state: custom.state,
      paymentMills: custom.paymentMills,
      paidAt: iso(custom.paidAt),
      deliveredMessageRef: custom.deliveredMessageRef,
      deliveredAt: iso(custom.deliveredAt),
      createdBy: custom.createdBy,
      createdAt: custom.createdAt.toISOString(),
      deliveryCandidates: (deliveries.get(custom.id) ?? []).map((message) => ({
        messageRef: message.messageRef, at: message.at.toISOString(), mediaCount: message.mediaCount, priceMills: message.priceMills,
      })),
    })),
    customPayments: payments.map((payment) => ({
      paymentRef: String(payment.transactionId), amountMills: payment.amountMills, at: payment.at.toISOString(), note: payment.note,
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
  return cardOf(app, principal, { pageLabel: page.label, fanRef: input.fanRef, fan, pageId: page.id });
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
    return { decision: decided, recorded: false, card: await cardOf(app, principal, { pageLabel: page.label, fanRef: input.fanRef, fan, pageId: page.id }) };
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
  const card = await cardOf(app, principal, { pageLabel: page.label, fanRef: input.fanRef, fan, pageId: page.id });
  return { decision: result.decision, recorded: result.recorded, card };
}

export async function changeClientFanFact(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; fanRef: string; factId: number; body: ClientFanFactChangeBody },
): Promise<ClientFanFactChangeResponse> {
  requireApiKeyUser(principal);
  const page = await requireClientGrantedPage(app, principal, await findPageSummaryByLabel(app.db, input.pageLabel), FAN_CARD_FEATURE);
  const fan = await findCardFan(app.db, page.platform, input.fanRef);
  const fact = await findFanFact(app.db, input.factId);
  const person = fan === null ? [] : await listPersonFans(app.db, fan.id);
  // A fact of another fan reads like one that does not exist.
  if (fan === null || fact === null || !person.some((one) => one.id === fact.fanId)) {
    throw new NotFoundError("The fact was not found");
  }
  // Only the people who work the fact's page change it.
  if (!canAccessPage(principal, fact.pageId)) throw new ClientFeatureDisabledError(FAN_CARD_FEATURE, "not_granted");
  const result = await changeFanFact(app.db, input.body.action === "delete"
    ? { factId: fact.id, userId: principal.user.id, action: "delete" }
    : { factId: fact.id, userId: principal.user.id, action: "correct", text: input.body.text });
  const card = await cardOf(app, principal, { pageLabel: page.label, fanRef: input.fanRef, fan, pageId: page.id });
  return { changed: result.changed, card };
}

/** Chat Memory week 4: a chatter writes a custom into the fan's record, paid by a suggested tip or not yet. */
export async function createClientFanCustom(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; fanRef: string; body: ClientFanCustomCreateBody },
): Promise<ClientFanFactChangeResponse> {
  requireApiKeyUser(principal);
  const page = await requireClientGrantedPage(app, principal, await findPageSummaryByLabel(app.db, input.pageLabel), FAN_CARD_FEATURE);
  const fan = await findCardFan(app.db, page.platform, input.fanRef);
  if (fan === null) throw new NotFoundError("The fan is not known");
  const person = (await listPersonFans(app.db, fan.id)).map((one) => one.id);
  let payment: { transactionId: number; at: Date } | null = null;
  if (input.body.paymentRef !== undefined) {
    const offered = await listCustomPaymentSuggestions(app.db, { pageId: page.id, fanIds: person, now: new Date(), days: CUSTOM_PAYMENT_DAYS, limit: 50 });
    const found = offered.find((one) => String(one.transactionId) === input.body.paymentRef);
    if (found === undefined) throw new ConflictError("The payment is not suggested for this fan", { reason: "not_suggested" });
    payment = { transactionId: found.transactionId, at: found.at };
  }
  // The chat: on Fansly the fan's thread of the page, on OnlyFans the fan.
  const conversationRef = page.platform === "onlyfans" ? fan.platformUserId : await findFanConversationRef(app.db, page.id, fan.id);
  await insertFanCustom(app.db, {
    pageId: page.id, fanId: fan.id, conversationRef, description: input.body.description, priceMills: input.body.priceMills ?? null,
    paymentTransactionId: payment?.transactionId ?? null, paidAt: payment?.at ?? null, userId: principal.user.id,
  });
  return { changed: true, card: await cardOf(app, principal, { pageLabel: page.label, fanRef: input.fanRef, fan, pageId: page.id }) };
}

/** Chat Memory week 4: a chatter marks a custom paid, delivered, cancelled, or edits it. */
export async function changeClientFanCustom(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; fanRef: string; customId: number; body: ClientFanCustomChangeBody },
): Promise<ClientFanFactChangeResponse> {
  requireApiKeyUser(principal);
  const page = await requireClientGrantedPage(app, principal, await findPageSummaryByLabel(app.db, input.pageLabel), FAN_CARD_FEATURE);
  const fan = await findCardFan(app.db, page.platform, input.fanRef);
  const custom = await findFanCustom(app.db, input.customId);
  const person = fan === null ? [] : (await listPersonFans(app.db, fan.id)).map((one) => one.id);
  if (fan === null || custom === null || !person.includes(custom.fanId)) throw new NotFoundError("The custom was not found");
  if (!canAccessPage(principal, custom.pageId)) throw new ClientFeatureDisabledError(FAN_CARD_FEATURE, "not_granted");
  const body = input.body;
  let changed: boolean;
  if (body.action === "paid") {
    const offered = await listCustomPaymentSuggestions(app.db, { pageId: custom.pageId, fanIds: person, now: new Date(), days: CUSTOM_PAYMENT_DAYS, limit: 50 });
    const found = offered.find((one) => String(one.transactionId) === body.paymentRef);
    if (found === undefined) throw new ConflictError("The payment is not suggested for this custom", { reason: "not_suggested" });
    changed = await changeFanCustom(app.db, { customId: custom.id, userId: principal.user.id, change: { action: "paid", paymentTransactionId: found.transactionId, paidAt: found.at } });
  } else if (body.action === "delivered") {
    const offered = custom.conversationRef === null ? [] : await listCustomDeliverySuggestions(app.db, {
      pageId: custom.pageId, conversationRef: custom.conversationRef, since: custom.paidAt ?? custom.createdAt, limit: 50,
    });
    const found = offered.find((one) => one.messageRef === body.messageRef);
    if (found === undefined) throw new ConflictError("The message is not suggested for this custom", { reason: "not_suggested" });
    changed = await changeFanCustom(app.db, { customId: custom.id, userId: principal.user.id, change: { action: "delivered", messageRef: found.messageRef, deliveredAt: found.at } });
  } else if (body.action === "cancel") {
    changed = await changeFanCustom(app.db, { customId: custom.id, userId: principal.user.id, change: { action: "cancel" } });
  } else {
    changed = await changeFanCustom(app.db, { customId: custom.id, userId: principal.user.id, change: { action: "edit", description: body.description, priceMills: body.priceMills } });
  }
  return { changed, card: await cardOf(app, principal, { pageLabel: page.label, fanRef: input.fanRef, fan, pageId: page.id }) };
}
