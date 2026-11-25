import type { AgentTeamSale, ShiftReportBody, ShiftReportLineFacts, ShiftReportStatement } from "@agency_hub_core/contracts";
import {
  ensureHandin,
  findHandinByShift,
  findHandinPersonOfUser,
  findHandinShift,
  findPersonRowByCode,
  isTestUser,
  listActiveSaleDecisions,
  listHandinLastWrites,
  listHandinMarks,
  listHandinNames,
  listHandinOtherReports,
  listHandinRenewals,
  listHandinSaleFans,
  listHandinSaleKinds,
  listHandinSalesByIds,
  listHandinShifts,
  listHandinsOfShifts,
  listMatterPageLabels,
  listPersonWorkingPageRows,
  listRecipientOpenShifts,
  listReportedSales,
  listSaleClaims,
  listSaleDeliveries,
  listSaleFacts,
  listSaleHomes,
  listSalesMessagedByUsers,
  listVisiblePages,
  versionReportDate,
  type Database,
  type HandinDoor,
  type HandinMarkRow,
  type HandinPerson,
  type HandinRow,
  type HandinSaleRow,
  type HandinShift,
  type HandinVersionLine,
  type HandinVersionOffPlatform,
  type HandinVersionRow,
  type OffPlatformRow,
} from "@agency_hub_core/db";
import { moscowDayOfMs } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import type { AgentAuthPrincipal, HumanAuthPrincipal } from "./auth.ts";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors.ts";
import { readLedgerPayouts } from "./ledger-payouts.ts";
import { soloPagesForPerson } from "./page-workers.ts";
import { settledShareOf } from "./sale-claim-rules.ts";
import { SALE_RULE, slotRuns, type RuleSlot, type SaleHomeKind, type SaleHomeReason } from "./sale-rule.ts";
import { computeSaleHomes, registrySlots, ruleWorksOf } from "./sale-homes.ts";
import { testPageIds } from "./sandbox/realm.ts";
import {
  HANDIN_LOOKBACK_DAYS,
  claimedSale,
  classifySale,
  lineAmount,
  modelComment,
  reasonWords,
  slotWindowOf,
  statementAllowed,
  type ClassifiedSale,
  type DraftSale,
  type DraftShare,
  type ReportComments,
  type Statement,
} from "./shift-handin-rules.ts";

/**
 * The draft core of a shift's report (shift-handins.ts is its service): who reads and who writes, the shift as a
 * subject, the pages' catalog, the draft from the one rule and the person's words, and the few facts of a report the
 * board, Hub's check and the sale claims read. It imports none of them (shift-handins, shift-report-board*,
 * shift-handin-check, sale-claims): each of them reads it.
 */

/** A word of the board as the ledger's three (the feed and the old line keep their format): given away or to the pot is «не моё». */
export function ledgerStatementOf(statement: Statement | null): ShiftReportStatement | null {
  return statement === "give" || statement === "pot" ? "not_mine" : statement;
}

export type HandinApp = Pick<AppContext, "db" | "config" | "logger">;

const DAY_MS = 86_400_000;

// ── Who reads, who writes ────────────────────────────────────────────────────

/** A person's door: Workboard by a session (the extension's narrow one too), the extension by its device token. */
export interface HandinPersonActor {
  kind: "person";
  userId: number;
  role: string;
  pageIds: readonly number[];
  door: "workboard" | "extension";
}

/** An agent key «со слов»: the person's words in a Telegram message. */
export interface HandinAgentActor {
  kind: "agent";
  agentKeyId: number;
  keyName: string;
  pageIds: readonly number[];
  telegramUserId: number;
  sourceRef: string | null;
}

export type HandinActor = HandinPersonActor | HandinAgentActor;

export function handinActorOf(principal: HumanAuthPrincipal): HandinPersonActor {
  return {
    kind: "person",
    userId: principal.user.id,
    role: principal.user.role,
    pageIds: principal.assignedPageIds,
    door: principal.authMethod === "device_token" ? "extension" : "workboard",
  };
}

export function handinAgentActorOf(principal: AgentAuthPrincipal, pageIds: readonly number[], words: { telegramUserId: number; sourceRef?: string | undefined }): HandinAgentActor {
  return {
    kind: "agent",
    agentKeyId: principal.agentKeyId,
    keyName: principal.keyName,
    pageIds,
    telegramUserId: words.telegramUserId,
    sourceRef: words.sourceRef ?? null,
  };
}

/** The plane's one 404 for an agent: missing and out of grant are the same bytes. */
export const notFound = () => new NotFoundError("Not found");

export interface Subject {
  shift: HandinShift;
  person: HandinPerson | null;
  /** Every login of the person (the shift's own at least). */
  userIds: number[];
  enabled: boolean;
}

export async function subjectOf(db: Database, shiftId: number): Promise<Subject> {
  const shift = await findHandinShift(db, shiftId);
  if (shift === null || shift.state === "dropped") throw new NotFoundError("No such shift");
  const person = await findHandinPersonOfUser(db, shift.userId);
  const userIds = [...new Set([shift.userId, ...(person?.userIds ?? [])])];
  return { shift, person, userIds, enabled: person?.submitsShiftSince != null };
}

export interface PageCatalog {
  idOf: Map<string, number>;
  labelOf: Map<number, string>;
  /** Active pages: platform and model. */
  info: Map<string, { platform: string; modelSlug: string; modelName: string }>;
}

export async function pageCatalog(db: Database): Promise<PageCatalog> {
  const labels = await listMatterPageLabels(db);
  // Both realms: the catalog only names pages (who may read which is `accessOf`'s and the realm wall's). Without the
  // test pages a test shift's OnlyFans column read as Fansly and its model as unknown.
  const test = [...await testPageIds({ db })];
  const visible = [...await listVisiblePages(db), ...(test.length > 0 ? await listVisiblePages(db, test) : [])];
  return {
    idOf: labels.idOf,
    labelOf: labels.labelOf,
    info: new Map(visible.map((page) => [page.label, { platform: page.platform, modelSlug: page.modelSlug ?? page.label, modelName: page.modelName ?? page.label }])),
  };
}

export const shiftPageLabels = (shift: HandinShift) => shift.pages.map((page) => page.pageLabel);

/**
 * The model a page's post and its comment go by (0432): the page's model; the page itself when it has none or is not
 * active. The one key of both, so a post and its comment never disagree on it.
 */
export function pageModelOf(catalog: Pick<PageCatalog, "info">, pageLabel: string): { modelSlug: string; modelName: string } {
  const info = catalog.info.get(pageLabel);
  return { modelSlug: info?.modelSlug ?? pageLabel, modelName: info?.modelName ?? pageLabel };
}

/** The models of pages (`pageModelOf`), each once, in the pages' order. */
export function modelsOfPages(catalog: Pick<PageCatalog, "info">, pageLabels: readonly string[]): Array<{ slug: string; name: string }> {
  const models: Array<{ slug: string; name: string }> = [];
  for (const label of pageLabels) {
    const model = pageModelOf(catalog, label);
    if (!models.some((one) => one.slug === model.modelSlug)) models.push({ slug: model.modelSlug, name: model.modelName });
  }
  return models;
}

/**
 * Each model's comment of a report (`modelComment`), in the posts' order: the models of the pages its posts list
 * (`postPagesOf`) that the reader sees (`cutTo`; null — every page). Pure.
 */
export function commentsOf(
  report: ReportComments & Pick<HandinVersionRow, "pages" | "lines">,
  subject: Pick<Subject, "shift">,
  catalog: Pick<PageCatalog, "info">,
  cutTo: Set<string> | null,
): ShiftReportBody["comments"] {
  const pages = postPagesOf(report, subject).map((page) => page.pageLabel).filter((label) => cutTo === null || cutTo.has(label));
  return modelsOfPages(catalog, pages).map((model) => ({ modelSlug: model.slug, modelName: model.name, comment: modelComment(report, model.slug) }));
}

/** How the reader may see the subject: own, the owner's, a reader on shared pages (cut to them), or not at all. */
export function accessOf(actor: HandinActor, subject: Subject, catalog: PageCatalog): { access: "own" | "read"; cutTo: Set<string> | null; draftPreview: boolean } {
  if (actor.kind === "agent") {
    // An agent writes for the person: every page of the shift must be of its grant.
    const granted = new Set(actor.pageIds);
    if (!shiftPageLabels(subject.shift).every((label) => granted.has(catalog.idOf.get(label) ?? -1))) throw notFound();
    return { access: "own", cutTo: null, draftPreview: false };
  }
  if (subject.userIds.includes(actor.userId)) return { access: "own", cutTo: null, draftPreview: false };
  if (actor.role === "owner") return { access: "read", cutTo: null, draftPreview: true };
  const mine = new Set(actor.pageIds.map((id) => catalog.labelOf.get(id)).filter((label): label is string => label !== undefined));
  const shared = shiftPageLabels(subject.shift).filter((label) => mine.has(label));
  if (shared.length === 0) throw new ForbiddenError("This shift is on pages you do not work");
  return { access: "read", cutTo: mine, draftPreview: actor.role === "team_lead" };
}

/** The writer must be the person, switched on; an agent's sender must be the person's Telegram id. */
export function requireWriter(actor: HandinActor, subject: Subject): void {
  if (!subject.enabled) throw new ForbiddenError("The shift report is not switched on for this person");
  if (actor.kind === "person") {
    if (!subject.userIds.includes(actor.userId)) throw new ForbiddenError("Only the person hands their shift in");
    return;
  }
  if (subject.person?.telegramUserId == null || subject.person.telegramUserId !== actor.telegramUserId) {
    throw new ConflictError("The message's sender is not this person", { reason: "sender_not_person" });
  }
}

// ── The draft ────────────────────────────────────────────────────────────────

/** The draft's facts: every classified sale of the shift, read before the person's words are applied. */
export interface DraftFacts {
  computedAt: Date;
  classified: ClassifiedSale[];
  unavailableDeliveries: Set<number>;
  /** The shift's pages that hold sales, in the shift's order. */
  pages: string[];
  /** The live facts of the window's sales (the answer the rule read), by transaction; the works by ref. */
  live: Map<number, AgentTeamSale>;
  works: Map<string, { userId: number; kind: string }>;
  /** A near sale's bought PPV sender, by transaction. */
  senders: Map<number, number>;
  /** What a sale the owner decided or the sides agreed on gives the person, by transaction (review R2-a). */
  settled: Map<number, { amountMills: number; settled: "owner" | "agreed" }>;
  /**
   * The person's own «моё» still open — asked of a colleague or waiting for the decider (a card of Gengar they said «Не
   * согласен» to): the sale waits, counting nothing here until answered or decided («спорная строка ждёт отдельно»).
   */
  waiting?: Set<number>;
}

/** The shift's own work among the rule's works: the person's shift that ran with it the longest. */
function shiftWorkRef(works: ReturnType<typeof ruleWorksOf>, subject: Subject, to: number): string | null {
  let best: { ref: string; overlap: number } | null = null;
  const from = subject.shift.startedAt.getTime();
  for (const work of works) {
    if (work.kind !== "shift" || !subject.userIds.includes(work.userId)) continue;
    const overlap = Math.min(to, work.endedAt) - Math.max(from, work.startedAt);
    if (overlap > 0 && (best === null || overlap > best.overlap)) best = { ref: work.ref, overlap };
  }
  return best?.ref ?? null;
}

/** The report's window: the actual shift joined with the schedule slot it ran in, and the pages of both (plan §4). */
interface ReportWindow {
  from: number;
  to: number;
  pages: Set<string>;
}

async function reportWindowOf(db: Database, subject: Subject, slots: readonly RuleSlot[], catalog: PageCatalog, shiftEnd: number): Promise<ReportWindow> {
  const { shift } = subject;
  const held = shift.pages.filter((page) => page.salesFrom !== null).map((page) => page.pageLabel);
  // A slot of every page stands for the person's working pages, page by page: a swap's `off` of one page cuts it there.
  const working = subject.person === null ? [] : await listPersonWorkingPageRows(db, [subject.person.personId]);
  const slot = slotWindowOf(slots, {
    userIds: new Set(subject.userIds), startedAt: shift.startedAt.getTime(), endedAt: shiftEnd, pagesOfAll: working.map((row) => row.pageId),
  });
  const pages = new Set(held);
  if (slot !== null) {
    for (const pageId of slot.pageIds) {
      const label = pageId === null ? undefined : catalog.labelOf.get(pageId);
      if (label !== undefined) pages.add(label);
    }
    if (slot.pageIds.includes(null)) for (const row of working) pages.add(row.label);
  }
  return {
    from: Math.min(shift.startedAt.getTime(), slot?.from ?? Number.POSITIVE_INFINITY),
    to: Math.max(shiftEnd, slot?.to ?? Number.NEGATIVE_INFINITY),
    pages,
  };
}

export async function draftFacts(
  db: Database,
  subject: Subject,
  handin: HandinRow | null,
  catalog: PageCatalog,
  now: Date,
  marks: readonly HandinMarkRow[] = [],
  candidate: readonly HandinVersionLine[] = [],
  options?: { allowedPageIds?: ReadonlySet<number> },
): Promise<DraftFacts> {
  const { shift } = subject;
  const allowedPageIds = options?.allowedPageIds;
  const allowedLabels = allowedPageIds === undefined
    ? null
    : new Set([...allowedPageIds].map((id) => catalog.labelOf.get(id)).filter((label): label is string => label !== undefined));
  const shiftEnd = shift.state === "going" ? Math.max(now.getTime(), shift.endedAt.getTime()) : shift.endedAt.getTime() + 1;
  // The same slots the hourly `sale_homes` job reads: the draft's homes are the rule's homes.
  const slotProvider = registrySlots(db);
  const slots = await slotProvider.slotsFor({ from: new Date(shift.startedAt.getTime() - 2 * DAY_MS), to: new Date(shiftEnd + DAY_MS) });
  const rawWindow = await reportWindowOf(db, subject, slots, catalog, shiftEnd);
  const window: ReportWindow = allowedLabels === null
    ? rawWindow
    : { ...rawWindow, pages: new Set([...rawWindow.pages].filter((label) => allowedLabels.has(label))) };
  // On a solo page (exact 1 active worker on the report day), expose unclaimed `nobody` sales of that exact 24h Moscow
  // day in «Рядом» (default $0 -> stays nobody unless the chatter marks «моё»). Never widen outside an agent's grant.
  const soloPageLabels = new Set<string>();
  const reportDayStart = Date.parse(`${shift.reportDate}T00:00:00+03:00`);
  const reportDayEnd = reportDayStart + DAY_MS;
  const candidatePageLabels = new Set(
    [...window.pages, ...shiftPageLabels(shift)].filter((label) => allowedLabels === null || allowedLabels.has(label)),
  );
  if (subject.person !== null && !Number.isNaN(reportDayStart)) {
    const candidatePageIds = [...candidatePageLabels]
      .map((label) => catalog.idOf.get(label))
      .filter((id): id is number => id !== undefined && (allowedPageIds === undefined || allowedPageIds.has(id)));
    if (candidatePageIds.length > 0) {
      const realm = (await isTestUser(db, shift.userId)) ? "test" : "live";
      const soloIds = await soloPagesForPerson(db, realm, subject.person.personId, shift.reportDate, candidatePageIds);
      for (const pageId of soloIds) {
        const label = catalog.labelOf.get(pageId);
        if (label !== undefined && (allowedLabels === null || allowedLabels.has(label))) soloPageLabels.add(label);
      }
    }
  }
  const hasSoloPages = soloPageLabels.size > 0;
  const from = new Date(hasSoloPages ? Math.min(window.from, reportDayStart) : window.from);
  const to = new Date(hasSoloPages ? Math.max(window.to, shiftEnd, Math.min(reportDayEnd, now.getTime())) : Math.max(window.to, shiftEnd));
  const live = await computeSaleHomes(db, { from, to, now, slots: slotProvider });
  const works = ruleWorksOf(live.answer.works);
  const workRef = shiftWorkRef(works, subject, shiftEnd);
  const workOf = new Map(works.map((work) => [work.ref, work]));

  // The person's other works in the window: a shift's row (its report holds its sales), a look-in none.
  const ownRows = await listHandinShifts(db, { userIds: subject.userIds, from: new Date(window.from - 2 * DAY_MS), to: new Date(window.to + DAY_MS) });
  const rowOfWork = (ref: string | null): number | null => {
    if (ref === null || ref === workRef) return ref === null ? null : shift.id;
    const work = workOf.get(ref);
    if (work === undefined || work.kind !== "shift") return null;
    const row = ownRows.find((one) => one.userId === work.userId && one.startedAt.getTime() <= work.startedAt && work.startedAt <= one.endedAt.getTime());
    // A shift whose row is not written yet: its own report will hold it, never «долёт».
    return row?.id ?? -1;
  };

  const sales: DraftSale[] = live.answer.sales.flatMap((sale, index) => {
    if (allowedLabels !== null && !allowedLabels.has(sale.pageLabel)) return [];
    const home = live.homes[index]!;
    const at = Date.parse(sale.occurredAt);
    const isDayNobody = home.kind === "nobody" && home.reason !== "owner_nobody"
      && candidatePageLabels.has(sale.pageLabel) && !Number.isNaN(reportDayStart) && at >= reportDayStart && at < reportDayEnd;
    return [{
      transactionId: Number(sale.transactionRef),
      pageLabel: sale.pageLabel,
      platform: sale.platform,
      kind: sale.kind,
      occurredAt: at,
      netMills: sale.netMills,
      home: {
        kind: home.kind,
        reason: home.reason,
        pot: home.pot,
        shares: home.shares.map((share): DraftShare => ({
          userId: share.userId,
          workRef: share.workRef,
          shiftId: subject.userIds.includes(share.userId) ? rowOfWork(share.workRef) : null,
          mills: share.mills,
        })),
        waitsUntil: home.waitsUntil,
      },
      ppvSenderUserId: sale.ppvSender?.userId ?? null,
      source: "window",
      heldByShift: workRef !== null && sale.holders.includes(workRef),
      // Strict report window only (plus same-day unclaimed nobody for messaged-fan lookup); solo-page 24h visibility
      // is enforced separately in `classifySale` strictly for unclaimed `nobody` sales inside `[reportDayStart, reportDayEnd)`.
      inReportWindow: (window.pages.has(sale.pageLabel) && at >= window.from && at < window.to) || isDayNobody,
    }];
  });

  const beforeToMs = Number.isNaN(reportDayEnd) ? from.getTime() : Math.max(from.getTime(), Math.min(reportDayEnd, now.getTime()));
  const liveIds = new Set(sales.map((sale) => sale.transactionId));
  const beforeAll = await listSaleHomes(db, { from: new Date(window.from - HANDIN_LOOKBACK_DAYS * DAY_MS), to: new Date(beforeToMs) });
  const beforeCandidates = beforeAll.filter((row) => {
    if (allowedPageIds !== undefined && !allowedPageIds.has(row.pageId)) return false;
    if (liveIds.has(row.transactionId)) return false;
    const at = row.occurredAt.getTime();
    if (at < from.getTime() && row.shares.some((share) => subject.userIds.includes(share.userId))) return true;
    const label = catalog.labelOf.get(row.pageId) ?? String(row.pageId);
    return row.home === "nobody" && row.reason !== "owner_nobody"
      && candidatePageLabels.has(label) && !Number.isNaN(reportDayStart) && at >= reportDayStart && at < reportDayEnd;
  });
  const beforeNobodyIds = beforeCandidates.filter((row) => row.home === "nobody").map((row) => row.transactionId);
  const beforeActiveDecisions = beforeNobodyIds.length === 0 ? new Set<number>() : new Set((await listActiveSaleDecisions(db, beforeNobodyIds)).keys());
  const before = beforeCandidates.filter((row) => !(row.home === "nobody" && beforeActiveDecisions.has(row.transactionId)));
  const kinds = await listHandinSaleKinds(db, before.map((row) => row.transactionId));
  for (const row of before) {
    const label = catalog.labelOf.get(row.pageId) ?? String(row.pageId);
    const at = row.occurredAt.getTime();
    const isDayNobody = row.home === "nobody" && row.reason !== "owner_nobody"
      && candidatePageLabels.has(label) && !Number.isNaN(reportDayStart) && at >= reportDayStart && at < reportDayEnd;
    sales.push({
      transactionId: row.transactionId,
      pageLabel: label,
      platform: catalog.info.get(label)?.platform ?? "fansly",
      kind: kinds.get(row.transactionId) ?? "",
      occurredAt: at,
      netMills: row.netMills,
      home: {
        kind: row.home as SaleHomeKind,
        reason: row.reason as SaleHomeReason,
        pot: row.pot,
        shares: row.shares.map((share) => ({ userId: share.userId, workRef: share.workRef, shiftId: share.shiftId, mills: share.mills })),
        waitsUntil: row.waitsUntil?.getTime() ?? null,
      },
      ppvSenderUserId: null,
      source: "before",
      heldByShift: false,
      inReportWindow: isDayNobody,
    });
  }

  const deliveries = await listSaleDeliveries(db, {
    userIds: subject.userIds, linkedOnly: true,
    draft: { shiftId: shift.id, transactionIds: [...sales.map((sale) => sale.transactionId), ...marks.map((mark) => mark.transactionId),
      ...candidate.flatMap((line) => line.transactionId === null ? [] : [line.transactionId])] },
  });
  const deliveryOf = new Map(deliveries.map((one) => [one.decision.transactionId!, one]));
  const openShifts = deliveries.some((one) => one.state === "pending" && one.shiftId === null)
    ? await listRecipientOpenShifts(db, { userIds: subject.userIds }) : [];
  const landingShiftFor = (delivery: typeof deliveries[number], occurredAt: Date): number | null => {
    if (delivery.shiftId !== null || delivery.state !== "pending") return delivery.shiftId;
    const at = occurredAt.getTime();
    const day = moscowDayOfMs(at);
    return openShifts.find((one) => one.reportDate >= day || (at >= one.startedAt.getTime() && at <= one.endedAt.getTime()))?.shiftId ?? null;
  };

  const unavailableDeliveries = new Set<number>();
  const belongsElsewhere = (id: number, at: Date) => {
    const delivery = deliveryOf.get(id);
    if (delivery === undefined || landingShiftFor(delivery, at) === shift.id) return false;
    unavailableDeliveries.add(id);
    return true;
  };
  for (const line of candidate) {
    if (line.transactionId !== null && line.occurredAt !== null) belongsElsewhere(line.transactionId, new Date(line.occurredAt));
  }

  // Which of the person's shifts were handed in, and which sales their reports hold.
  const ownShiftIds = [...new Set(sales.flatMap((sale) => sale.home.shares
    .filter((share) => subject.userIds.includes(share.userId) && share.shiftId !== null && share.shiftId > 0)
    .map((share) => share.shiftId!)))];
  const ownHandins = await listHandinsOfShifts(db, ownShiftIds);
  const submittedShiftIds = new Set([...ownHandins.values()].filter((one) => one.state === "submitted").map((one) => one.shiftId));
  const since = new Date(window.from - (HANDIN_LOOKBACK_DAYS + 3) * DAY_MS).toISOString().slice(0, 10);
  const reported = await listReportedSales(db, { userIds: subject.userIds, since });
  const switchOnAt = subject.person?.submitsShiftSince?.getTime() ?? null;
  // Surface unclaimed `nobody` sales on the board for chatters who have personally messaged that fan on that page in
  // history (at $0 until they say «моё»: then the whole net is theirs, unless another person's report holds it).
  const nobodyCandidates = sales.filter((sale) =>
    sale.home.kind === "nobody" && sale.home.reason !== "owner_nobody" && (sale.heldByShift || sale.inReportWindow));
  let messagedNobodyIds = new Set<number>();
  if (nobodyCandidates.length > 0) {
    const nobodyFans = await listHandinSaleFans(db, nobodyCandidates.map((sale) => sale.transactionId));
    const checkSales = nobodyCandidates.flatMap((sale) => {
      const pageId = catalog.idOf.get(sale.pageLabel);
      const fanRef = nobodyFans.get(sale.transactionId)?.fanRef ?? null;
      return pageId === undefined || fanRef === null ? [] : [{ transactionId: sale.transactionId, pageId, fanRef, at: new Date(sale.occurredAt) }];
    });
    messagedNobodyIds = await listSalesMessagedByUsers(db, { userIds: subject.userIds, sales: checkSales });
  }
  // The sales the person's words here say «не моё» of: each stays their own line (shift-handin-rules.ts).
  const notMine = new Set(marks.filter((mark) => mark.statement === "not_mine").map((mark) => mark.transactionId));
  const context = {
    shiftId: shift.id,
    workRef,
    userIds: new Set(subject.userIds),
    switchOnAt,
    submittedShiftIds,
    reported,
    handinId: handin?.id ?? null,
    notMine,
    ...(hasSoloPages ? { soloDayWindow: { pages: soloPageLabels, from: reportDayStart, to: reportDayEnd } } : {}),
    messagedNobodyIds,
  };

  const classified: ClassifiedSale[] = [];
  const seen = new Set<number>();
  for (const sale of sales) {
    if (seen.has(sale.transactionId)) continue;
    const delivery = deliveryOf.get(sale.transactionId);
    if (belongsElsewhere(sale.transactionId, new Date(sale.occurredAt))) continue;
    // A historical decision may already be in an external report. Never carry it into another shift.
    if (delivery === undefined && sale.source === "before" && (sale.home.reason === "owner_claim" || sale.home.reason === "owner_split")
      && (handin === null || reported.get(sale.transactionId)?.handinId !== handin.id)) continue;
    const one = classifySale(sale, context);
    if (one === null) continue;
    seen.add(sale.transactionId);
    classified.push(one);
  }
  // One of them the draft no longer reads — of the days before the shift, its home naming the person no more — is
  // read by its id: the word keeps it a line of the report it was said in.
  for (const row of await listHandinSalesByIds(db, [...notMine].filter((id) => !seen.has(id)))) {
    if (allowedPageIds !== undefined && !allowedPageIds.has(row.pageId)) continue;
    const one = classifySale(saleOfRow(row), context);
    if (one === null) continue;
    seen.add(row.transactionId);
    classified.push(one);
  }

  // The sales the person added by hand: a «моё» on a sale no group of the draft holds.
  const claimedIds = marks.filter((mark) => mark.statement === "mine" && !seen.has(mark.transactionId)).map((mark) => mark.transactionId);
  const claimedRows = (await listHandinSalesByIds(db, claimedIds))
    .filter((row) => allowedPageIds === undefined || allowedPageIds.has(row.pageId));
  const others = await listHandinOtherReports(db, {
    transactionIds: [...claimedRows.map((row) => row.transactionId), ...classified.filter((one) => one.group === "near").map((one) => one.sale.transactionId)],
    exceptUserIds: subject.userIds,
  });
  for (const one of classified) if (one.group === "near") one.otherReport = others.has(one.sale.transactionId);
  for (const row of claimedRows) {
    if (belongsElsewhere(row.transactionId, row.occurredAt)) continue;
    classified.push(claimedSale(saleOfRow(row), context, others.has(row.transactionId)));
    seen.add(row.transactionId);
  }

  // Include a delivery outside the ordinary sale window only on its recipient's landing report.
  const unshown = deliveries.filter((one) => one.state !== "declined" && !seen.has(one.decision.transactionId!)
    && (one.shiftId === shift.id || (one.state === "pending" && one.shiftId === null)));
  if (unshown.length > 0) {
    const rows = (await listHandinSalesByIds(db, unshown.map((one) => one.decision.transactionId!)))
      .filter((row) => allowedPageIds === undefined || allowedPageIds.has(row.pageId));
    const byId = new Map(rows.map((row) => [row.transactionId, row]));
    for (const delivery of unshown) {
      const decision = delivery.decision;
      const saleId = decision.transactionId!;
      const row = byId.get(saleId);
      if (row === undefined || landingShiftFor(delivery, row.occurredAt) !== shift.id) continue;
      const share = settledShareOf({ netMills: row.netMills, userIds: context.userIds, decision, agreed: [] });
      if (share === null || share.amountMills <= 0) continue;
      const reason: SaleHomeReason = decision.ruleHome === "nobody" && decision.shares.filter((one) => one.percent > 0).length === 1
        ? "owner_claim"
        : "owner_split";
      const base = saleOfRow(row);
      const draftSale: DraftSale = {
        ...base,
        home: {
          kind: "shift",
          reason,
          pot: null,
          shares: [{ userId: subject.shift.userId, workRef: null, shiftId: null, mills: share.amountMills }],
        },
      };
      classified.push({
        sale: draftSale,
        group: "mine",
        added: true,
        shareMills: share.amountMills,
        toUserId: null,
        alreadyIn: null,
      });
      seen.add(saleId);
    }
  }
  classified.sort((a, b) => (a.group === b.group ? a.sale.occurredAt - b.sale.occurredAt : a.group === "mine" ? -1 : 1));

  const senders = new Map(classified.flatMap((one) => (one.sale.ppvSenderUserId === null ? [] : [[one.sale.transactionId, one.sale.ppvSenderUserId] as const])));

  // A sale the owner decided or the two sides agreed on: the person's line counts what that gives them, settled, in
  // every later draft — their old «моё» no longer takes the money back, nor opens the dispute again (review R2-a).
  const saleIds = classified.map((one) => one.sale.transactionId);
  const decisions = await listActiveSaleDecisions(db, saleIds);
  const agreed = await listSaleClaims(db, { transactionIds: saleIds, states: ["agreed"] });
  const waiting = new Set(handin === null ? [] : (await listSaleClaims(db, { transactionIds: saleIds, states: ["asked", "owner"] }))
    .filter((claim) => claim.kind === "claim" && claim.claimantHandinId === handin.id && claim.statement === "mine" && claim.transactionId !== null)
    .map((claim) => claim.transactionId!));
  const settled = new Map<number, { amountMills: number; settled: "owner" | "agreed" }>();
  for (const one of classified) {
    const id = one.sale.transactionId;
    const share = settledShareOf({
      netMills: one.sale.netMills, userIds: context.userIds, decision: decisions.get(id) ?? null,
      agreed: agreed.filter((claim) => claim.transactionId === id),
    });
    if (unavailableDeliveries.has(id) || deliveryOf.get(id)?.state === "declined" || belongsElsewhere(id, new Date(one.sale.occurredAt))) settled.set(id, { amountMills: 0, settled: "owner" });
    else if (share !== null) settled.set(id, share);
  }
  return {
    computedAt: now,
    classified, unavailableDeliveries,
    pages: shift.pages.filter((page) => page.salesFrom !== null).map((page) => page.pageLabel),
    live: new Map(live.answer.sales.map((sale) => [Number(sale.transactionRef), sale])),
    works: new Map(works.map((work) => [work.ref, { userId: work.userId, kind: work.kind }])),
    senders,
    settled,
    waiting,
  };
}

/** A sale read by id as the draft reads a sale: its home as `sale_homes` keeps it, «unknown» when not computed yet. */
function saleOfRow(row: HandinSaleRow): DraftSale {
  return {
    transactionId: row.transactionId,
    pageLabel: row.pageLabel,
    platform: row.platform,
    kind: row.kind,
    occurredAt: row.occurredAt.getTime(),
    netMills: row.netMills,
    home: row.home === null
      ? { kind: "unknown", reason: "holder_not_in_works", pot: null, shares: [] }
      : {
        kind: row.home.home as SaleHomeKind,
        reason: row.home.reason as SaleHomeReason,
        pot: row.home.pot,
        shares: row.home.shares,
        waitsUntil: row.home.waitsUntil?.getTime() ?? null,
      },
    ppvSenderUserId: null,
    source: "before",
    heldByShift: false,
    inReportWindow: false,
  };
}

const LAST_WRITE_DAYS = 60;
const HOUR_MS = 3_600_000;

/**
 * The facts of each line of a draft, for «почему» and for an agent's talk with the person: the PPV's sender and
 * when, the last writer and when (60 days back; whether within the rule's 48 hours), the writers of the 48 hours, the
 * other people's shifts holding the page and whose schedule slot ran, another person's report holding the sale, the
 * pot, a subscription's renewal. Read, not decided: the rule already decided (`sale_homes`).
 */
export async function lineDetails(db: Database, subject: Subject, facts: DraftFacts, catalog: PageCatalog): Promise<Map<number, ShiftReportLineFacts>> {
  const ids = facts.classified.map((one) => one.sale.transactionId);
  if (ids.length === 0) return new Map();
  const saleFacts = new Map((await listSaleFacts(db, { transactionIds: ids })).map((fact) => [fact.transactionId, fact]));
  const fans = await listHandinSaleFans(db, ids);
  const lastWrites = await listHandinLastWrites(db, {
    days: LAST_WRITE_DAYS,
    sales: facts.classified.flatMap((one) => {
      const pageId = catalog.idOf.get(one.sale.pageLabel);
      const fanRef = fans.get(one.sale.transactionId)?.fanRef ?? null;
      return pageId === undefined || fanRef === null ? [] : [{ transactionId: one.sale.transactionId, pageId, fanRef, at: new Date(one.sale.occurredAt) }];
    }),
  });
  const renewals = await listHandinRenewals(db, facts.classified.filter((one) => one.sale.kind === "subscription").map((one) => one.sale.transactionId));
  const others = await listHandinOtherReports(db, { transactionIds: ids, exceptUserIds: subject.userIds });
  const times = facts.classified.map((one) => one.sale.occurredAt);
  const ruleSlots = await registrySlots(db).slotsFor({ from: new Date(Math.min(...times) - DAY_MS), to: new Date(Math.max(...times) + DAY_MS) });
  const slotted = new Set(ruleSlots.map((slot) => slot.personId));
  const slotAt = (userId: number, pageLabel: string, at: number) => (slotted.has(userId)
    ? slotRuns(ruleSlots, { personId: userId, pageId: catalog.idOf.get(pageLabel) ?? null, at })
    : null);

  const userIds = new Set<number>();
  for (const fact of saleFacts.values()) {
    if (fact.ppvSender) userIds.add(fact.ppvSender.userId);
    for (const writer of fact.writers) userIds.add(writer.userId);
  }
  for (const write of lastWrites.values()) userIds.add(write.userId);
  for (const list of others.values()) for (const one of list) userIds.add(one.userId);
  for (const sale of facts.live.values()) for (const ref of sale.holders) userIds.add(facts.works.get(ref)?.userId ?? -1);
  const names = await listHandinNames(db, [...userIds].filter((id) => id > 0));
  const nameOf = (id: number) => names.get(id) ?? `#${id}`;

  const out = new Map<number, ShiftReportLineFacts>();
  for (const one of facts.classified) {
    const id = one.sale.transactionId;
    const fact = saleFacts.get(id);
    const live = facts.live.get(id);
    const write = lastWrites.get(id);
    const isPpv = one.sale.kind === "message_purchase";
    const holders = live === undefined || one.sale.source !== "window" ? null : [...new Set(live.holders
      .map((ref) => facts.works.get(ref))
      .filter((work): work is { userId: number; kind: string } => work !== undefined && work.kind === "shift" && !subject.userIds.includes(work.userId))
      .map((work) => work.userId))]
      .map((userId) => ({ userId, name: nameOf(userId), slotRunning: slotAt(userId, one.sale.pageLabel, one.sale.occurredAt) }));
    out.set(id, {
      ppv: isPpv ? {
        senderUserId: fact?.ppvSender?.userId ?? null,
        senderName: fact?.ppvSender ? nameOf(fact.ppvSender.userId) : null,
        sentAt: fact?.ppvSentAt?.toISOString() ?? null,
        withoutAuthor: fact?.ppvWithoutAuthor ?? false,
      } : null,
      lastWriter: write === undefined ? null : {
        userId: write.userId, name: nameOf(write.userId), at: write.at.toISOString(),
        within48h: one.sale.occurredAt - write.at.getTime() < SALE_RULE.lastWriterHours * HOUR_MS,
      },
      writers: (fact?.writers ?? []).map((writer) => ({ userId: writer.userId, name: nameOf(writer.userId), messages: writer.messages })),
      holders,
      ownSlotRunning: slotAt(subject.shift.userId, one.sale.pageLabel, one.sale.occurredAt),
      otherReports: (others.get(id) ?? []).map((other) => ({ userId: other.userId, name: nameOf(other.userId), shiftId: other.shiftId, reportDate: other.reportDate })),
      pot: one.sale.home.pot,
      renewalOf: renewals.get(id)?.toISOString() ?? null,
    });
  }
  return out;
}

/**
 * The person's words on the facts: the version's lines, as they would be handed in now. A sale the owner decided or the
 * sides agreed on counts what that gives the person (`facts.settled`), settled and not disputed, whatever the word.
 * Pure.
 */
export function draftLines(facts: Pick<DraftFacts, "classified" | "senders"> & Partial<Pick<DraftFacts, "settled" | "waiting">>, marks: readonly HandinMarkRow[]): HandinVersionLine[] {
  const markOf = new Map(marks.map((mark) => [mark.transactionId, mark]));
  return facts.classified.map((one) => {
    const mark = markOf.get(one.sale.transactionId);
    // A word the line no longer takes (the rule moved the sale) is set aside, not applied.
    const takes = (word: Statement) => (one.claimed === true ? word === "mine" : statementAllowed(one.group, word));
    const statement = mark?.statement != null && takes(mark.statement) ? mark.statement : null;
    const plain = lineAmount({
      group: one.group, netMills: one.sale.netMills, shareMills: one.shareMills, homeKind: one.sale.home.kind, homeReason: one.sale.home.reason,
      statement, alreadyIn: one.alreadyIn !== null, claimed: one.claimed === true, otherReport: one.otherReport === true,
    });
    // Settled: what it gives, for a line the person said something of or that counts either way. Another report of the
    // person holding it still counts it there, not here.
    const given = facts.settled?.get(one.sale.transactionId) ?? null;
    // A settlement settles the line whatever it counts now: the rule may have moved the sale off the person by it — a
    // sale the owner gave a colleague, or one a colleague wrote to themself (a take, an agreement: the home follows it),
    // is «Рядом» here — and what was handed in must take the settlement, not the card (N3) nor the candidate's own
    // amount (a take met while the report is checked would count for both), and a take undone later finds the line by
    // it (sale-claims.ts `takeToRuleWithin`).
    const settled = given !== null && one.alreadyIn === null ? given : null;
    // The person's own «моё» still open (`facts.waiting`): it waits, counting nothing, and says what it claims.
    const waits = settled === null && plain.amountMills > 0 && facts.waiting?.has(one.sale.transactionId) === true;
    if (waits) plain.claimedMills = plain.amountMills;
    const { amountMills, disputed } = settled !== null ? { amountMills: settled.amountMills, disputed: false } : waits ? { amountMills: 0, disputed: true } : plain;
    return {
      transactionId: one.sale.transactionId,
      offPlatformId: null,
      group: one.group,
      pageLabel: one.sale.pageLabel,
      kind: one.sale.kind,
      occurredAt: new Date(one.sale.occurredAt).toISOString(),
      netMills: one.sale.netMills,
      rule: {
        home: one.sale.home.kind,
        reason: one.sale.home.reason,
        shareMills: one.shareMills,
        toUserId: one.toUserId,
        senderUserId: facts.senders.get(one.sale.transactionId) ?? null,
        ...(one.sale.home.waitsUntil != null ? { waitsUntil: new Date(one.sale.home.waitsUntil).toISOString() } : {}),
      },
      statement,
      shareWithUserId: statement === "share" ? mark?.shareWithUserId ?? null : null,
      ...(statement === "give" ? { toUserId: mark?.toUserId ?? null } : {}),
      note: mark?.note ?? null,
      amountMills,
      added: one.added,
      disputed,
      alreadyIn: one.alreadyIn,
      ...(settled === null ? {} : { settled: settled.settled }),
      // A disputed «моё» counts nothing until settled and says what it claims (review R2b-2).
      ...(settled === null && plain.claimedMills !== undefined ? { claimedMills: plain.claimedMills } : {}),
    };
  });
}

/** A report's «мимо площадки» lines as a version keeps them: a confirmed one with the label of its page. */
export function offPlatformOfRows(rows: readonly OffPlatformRow[], labelOf: ReadonlyMap<number, string>): HandinVersionOffPlatform[] {
  return rows.map((row) => ({
    id: row.id, amountMills: row.amountMills, fromWhom: row.fromWhom, whatFor: row.whatFor, state: row.state,
    pageLabel: row.state === "confirmed" && row.pageId !== null ? labelOf.get(row.pageId) ?? null : null,
  }));
}

/**
 * The facts of one sale as a shift's draft reads them (`ShiftReportLineFacts`: the PPV's sender, the last writer, the
 * holders and whose slot ran, another report holding it): what the owner's dispute shows, read, not decided again.
 * Null — the sale is not a line of that shift's draft.
 */
export async function saleLineFacts(app: HandinApp, shiftId: number, transactionId: number, now: Date = new Date()): Promise<ShiftReportLineFacts | null> {
  const subject = await subjectOf(app.db, shiftId);
  const catalog = await pageCatalog(app.db);
  const handin = await findHandinByShift(app.db, subject.shift.id);
  const marks = handin === null ? [] : await listHandinMarks(app.db, handin.id);
  const facts = await draftFacts(app.db, subject, handin, catalog, now, marks);
  const one = facts.classified.find((line) => line.sale.transactionId === transactionId);
  if (one === undefined) return null;
  const details = await lineDetails(app.db, subject, { ...facts, classified: [one] }, catalog);
  return details.get(transactionId) ?? null;
}

/**
 * One sale's line as a shift's draft has it now: the facts and the person's own words — what a hand-in now would write
 * of it (an agreement of the two sides, else the rule with the person's word). A report whose line a cancelled decision
 * had settled goes back to it (sale-claims.ts). Null — the sale is no line of that draft, or the shift is no longer a
 * shift of its own (dropped, or joined to another). `db` — the caller's transaction or the pool; read in turn.
 */
export async function draftLineOfSale(db: Database, shiftId: number, transactionId: number, now: Date): Promise<HandinVersionLine | null> {
  const shift = await findHandinShift(db, shiftId);
  if (shift === null || shift.id !== shiftId || shift.state === "dropped") return null;
  const subject = await subjectOf(db, shiftId);
  const catalog = await pageCatalog(db);
  const handin = await findHandinByShift(db, shiftId);
  const marks = handin === null ? [] : await listHandinMarks(db, handin.id);
  const facts = await draftFacts(db, subject, handin, catalog, now, marks);
  return draftLines(facts, marks).find((line) => line.transactionId === transactionId) ?? null;
}

// ── Views ────────────────────────────────────────────────────────────────────

/** Whose a line is by the rule, in plain words from the person's side («PPV отправил Максим», «общак: чаевые под постом»). */
export function ruleWordsOfLine(line: HandinVersionLine, names: ReadonlyMap<number, string>): string {
  const toName = line.rule.toUserId === null ? null : names.get(line.rule.toUserId) ?? null;
  // The person's own line the rule gives them nothing of — their «не моё» keeps it theirs: the words say whose the sale is.
  const givenAway = line.group === "mine" && line.statement === "not_mine" && line.rule.shareMills === 0;
  return reasonWords({
    group: givenAway ? "near" : line.group,
    added: line.added,
    claimed: line.group === "mine" && line.added && line.statement === "mine",
    reason: line.rule.reason as SaleHomeReason,
    homeKind: line.rule.home as SaleHomeKind,
    toName,
    senderName: line.rule.senderUserId === null ? null : names.get(line.rule.senderUserId) ?? null,
    alreadyIn: line.alreadyIn,
  });
}

// Re-exported from `@agency_hub_core/db` so every reader (shift reports, sale homes, feed) shares the exact one helper.
export { versionReportDate };

/**
 * The pages a version's posts list — the one place it is decided, for the posts, their copy and the reminder to copy
 * them: the shift's own pages and those where something is counted. A page the version names only for a line of
 * «Рядом» that counts nothing (`reportSums`) is not an account of the person's post. Pure.
 */
export function postPagesOf(version: Pick<HandinVersionRow, "pages" | "lines">, subject: Pick<Subject, "shift">): HandinVersionRow["pages"] {
  const held = new Set(subject.shift.pages.filter((page) => page.salesFrom !== null).map((page) => page.pageLabel));
  const counted = new Set(version.lines.flatMap((line) => (line.pageLabel !== null && line.group === "mine" ? [line.pageLabel] : [])));
  return version.pages.filter((page) => page.amountMills !== 0 || held.has(page.pageLabel) || counted.has(page.pageLabel));
}

/**
 * A report's date, the one rule every reader follows (review R2b-1): once handed in, its newest version's — the shift's
 * date at that hand-in, which `shift_handins.report_date` follows; before that, the shift's own date now (the draft).
 */
export function reportDateOf(shift: { reportDate: string }, handin: { state: string; reportDate: string } | null): string {
  return handin !== null && handin.state === "submitted" ? handin.reportDate : shift.reportDate;
}

// ── Writes ───────────────────────────────────────────────────────────────────

export function writer(actor: HandinActor): { byUserId: number | null; byAgentKeyId: number | null; door: HandinDoor } {
  return actor.kind === "person"
    ? { byUserId: actor.userId, byAgentKeyId: null, door: actor.door }
    : { byUserId: null, byAgentKeyId: actor.agentKeyId, door: "telegram" };
}

export async function writableSubject(app: HandinApp, actor: HandinActor, shiftId: number): Promise<{ subject: Subject; catalog: PageCatalog }> {
  const subject = await subjectOf(app.db, shiftId);
  const catalog = await pageCatalog(app.db);
  const access = accessOf(actor, subject, catalog);
  if (access.access !== "own" && actor.kind === "person") throw new ForbiddenError("Only the person hands their shift in");
  requireWriter(actor, subject);
  return { subject, catalog };
}

export async function handinFor(db: Database, subject: Subject): Promise<HandinRow> {
  return ensureHandin(db, { shiftId: subject.shift.id, userId: subject.shift.userId, personId: subject.person?.personId ?? null, reportDate: subject.shift.reportDate });
}

/**
 * Whether the ledger paid the person's report date: a day with money accrued and not wholly unpaid. Null — not known
 * (the ledger is not connected, did not answer, or does not know the person).
 */
export async function ledgerDayPaid(app: HandinApp, input: { personCode: string | null; reportDate: string }): Promise<boolean | null> {
  if (input.personCode === null || app.config.ledgerPayoutsKey == null) return null;
  // The test team is never asked of the ledger (sandbox/realm.ts): «не известно».
  if ((await findPersonRowByCode(app.db, input.personCode))?.isTest === true) return null;
  try {
    const payouts = await readLedgerPayouts(app, { from: input.reportDate, to: input.reportDate });
    const person = payouts.people.find((one) => one.slug === input.personCode);
    if (person === undefined) return null;
    const accrued = person.days.filter((day) => day.date === input.reportDate).reduce((sum, day) => sum + day.amountMills, 0);
    if (accrued <= 0) return false;
    const unpaid = person.unpaidDays.filter((day) => day.date === input.reportDate).reduce((sum, day) => sum + day.unpaidMills, 0);
    return unpaid < accrued;
  } catch (error) {
    app.logger.warn({ reportDate: input.reportDate, err: error instanceof Error ? error.message : String(error) }, "shift report: the ledger did not say whether the day is paid");
    return null;
  }
}

export const SHIFT_REPORT_MISSING_KIND = "shift.report.missing";
export const SHIFT_REPORTS_MISSING_KIND = "shift.reports.missing";
export const SHIFT_REPORT_AFTER_PAID_KIND = "shift.report.after_paid";
