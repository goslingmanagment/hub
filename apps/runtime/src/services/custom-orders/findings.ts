import {
  customOrderCode,
  parseCustomOrderCode,
  parseTelegramRef,
  type AgentCustomFindingsBody,
  type AgentCustomFindingsResponse,
  type CustomFinding,
  type CustomFindingActionBody,
} from "@agency_hub_core/contracts";
import {
  closeMatter,
  copyCustomSaleDismissals,
  findCustomFinding,
  findCustomOrder,
  findCustomSale,
  findPageFanByInput,
  findPageSummaryByLabel,
  insertCustomCardFindings,
  insertCustomFinding,
  insertCustomFindingEvent,
  insertCustomFindingsOfSales,
  insertCustomSaleFindings,
  insertShiftReportCustomFindings,
  linkCustomFindingsToOrders,
  findCustomPageMessage,
  listCustomFindingKeys,
  listCustomModelPages,
  listOpenCustomFindings,
  listOpenMattersOfKinds,
  listPersonFans,
  reopenCustomFinding,
  resolveCustomFinding,
  type CustomFindingRow,
  type CustomOrderRow,
  type Database,
  type MatterActor,
  type MatterOwner,
  type OpenCustomFindingRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { isNarrowPrincipal, requireSessionUser, type AuthPrincipal, type HumanAuthPrincipal } from "../auth.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import { isTestAgent, testPageIds } from "../sandbox/realm.ts";
import type { AgentCustomScope } from "./agent.ts";
import { checkPersonSale } from "./evidence.ts";
import { applyCustomStep, customViewerOf, recordCustomOrder, recordTakerOf, resolveFanOnPage, type CustomActor } from "./index.ts";
import { CUSTOM_UNRECORDED_KIND, unrecordedSaleOf } from "./readers.ts";
import { mayTakeStep, seesOrder, type CustomViewer } from "./rules.ts";

/**
 * A custom with no order (customs facts spec §8): one object for every trace of it, `custom_findings`, once by
 * `(source, ref)`. The reader posts what only reading can find (`agentPostCustomFindings`, read:money + read:messages,
 * the key's pages only) and dismisses a candidate it read as «не кастом»; the check's leader of the finding's page
 * (the customs lead, the owner) resolves one: records it as an order (the board's «Записать кастом»; a sale's finding
 * brings its sale), links it to an order there is, or dismisses it with a reason from the list. A resolved finding
 * never opens again. Database only.
 */

type FindingsApp = Pick<AppContext, "db">;

export function findingWire(row: CustomFindingRow): CustomFinding {
  return {
    id: row.id,
    source: row.source,
    ref: row.ref,
    pageLabel: row.pageLabel,
    fan: row.fanRef === null || row.platform === null
      ? null
      : { platform: row.platform, fanRef: row.fanRef, username: row.fanUsername, displayName: row.fanDisplayName },
    amountMills: row.amountMills,
    quote: row.quote,
    happenedAt: row.happenedAt.toISOString(),
    status: row.status,
    orderCode: row.orderId === null ? null : customOrderCode(row.orderId),
    dismissReason: row.dismissReason,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedByAgent: row.resolvedByAgentKeyId === null ? null : row.resolvedByAgent ?? "агент",
    createdAt: row.createdAt.toISOString(),
  };
}

/** A sale's finding is named by Hub's id of the sale, written as digits only (one sale, one `(source, ref)`). */
const SALE_REF = /^[1-9]\d{0,18}$/;

/**
 * `POST /api/v1/agent/custom-findings`: each trace once by `(source, ref)`. A sale's is the sale Hub holds on one of the
 * key's pages, its page, fan, sum and time Hub's own; any other names its page (of the key's) and the fan's platform id
 * there, or no page. `notCustom` keeps a new one dismissed as «не кастом» at once; a finding Hub has already stays as it
 * is — a person resolves it.
 */
export async function agentPostCustomFindings(
  app: FindingsApp,
  scope: AgentCustomScope,
  body: AgentCustomFindingsBody,
  now: Date = new Date(),
): Promise<AgentCustomFindingsResponse> {
  const keyPages = new Map(scope.pages.map((page) => [page.id, page]));
  const findings: AgentCustomFindingsResponse["findings"] = [];
  let tests: ReadonlySet<number> | undefined;
  for (const item of body.findings) {
    const answer = (outcome: AgentCustomFindingsResponse["findings"][number]["outcome"], id: number | null) =>
      findings.push({ source: item.source, ref: item.ref, outcome, id });
    const page = item.pageLabel === undefined ? null : scope.pages.find((one) => one.pageLabel === item.pageLabel) ?? null;
    if (item.pageLabel !== undefined && page === null) {
      answer("not_found", null);
      continue;
    }
    let pageId = page?.id ?? null;
    // A trace of no known page is the live agency's (0414): the test realm's key writes none.
    if (pageId === null && item.source !== "sale" && isTestAgent(scope.principal)) {
      answer("not_found", null);
      continue;
    }
    let fanId: number | null = null;
    let amountMills = item.amountMills ?? null;
    let happenedAt = new Date(item.happenedAt);
    if (item.source === "sale") {
      const sale = SALE_REF.test(item.ref) ? await findCustomSale(app.db, Number(item.ref)) : null;
      if (sale === null || !keyPages.has(sale.pageId) || (pageId !== null && pageId !== sale.pageId)) {
        answer("not_found", null);
        continue;
      }
      pageId = sale.pageId;
      fanId = sale.fanId;
      amountMills = sale.grossMills > 0 ? sale.grossMills : null;
      happenedAt = sale.at;
    } else if (item.fanRef !== undefined && page !== null) {
      const fan = await findPageFanByInput(app.db, { pageId: page.id, platform: page.platform, platformUserId: item.fanRef, username: null });
      if (fan === null) {
        answer("not_found", null);
        continue;
      }
      fanId = fan.fanId;
    } else if (item.source === "fan_chat" && page !== null) {
      // The fan's chat names its fan: the message's own chat, so his erasure finds the finding's quote (it is about him).
      fanId = (await findCustomPageMessage(app.db, { pageIds: [page.id], messageRef: item.ref }))?.chatFanId ?? null;
    }
    const kept = await insertCustomFinding(app.db, {
      source: item.source, ref: item.ref, pageId, fanId, amountMills, quote: item.quote ?? null, happenedAt, at: now,
      ...(item.notCustom === true ? { dismissed: { reason: "not_custom" as const, agentKeyId: scope.principal.agentKeyId, userId: null } } : {}),
    });
    // One `(source, ref)` for both realms: a finding of the other realm is none of this key's — not «already», which would
    // tell the reader it is handled (and is an oracle across the wall).
    if (!kept.created) {
      const existing = await findCustomFinding(app.db, kept.id);
      tests ??= await testPageIds(app);
      const existingTest = existing?.pageId !== null && existing?.pageId !== undefined && tests.has(existing.pageId);
      if (existingTest !== isTestAgent(scope.principal)) {
        answer("not_found", null);
        continue;
      }
    }
    answer(!kept.created ? "already" : item.notCustom === true ? "dismissed" : "created", kept.id);
  }
  return { findings };
}

/**
 * Who resolves a finding: the owner; the customs lead (the right «ведёт кастомы»); the check's leader of the finding's
 * page by the one rule (leaders.ts). Of the viewer's realm only.
 */
export function mayResolveFinding(viewer: CustomViewer, finding: { pageId: number | null }): boolean {
  if (!seesOrder({ ...viewer, lead: true }, finding)) return false;
  if (viewer.role === "owner" || viewer.lead) return true;
  return finding.pageId !== null && (viewer.leads?.check ?? []).includes(finding.pageId);
}

const resolvedAlready = () => new ConflictError("The finding is resolved already", { reason: "resolved" });
/** Only what an agent dismissed is brought back by a person; their own and another person's answers stand. */
const notReopenable = () => new ConflictError("Only a finding an agent dismissed is brought back", { reason: "not_reopenable" });
const byAgentDismissed = (finding: CustomFindingRow) => finding.status === "dismissed" && finding.resolvedByAgentKeyId !== null;

/** The sale a finding names (Hub's id: a sale's, a shift report line's); null — none. */
function saleOf(finding: CustomFindingRow): number | null {
  return (finding.source === "sale" || finding.source === "shift_report") && SALE_REF.test(finding.ref) ? Number(finding.ref) : null;
}

/**
 * A finding that names a page or a fan (the fan's chat) belongs to an order of that page's model and of that fan (any
 * account of the person): refused otherwise, as a sale of another fan or model is.
 */
async function requireOfOrder(db: Database, finding: CustomFindingRow, order: CustomOrderRow): Promise<void> {
  if (finding.pageId !== null) {
    const modelPages = order.modelSlug === null ? [] : (await listCustomModelPages(db, order.modelSlug)).map((page) => page.id);
    if (!modelPages.includes(finding.pageId)) throw new ConflictError("The finding is another model's", { reason: "other_model" });
  }
  if (finding.fanId !== null) {
    if (order.fanId === null) throw new ConflictError("The order names no fan to check the finding's against", { reason: "order_no_fan" });
    if (!(await listPersonFans(db, order.fanId)).some((fan) => fan.id === finding.fanId)) {
      throw new ConflictError("The finding is another fan's", { reason: "other_fan" });
    }
  }
}

/** The Telegram card a finding is (the work chat, the model's group); null — none. */
function cardOf(finding: CustomFindingRow): string | null {
  return finding.source === "work_chat" || finding.source === "model_group" ? parseTelegramRef(finding.ref) : null;
}

/**
 * `customFindingAct`: one answer to a finding by whoever resolves it. A finding the viewer does not resolve reads like
 * one that does not exist. Each answer and the finding's resolution are one transaction. A sale it names becomes the
 * order's payment only when it holds as the agent's sale must (evidence.ts `checkPersonSale`: the order's fan, its model,
 * live, no other order's, not taken back) — else nothing is written; a card it is becomes the order's card. `reopen` —
 * a finding an agent dismissed is open again.
 */
export async function actOnCustomFinding(
  app: FindingsApp,
  principal: AuthPrincipal,
  input: { findingId: string; body: CustomFindingActionBody },
  now: Date = new Date(),
): Promise<{ finding: CustomFinding }> {
  requireSessionUser(principal);
  const human = principal as HumanAuthPrincipal;
  // A narrow session (from the extension, no password) resolves nothing (`isNarrowPrincipal`).
  if (isNarrowPrincipal(human)) throw new NotFoundError("The finding was not found");
  return actOnCustomFindingAs(app, { person: human, findingId: input.findingId, body: input.body, now, actor: { door: "workboard", userId: human.user.id } });
}

/**
 * One answer to a finding as `person`, by the board's own rules (`mayResolveFinding`): the board's door, and an agent on
 * the person's word (agent.ts: the request kept in the finding's history; `pageIds`/`noPage` — the key's pages, else the
 * finding reads as not found). Every answer leaves its line in the finding's history (`custom_finding.*`).
 */
export async function actOnCustomFindingAs(
  app: FindingsApp,
  input: {
    person: HumanAuthPrincipal; findingId: string; body: CustomFindingActionBody; now: Date; actor: CustomActor;
    requestRef?: string; pageIds?: readonly number[]; noPage?: boolean;
  },
): Promise<{ finding: CustomFinding }> {
  const { now, actor } = input;
  const viewer = await customViewerOf(app, input.person);
  const id = Number(input.findingId);
  const seen = await findCustomFinding(app.db, id);
  const ofKey = (finding: CustomFindingRow) => input.pageIds === undefined
    || (finding.pageId === null ? input.noPage === true : input.pageIds.includes(finding.pageId));
  if (seen === null || !ofKey(seen) || !mayResolveFinding(viewer, seen)) throw new NotFoundError("The finding was not found");
  const body = input.body;
  if (body.action === "reopen" ? !byAgentDismissed(seen) : seen.status !== "open") throw body.action === "reopen" ? notReopenable() : resolvedAlready();
  const userId = input.person.user.id;
  const requestRef = input.requestRef === undefined ? {} : { requestRef: input.requestRef };
  await app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const finding = (await findCustomFinding(db, id, { lock: true }))!;
    /** The answer's line in the finding's history: who, through which door, on whose word. */
    const event = (name: string, changes: Record<string, unknown>) => insertCustomFindingEvent(db, {
      findingId: id, event: `custom_finding.${name}`, door: actor.door === "api" ? "api" : "workboard", userId: actor.userId ?? null,
      agentKeyId: actor.agentKeyId ?? null, onBehalfOfUserId: actor.onBehalfOfUserId ?? null, changes: { ...changes, ...requestRef }, at: now,
    });
    if (body.action === "reopen") {
      if (!byAgentDismissed(finding) || !(await reopenCustomFinding(db, { id }))) throw notReopenable();
      await event("reopened", {});
      return;
    }
    if (finding.status !== "open") throw resolvedAlready();
    const sale = saleOf(finding);
    const card = cardOf(finding);
    /** A step an agent takes on the person's word is the person's, the request kept (as the board's own step). */
    const stepWord = input.requestRef === undefined ? {} : { byPerson: true, requestRef: input.requestRef };
    /** The finding's sale paid to the order, checked first; a person's own step (it takes a sale off no other order). */
    const pay = async (orderId: number) => {
      if (sale === null) return;
      const order = (await findCustomOrder(db, orderId))!;
      if ((await checkPersonSale(db, order, sale)).already) return;
      await applyCustomStep({ db }, { orderId, step: { action: "payment", transactionId: sale }, actor, viewer: null, now, ...stepWord });
    };
    switch (body.action) {
      case "dismiss":
        await resolveCustomFinding(db, { id, status: "dismissed", orderId: null, dismissReason: body.reason, userId, at: now });
        await event("dismissed", { reason: body.reason });
        return;
      case "record": {
        // The board's «Записать кастом», filled from the finding: its page and fan, else the ones the person gives.
        let pageId = finding.pageId;
        let pageLabel = finding.pageLabel;
        let fanId = finding.fanId;
        let buyer: string | null = null;
        let conversationRef: string | null = null;
        // A page the person names is always one they resolve findings of; it must be the finding's own when it has one.
        if (body.pageLabel !== undefined || pageId === null || pageLabel === null) {
          const page = body.pageLabel === undefined ? null : await findPageSummaryByLabel(db, body.pageLabel);
          if (!page || !mayResolveFinding(viewer, { pageId: page.id })) throw new NotFoundError(`Page "${body.pageLabel ?? ""}" was not found`);
          if (pageId !== null && page.id !== pageId) throw new ConflictError(`The finding is ${pageLabel}'s, not ${page.label}'s`, { reason: "other_page" });
          pageId = page.id;
          pageLabel = page.label;
        }
        if (fanId === null && body.fan !== undefined) {
          const found = await resolveFanOnPage(db, { pageLabel, fan: body.fan });
          fanId = found?.fanId ?? null;
          if (found?.platform === "onlyfans") conversationRef = found.fanRef;
          // A fan that matches no fan of the page stays the buyer's string, as on the board.
          if (found === null) buyer = body.fan.slice(0, 300);
        }
        const telegramRef = body.telegramRef === undefined ? null : parseTelegramRef(body.telegramRef);
        // The card the finding is, and the one the person gives: the order's cards (the reader finds them by them).
        const telegramRefs = [...new Set([card, telegramRef].filter((ref): ref is string => ref !== null))];
        // «Принял»: the one chosen, else the finding's sale's one home, else the person when a chatter of the page; else nobody.
        const taker = await recordTakerOf(db, { pageId, acceptedBy: body.acceptedBy, transactionId: sale, userId });
        const orderId = await recordCustomOrder({ db }, {
          pageId, fanId, buyer, conversationRef, card: body.card, deadlineOn: null, acceptedByUserId: taker?.taker.userId ?? null, origin: "workboard",
          taker: taker === null ? null : { source: taker.source, ref: taker.ref, name: taker.taker.name, person: taker.person },
          telegramRefs, actor, now,
          ...(body.priceMills === undefined ? {} : { priceMills: body.priceMills, personFields: ["priceMills"] }),
        });
        // A sale that does not hold for the new order refuses the record whole: nothing of it is kept.
        await pay(orderId);
        await resolveCustomFinding(db, { id, status: "recorded", orderId, dismissReason: null, userId, at: now });
        await event("recorded", { code: customOrderCode(orderId) });
        return;
      }
      case "link": {
        const orderId = parseCustomOrderCode(body.code);
        const order = orderId === null ? null : await findCustomOrder(db, orderId);
        if (order === null || !seesOrder(viewer, order)) throw new NotFoundError("The custom order was not found");
        // The order takes something of the finding: a closed or cancelled one takes nothing, and the person must be one
        // who may change it by that step (a sale is its payment, a card its card, a chat's words its card's edit).
        if (order.state === "closed" || order.state === "cancelled") throw new ConflictError("The order is closed or cancelled", { reason: "not_allowed" });
        if (!mayTakeStep(viewer, order, sale !== null ? "payment" : card !== null ? "card" : "edit")) {
          throw new ConflictError("This order is not yours to change", { reason: "not_allowed" });
        }
        // A finding of a fan (his chat's words) is his order's: the same person and model. A sale's is checked with it.
        if (sale === null) await requireOfOrder(db, finding, order);
        // A sale's finding pays the order it is linked to — only one of its fan and its model; a card's is its card.
        await pay(order.id);
        if (card !== null) await applyCustomStep({ db }, { orderId: order.id, step: { action: "card", telegramRef: card }, actor, viewer: null, now, ...stepWord });
        await resolveCustomFinding(db, { id, status: "linked", orderId: order.id, dismissReason: null, userId, at: now });
        await event("linked", { code: customOrderCode(order.id) });
        return;
      }
    }
  });
  return { finding: findingWire((await findCustomFinding(app.db, id))!) };
}

// ── What the checks pass writes (customs facts spec §8, C1; behind the switch `customsFacts`) ───────────────────────

/**
 * The checks pass's side of the findings: one home for every trace of a custom with no order, `custom_findings`,
 * instead of the two kinds of matter before it.
 *
 *   Hub writes   a tip whose note speaks of a custom (Fansly's tip context; OnlyFans' tip message by its amount and
 *                time), a shift report's line marked «кастом» whose live sale pays no order, a card the reader found
 *                with no order. A sale is skipped only when it pays an order or has a finding already (a dismissed one
 *                never comes back); an open finding an order took since is linked to it. Never a purchase or renewal of
 *                a tier that includes a custom (the owner, 2026-11-22: only a fan who asked for one): its holders are the
 *                reader's candidates; the open ones the old tier finder wrote were dismissed once as «кастом не просил»
 *                (`not_asked`, migration 0437).
 *   switch-on    every open `custom.unrecorded` and `custom.card_without_order` matter becomes an open finding (from the
 *                moment it was opened); the two sets are compared, and only then the matters close (withdrawn) — those
 *                kinds are no longer written. «Не кастом» marks (`custom_sale_dismissals`) become dismissed findings.
 *                Idempotent: every pass with the switch on runs it, and finds nothing more to do.
 *   matters      `custom.finding` — a finding open a day, for the check's leader of its page; `custom.findings_owner`
 *                — one line for the owner with how many stand open three days. The test realm's findings go to its
 *                own leaders, never into the owner's count.
 */

type FindingsPassApp = Pick<AppContext, "db" | "logger">;

const HOUR_MS = 3_600_000;
/** Sales and shift reports are looked through this far back for new findings. */
export const FINDINGS_LOOK_BACK_DAYS = 14;
/** An open finding becomes the check's leader's matter after this long … */
export const FINDING_MATTER_HOURS = 24;
/** … and the owner's line after this long. */
export const FINDINGS_OWNER_HOURS = 72;
export const CARD_KIND = "custom.card_without_order";
const SYSTEM: MatterActor = { door: "system" };

/** The card's finding: the reader of the models' groups reports the cards of those groups (agentCustomCards). */
const CARD_SOURCE = "model_group" as const;

/**
 * The switch-on step: every open matter of the retired kinds as an open finding, then — when every one of them has its
 * finding — the matters closed as withdrawn; and «не кастом» marks as dismissed findings. Answers how many matters it
 * turned into findings and closed.
 */
export async function retireCustomFindingMatters(app: FindingsPassApp, now: Date): Promise<{ migrated: number; closed: number }> {
  await copyCustomSaleDismissals(app.db);
  const matters = await listOpenMattersOfKinds(app.db, [CUSTOM_UNRECORDED_KIND, CARD_KIND]);
  if (matters.length === 0) return { migrated: 0, closed: 0 };
  const sales: Array<{ transactionId: number; pageId: number | null; at: Date | null; createdAt: Date }> = [];
  const cards: Array<{ source: typeof CARD_SOURCE; telegramRef: string; postedAt: Date | null; createdAt: Date }> = [];
  const keyOf = new Map<string, string>();
  for (const matter of matters) {
    if (matter.kind === CUSTOM_UNRECORDED_KIND) {
      const transactionId = unrecordedSaleOf(matter.key);
      if (transactionId === null) continue;
      const at = typeof matter.evidence.at === "string" ? new Date(matter.evidence.at) : null;
      sales.push({ transactionId, pageId: matter.pageIds[0] ?? null, at: at !== null && !Number.isNaN(at.getTime()) ? at : null, createdAt: matter.openedAt });
      keyOf.set(matter.key, `sale:${transactionId}`);
    } else {
      const telegramRef = matter.key.slice(CARD_KIND.length + 1);
      const posted = typeof matter.evidence.postedAt === "string" ? new Date(matter.evidence.postedAt) : null;
      cards.push({ source: CARD_SOURCE, telegramRef, postedAt: posted !== null && !Number.isNaN(posted.getTime()) ? posted : null, createdAt: matter.openedAt });
      keyOf.set(matter.key, `${CARD_SOURCE}:${telegramRef}`);
    }
  }
  const migrated = (await insertCustomFindingsOfSales(app.db, sales)) + (await insertCustomCardFindings(app.db, cards));
  // The two sets compared: every open matter has its finding, or none of them closes yet (the next pass tries again).
  const present = await listCustomFindingKeys(app.db, [
    ...sales.map((sale) => ({ source: "sale", ref: String(sale.transactionId) })),
    ...cards.map((card) => ({ source: card.source, ref: card.telegramRef })),
  ]);
  const missing = matters.filter((matter) => !present.has(keyOf.get(matter.key) ?? ""));
  if (missing.length > 0) {
    app.logger.error({ missing: missing.map((matter) => matter.key).slice(0, 50), count: missing.length }, "custom checks: matters without their finding; none closed");
    return { migrated, closed: 0 };
  }
  let closed = 0;
  for (const matter of matters) {
    try {
      if ((await closeMatter(app.db, { key: matter.key, how: "withdrawn", writer: "server", note: "Перенесено в «Найдено без заказа»" }, SYSTEM, now)).transition === "closed") closed += 1;
    } catch (error) {
      app.logger.error({ err: error, key: matter.key }, "custom checks: a retired matter could not be closed");
    }
  }
  return { migrated, closed };
}

/**
 * Hub's own findings of a pass: tips whose note says custom and shift reports' lines marked «кастом» of the last two
 * weeks, and the ones an order took since. Never a tier's purchase or renewal (the owner, 2026-11-22: only a fan who
 * asked for a custom): the open ones written before were dismissed once as «кастом не просил» (migration 0437).
 */
export async function writeCustomFindings(app: FindingsPassApp, input: { now: Date }): Promise<{ written: number; linked: number }> {
  const { now } = input;
  const from = new Date(now.getTime() - FINDINGS_LOOK_BACK_DAYS * 24 * HOUR_MS);
  const sales = await insertCustomSaleFindings(app.db, { from, to: now, now });
  const reports = await insertShiftReportCustomFindings(app.db, { since: from, now });
  const linked = await linkCustomFindingsToOrders(app.db, now);
  return { written: sales + reports, linked };
}

/** The reader's cards no order has, as findings of the models' groups (the switch on: they are no longer matters). */
export async function reportCardFindings(app: FindingsPassApp, cards: ReadonlyArray<{ telegramRef: string; postedAt?: string | undefined }>, now: Date): Promise<number> {
  return insertCustomCardFindings(app.db, cards.map((card) => {
    const posted = card.postedAt === undefined ? null : new Date(card.postedAt);
    return { source: CARD_SOURCE, telegramRef: card.telegramRef, postedAt: posted !== null && !Number.isNaN(posted.getTime()) ? posted : null, createdAt: now };
  }));
}

/** A finding's source in people's words. */
const SOURCE_WORDS: Readonly<Record<string, string>> = {
  sale: "продажа похожа на кастом",
  fan_chat: "в чате с фаном",
  work_chat: "в рабочем чате",
  model_group: "в группе модели",
  shift_report: "в отчёте смены",
};

export interface FindingMatter {
  key: string;
  title: string;
  object: { type: string; id: string } | null;
  pageIds: number[];
  owner: MatterOwner;
  evidence: Record<string, unknown>;
  link: string;
}

/**
 * The matters of the open findings, pure (C1): each a day open → the check's leader of its page (`leadOf`); the ones
 * three days open, of the live agency, → one line for the owner with the count.
 */
export function findingMatters(input: {
  findings: readonly OpenCustomFindingRow[];
  now: Date;
  leadOf: (pageId: number | null) => MatterOwner;
}): { "custom.finding": FindingMatter[]; "custom.findings_owner": FindingMatter[] } {
  const out = { "custom.finding": [] as FindingMatter[], "custom.findings_owner": [] as FindingMatter[] };
  const age = (finding: OpenCustomFindingRow) => input.now.getTime() - finding.createdAt.getTime();
  const long: OpenCustomFindingRow[] = [];
  for (const finding of input.findings) {
    if (age(finding) < FINDING_MATTER_HOURS * HOUR_MS) continue;
    if (!finding.test && age(finding) >= FINDINGS_OWNER_HOURS * HOUR_MS) long.push(finding);
    out["custom.finding"].push({
      key: `custom.finding:${finding.id}`,
      title: `Кастом без заказа: ${SOURCE_WORDS[finding.source] ?? finding.source}, ${finding.pageLabel ?? "страница не известна"}`,
      object: { type: "custom_finding", id: String(finding.id) },
      pageIds: finding.pageId === null ? [] : [finding.pageId],
      owner: input.leadOf(finding.pageId),
      evidence: { findingId: finding.id, source: finding.source, since: finding.createdAt.toISOString(), happenedAt: finding.happenedAt.toISOString() },
      link: `/workboard/customs?finding=${finding.id}`,
    });
  }
  if (long.length > 0) {
    out["custom.findings_owner"].push({
      key: "custom.findings_owner:all",
      title: `Кастомы без заказа больше трёх дней: ${long.length}`,
      object: null,
      pageIds: [],
      owner: { role: "owner" },
      evidence: { count: long.length, findingIds: long.map((finding) => finding.id).slice(0, 50) },
      link: "/workboard/customs",
    });
  }
  return out;
}

/** The open findings a matter may be about: the ones written a day ago or earlier. */
export function openFindingsForMatters(app: Pick<AppContext, "db">, now: Date): Promise<OpenCustomFindingRow[]> {
  return listOpenCustomFindings(app.db, { before: new Date(now.getTime() - FINDING_MATTER_HOURS * HOUR_MS) });
}
