import {
  AGENT_FAN_WATCH_MESSAGES_MAX,
  shiftAuditNumbers,
  type AgentFanWatchBody,
  type AgentFanWatchResponse,
  type AgentSaleContextBody,
  type AgentSaleContextResponse,
  type AgentShiftReviewQuery,
  type AgentShiftReviewResponse,
} from "@agency_hub_core/contracts";
import {
  findTransactionIdsByPlatformRef,
  listLoginIdsOfPerson,
  listPageMessageTexts,
  listSaleArchive,
  listSaleContext,
  listSaleFacts,
  readFanWatch,
  type Database,
  type SaleArchiveRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { saleKindOf } from "./chatter-stats.ts";
import { NotFoundError } from "./errors.ts";
import { computeShiftReview } from "./shift-review.ts";

/**
 * The agents' ready reads (ecosystem plan §3.3, package M1): what the agents'
 * scripts computed over `ssh … psql`, from the computations Hub already has.
 * The routes (modules/agent-team) check the key's capabilities, budget and
 * audit; these functions read only the key's pages they are handed.
 */

/** The key's pages, as the plane's request scope gives them. */
export interface AgentPages {
  pages: ReadonlyArray<{ id: number; pageLabel: string }>;
  /** The key holds read:messages (texts), read:money (amounts not otherwise required). */
  texts: boolean;
  money: boolean;
}

/**
 * `agentShiftReview`: the shift of a login (or of a person's login) that holds
 * `at`, on the key's pages, and the shift audit's numbers from it. The AI's own
 * texts are dropped; message texts too without read:messages.
 */
export async function readAgentShiftReview(app: AppContext, scope: AgentPages, query: AgentShiftReviewQuery): Promise<AgentShiftReviewResponse> {
  const logins = query.userId !== undefined ? [query.userId] : await listLoginIdsOfPerson(app.db, query.person!);
  if (logins.length === 0) throw new NotFoundError(`No person «${query.person}» with a login`);
  const grantedPageIds = scope.pages.map((page) => page.id);
  let found: Awaited<ReturnType<typeof computeShiftReview>> | null = null;
  for (const userId of logins) {
    try {
      found = await computeShiftReview(app, { userId, at: query.at }, { grantedPageIds });
      break;
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
  }
  if (found === null) throw new NotFoundError("The person has no shift at that time");
  const { review, pagesLeftOut } = found;
  for (const chat of review.chats) {
    for (const message of chat.messages) {
      if (!scope.texts) message.text = "";
      if (message.mine !== null) {
        message.mine.aiText = null;
        message.mine.draft = null;
      }
    }
  }
  return { review, numbers: shiftAuditNumbers(review), texts: scope.texts, pagesLeftOut };
}

function pageByLabel(scope: AgentPages, label: string) {
  return scope.pages.find((page) => page.pageLabel === label) ?? null;
}

/**
 * `agentFanWatch`: each watched fan's messages on a key's page since the
 * watch's start that the archive took after its progress mark, and when the
 * page last wrote to the fan. A page outside the key's grant is null here
 * (the route answers the plane's static 404).
 */
export async function readAgentFanWatch(db: Database, scope: AgentPages, body: AgentFanWatchBody, now = new Date()): Promise<AgentFanWatchResponse | null> {
  const watches: AgentFanWatchResponse["watches"] = [];
  for (const watch of body.watches) {
    const page = pageByLabel(scope, watch.pageLabel);
    if (page === null) return null;
    const since = new Date(watch.since);
    const read = await readFanWatch(db, {
      pageId: page.id,
      username: watch.username,
      since,
      // The mark as the agent sent it: the database compares it to the microsecond (a Date would cut it).
      archivedAfter: watch.archivedAfter ?? null,
      limit: AGENT_FAN_WATCH_MESSAGES_MAX + 1,
    });
    const messages = read.messages.slice(0, AGENT_FAN_WATCH_MESSAGES_MAX);
    watches.push({
      pageLabel: page.pageLabel,
      username: watch.username,
      chats: read.chats,
      fanMessages: messages.map((message) => ({
        ref: message.ref,
        at: message.at.toISOString(),
        archivedAt: message.archivedAt,
        text: scope.texts ? message.text : "",
        media: message.media,
        tipMills: scope.money ? message.tipMills : null,
      })),
      more: read.messages.length > AGENT_FAN_WATCH_MESSAGES_MAX,
      pageLastAt: read.pageLastAt?.toISOString() ?? null,
    });
  }
  return { watches, serverNow: now.toISOString() };
}

/** A sale's `archive` on the wire; the priced message's text only with read:messages. */
function archiveOut(archive: SaleArchiveRow | undefined, texts: boolean) {
  return {
    conversationRef: archive?.conversationRef ?? null,
    partnerUsername: archive?.partnerUsername ?? null,
    fanRecordUsername: archive?.fanRecordUsername ?? null,
    partnerUsernames: archive?.partnerUsernames ?? [],
    pricedMessage: archive?.pricedMessage == null ? null : {
      sentAt: archive.pricedMessage.sentAt.toISOString(),
      sender: archive.pricedMessage.sender,
      text: texts ? archive.pricedMessage.text : null,
    },
    pageMessages7d: archive?.pageMessages7d ?? [],
    lastAuthored60d: archive?.lastAuthored60d == null ? null : {
      name: archive.lastAuthored60d.name,
      at: archive.lastAuthored60d.at.toISOString(),
      within48h: archive.lastAuthored60d.within48h,
    },
  };
}

/**
 * `agentSaleContext`: for each sale on the key's pages, its fan, the PPV it
 * bought (Hub's match, `listSaleFacts`), and who wrote to the fan before it;
 * and the fan's chat as the shift report check reads the archive (`listSaleArchive`).
 * A sale not found there — unknown, or on a page the key does not reach — is
 * listed back in `notFound`, the same for both.
 */
export async function readAgentSaleContext(db: Database, scope: AgentPages, body: AgentSaleContextBody, now = new Date()): Promise<AgentSaleContextResponse> {
  const labelOf = new Map(scope.pages.map((page) => [page.id, page.pageLabel]));
  const byPlatform = body.sales.flatMap((sale) => {
    if (!("transactionRef" in sale)) return [];
    const page = pageByLabel(scope, sale.pageLabel);
    return page === null ? [] : [{ pageId: page.id, transactionRef: sale.transactionRef }];
  });
  const platformIds = await findTransactionIdsByPlatformRef(db, byPlatform);
  const wanted = new Map<number, AgentSaleContextBody["sales"][number]>();
  const notFound: AgentSaleContextResponse["notFound"] = [];
  for (const sale of body.sales) {
    if ("saleRef" in sale) {
      wanted.set(Number(sale.saleRef), sale);
      continue;
    }
    const page = pageByLabel(scope, sale.pageLabel);
    const id = page === null ? undefined : platformIds.get(`${page.id}:${sale.transactionRef}`);
    if (id === undefined) notFound.push(sale);
    else wanted.set(id, sale);
  }
  const ids = [...wanted.keys()].filter((id) => Number.isSafeInteger(id));
  // The key's pages first: nothing of a sale elsewhere is read further.
  const rows = (await listSaleContext(db, { transactionIds: ids })).filter((row) => labelOf.has(row.pageId));
  const facts = await listSaleFacts(db, { transactionIds: rows.map((row) => row.transactionId) });
  const factOf = new Map(facts.map((fact) => [fact.transactionId, fact]));
  const archiveOf = await listSaleArchive(db, { transactionIds: rows.map((row) => row.transactionId) });
  // The bought PPV's text, only with read:messages.
  const pageOf = new Map(rows.map((row) => [row.transactionId, row.pageId]));
  const ppvMessages = facts.flatMap((fact) => (fact.ppvMessageRef === null ? [] : [{ pageId: pageOf.get(fact.transactionId)!, ref: fact.ppvMessageRef }]));
  const texts = scope.texts ? await listPageMessageTexts(db, ppvMessages) : new Map<string, string>();
  const sales: AgentSaleContextResponse["sales"] = [];
  const found = new Set<number>();
  for (const row of rows) {
    const pageLabel = labelOf.get(row.pageId);
    if (pageLabel === undefined) continue;
    found.add(row.transactionId);
    const fact = factOf.get(row.transactionId);
    const isPpv = fact !== undefined && (fact.ppvMessageRef !== null || fact.ppvSender !== null);
    sales.push({
      saleRef: String(row.transactionId),
      pageLabel,
      transactionRef: row.platformTransactionRef,
      kind: saleKindOf(row.kind),
      occurredAt: row.occurredAt.toISOString(),
      grossMills: row.grossMills,
      netMills: row.netMills,
      fanRef: row.fanRef,
      fanUsername: row.fanUsername,
      ppv: !isPpv ? null : {
        sentAt: fact.ppvSentAt?.toISOString() ?? null,
        sender: fact.ppvSender?.username ?? null,
        text: fact.ppvMessageRef === null ? null : texts.get(`${row.pageId}:${fact.ppvMessageRef}`) ?? null,
      },
      postTip: fact?.postTip ?? false,
      campaign: fact?.campaign ?? false,
      writers48h: (fact?.writers ?? []).map((writer) => ({ name: writer.username, messages: writer.messages })),
      writers7d: row.writers7d.map((writer) => ({ name: writer.username, messages: writer.messages })),
      lastWriter: row.lastWriter60d === null ? null : {
        name: row.lastWriter60d.username,
        at: row.lastWriter60d.at.toISOString(),
        within48h: row.occurredAt.getTime() - row.lastWriter60d.at.getTime() <= 48 * 3_600_000,
      },
      archive: archiveOut(archiveOf.get(row.transactionId), scope.texts),
    });
  }
  for (const [id, sale] of wanted) {
    if (!found.has(id)) notFound.push(sale);
  }
  return { sales, notFound, serverNow: now.toISOString() };
}
