import type {
  AgentShiftReportsFeedResponse,
  AgentTeamSale,
  ShiftReportLineFacts,
  ShiftReportBody,
  ShiftReportClaimableResponse,
  ShiftReportDoor,
  ShiftReportLine,
  ShiftReportLineBody,
  ShiftReportOffPlatformBody,
  ShiftReportResponse,
  ShiftReportsListResponse,
  ShiftReportStatement,
} from "@agency_hub_core/contracts";
import {
  closeMatter,
  ensureHandin,
  findHandinByShift,
  findHandinPersonBy,
  findHandinPersonOfUser,
  findHandinShift,
  findLatestHandinShift,
  insertHandinEvent,
  insertHandinVersion,
  insertOffPlatform,
  listCurrentHandinVersions,
  listHandinAgentKeyNames,
  listHandinColleagues,
  listHandinLastWrites,
  listHandinOtherReports,
  listHandinRenewals,
  listHandinMarks,
  listHandinNames,
  listHandinPeopleOfUsers,
  listHandinSaleFans,
  listHandinSalesByIds,
  listHandinSalesOnPages,
  listHandinAccessiblePageIds,
  listHandinSaleKinds,
  listHandinShifts,
  listHandinsOfShifts,
  listHandinVersions,
  listHandinVersionsAfter,
  listMatterPageLabels,
  listOffPlatform,
  listPersonWorkingPageRows,
  listReportedSales,
  listSaleFacts,
  listSaleHomes,
  listVisiblePages,
  openMatter,
  setHandinComment,
  setHandinMark,
  withdrawOffPlatform,
  type Database,
  type HandinDoor,
  type HandinMarkRow,
  type HandinPerson,
  type HandinRow,
  type HandinSaleRow,
  type HandinShift,
  type HandinVersionLine,
  type HandinVersionRow,
  type OffPlatformRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import type { AgentAuthPrincipal, HumanAuthPrincipal } from "./auth.ts";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "./errors.ts";
import { readLedgerPayouts } from "./ledger-payouts.ts";
import { SALE_RULE, slotRuns, type RuleSlot, type SaleHomeKind, type SaleHomeReason } from "./sale-rule.ts";
import { computeSaleHomes, registrySlots, ruleWorksOf } from "./sale-homes.ts";
import {
  HANDIN_LOOKBACK_DAYS,
  claimedSale,
  classifySale,
  lineAmount,
  pageSums,
  postTexts,
  reasonWords,
  slotWindowOf,
  statementAllowed,
  type ClassifiedSale,
  type DraftSale,
  type DraftShare,
} from "./shift-handin-rules.ts";

/**
 * Отчёт смены (ecosystem plan 2026-11-12, package F): the one service behind
 * the three doors — Workboard and the extension by the person's own session or
 * device token, an agent key «со слов». Reads the shift row (0379), computes
 * its draft from the one rule (sale-rule.ts: live for the shift's window, the
 * hourly `sale_homes` for the days before it), applies the person's words, and
 * writes the report's draft edits and its immutable versions (0400). Database,
 * and the ledger's GET /v1/payouts at a hand-in (was the day paid?), nothing
 * else: nothing is sent to anyone.
 *
 * The switch is the person's (people registry right `submits_shift`): off, no
 * door writes, and the list the screens read is empty.
 */

type HandinApp = Pick<AppContext, "db" | "config" | "logger">;

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
const notFound = () => new NotFoundError("Not found");

interface Subject {
  shift: HandinShift;
  person: HandinPerson | null;
  /** Every login of the person (the shift's own at least). */
  userIds: number[];
  enabled: boolean;
}

async function subjectOf(db: Database, shiftId: number): Promise<Subject> {
  const shift = await findHandinShift(db, shiftId);
  if (shift === null || shift.state === "dropped") throw new NotFoundError("No such shift");
  const person = await findHandinPersonOfUser(db, shift.userId);
  const userIds = [...new Set([shift.userId, ...(person?.userIds ?? [])])];
  return { shift, person, userIds, enabled: person?.submitsShiftSince != null };
}

interface PageCatalog {
  idOf: Map<string, number>;
  labelOf: Map<number, string>;
  /** Active pages: platform and model. */
  info: Map<string, { platform: string; modelSlug: string; modelName: string }>;
}

async function pageCatalog(db: Database): Promise<PageCatalog> {
  const labels = await listMatterPageLabels(db);
  const visible = await listVisiblePages(db);
  return {
    idOf: labels.idOf,
    labelOf: labels.labelOf,
    info: new Map(visible.map((page) => [page.label, { platform: page.platform, modelSlug: page.modelSlug ?? page.label, modelName: page.modelName ?? page.label }])),
  };
}

const shiftPageLabels = (shift: HandinShift) => shift.pages.map((page) => page.pageLabel);

/** How the reader may see the subject: own, the owner's, a reader on shared pages (cut to them), or not at all. */
function accessOf(actor: HandinActor, subject: Subject, catalog: PageCatalog): { access: "own" | "read"; cutTo: Set<string> | null; draftPreview: boolean } {
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
function requireWriter(actor: HandinActor, subject: Subject): void {
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
interface DraftFacts {
  computedAt: Date;
  classified: ClassifiedSale[];
  /** The shift's pages that hold sales, in the shift's order. */
  pages: string[];
  /** The live facts of the window's sales (the answer the rule read), by transaction; the works by ref. */
  live: Map<number, AgentTeamSale>;
  works: Map<string, { userId: number; kind: string }>;
  /** A near sale's bought PPV sender, by transaction. */
  senders: Map<number, number>;
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
  const slot = slotWindowOf(slots, { userIds: new Set(subject.userIds), startedAt: shift.startedAt.getTime(), endedAt: shiftEnd });
  const pages = new Set(held);
  if (slot !== null) {
    // A slot of every page stands for the person's working pages.
    const working = slot.pageIds.includes(null) && subject.person !== null
      ? (await listPersonWorkingPageRows(db, [subject.person.personId])).map((row) => row.label)
      : [];
    for (const pageId of slot.pageIds) {
      const label = pageId === null ? undefined : catalog.labelOf.get(pageId);
      if (label !== undefined) pages.add(label);
    }
    for (const label of working) pages.add(label);
  }
  return {
    from: Math.min(shift.startedAt.getTime(), slot?.from ?? Number.POSITIVE_INFINITY),
    to: Math.max(shiftEnd, slot?.to ?? Number.NEGATIVE_INFINITY),
    pages,
  };
}

async function draftFacts(
  db: Database,
  subject: Subject,
  handin: HandinRow | null,
  catalog: PageCatalog,
  now: Date,
  marks: readonly HandinMarkRow[] = [],
): Promise<DraftFacts> {
  const { shift } = subject;
  const shiftEnd = shift.state === "going" ? Math.max(now.getTime(), shift.endedAt.getTime()) : shift.endedAt.getTime() + 1;
  // The same slots the hourly `sale_homes` job reads: the draft's homes are the rule's homes.
  const slotProvider = registrySlots(db);
  const slots = await slotProvider.slotsFor({ from: new Date(shift.startedAt.getTime() - 2 * DAY_MS), to: new Date(shiftEnd + DAY_MS) });
  const window = await reportWindowOf(db, subject, slots, catalog, shiftEnd);
  const from = new Date(window.from);
  const to = new Date(Math.max(window.to, shiftEnd));
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

  const sales: DraftSale[] = live.answer.sales.map((sale, index) => {
    const home = live.homes[index]!;
    const at = Date.parse(sale.occurredAt);
    return {
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
      },
      ppvSenderUserId: sale.ppvSender?.userId ?? null,
      source: "window",
      heldByShift: workRef !== null && sale.holders.includes(workRef),
      inReportWindow: window.pages.has(sale.pageLabel) && at >= window.from && at < window.to,
    };
  });

  // The days before the window: its next-shift PPVs and «долёт», as the hourly `sale_homes` keeps them.
  const before = (await listSaleHomes(db, { from: new Date(window.from - HANDIN_LOOKBACK_DAYS * DAY_MS), to: from }))
    .filter((row) => row.shares.some((share) => subject.userIds.includes(share.userId)));
  const kinds = await listHandinSaleKinds(db, before.map((row) => row.transactionId));
  for (const row of before) {
    const label = catalog.labelOf.get(row.pageId) ?? String(row.pageId);
    sales.push({
      transactionId: row.transactionId,
      pageLabel: label,
      platform: catalog.info.get(label)?.platform ?? "fansly",
      kind: kinds.get(row.transactionId) ?? "",
      occurredAt: row.occurredAt.getTime(),
      netMills: row.netMills,
      home: {
        kind: row.home as SaleHomeKind,
        reason: row.reason as SaleHomeReason,
        pot: row.pot,
        shares: row.shares.map((share) => ({ userId: share.userId, workRef: share.workRef, shiftId: share.shiftId, mills: share.mills })),
      },
      ppvSenderUserId: null,
      source: "before",
      heldByShift: false,
      inReportWindow: false,
    });
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
  const context = { shiftId: shift.id, workRef, userIds: new Set(subject.userIds), switchOnAt, submittedShiftIds, reported, handinId: handin?.id ?? null };

  const classified: ClassifiedSale[] = [];
  const seen = new Set<number>();
  for (const sale of sales) {
    if (seen.has(sale.transactionId)) continue;
    const one = classifySale(sale, context);
    if (one === null) continue;
    seen.add(sale.transactionId);
    classified.push(one);
  }

  // The sales the person added by hand: a «моё» on a sale no group of the draft holds.
  const claimedIds = marks.filter((mark) => mark.statement === "mine" && !seen.has(mark.transactionId)).map((mark) => mark.transactionId);
  const claimedRows = await listHandinSalesByIds(db, claimedIds);
  const others = await listHandinOtherReports(db, {
    transactionIds: [...claimedRows.map((row) => row.transactionId), ...classified.filter((one) => one.group === "near").map((one) => one.sale.transactionId)],
    exceptUserIds: subject.userIds,
  });
  for (const one of classified) if (one.group === "near") one.otherReport = others.has(one.sale.transactionId);
  for (const row of claimedRows) {
    classified.push(claimedSale(saleOfRow(row), context, others.has(row.transactionId)));
    seen.add(row.transactionId);
  }
  classified.sort((a, b) => (a.group === b.group ? a.sale.occurredAt - b.sale.occurredAt : a.group === "mine" ? -1 : 1));

  const senders = new Map(classified.flatMap((one) => (one.sale.ppvSenderUserId === null ? [] : [[one.sale.transactionId, one.sale.ppvSenderUserId] as const])));
  return {
    computedAt: now,
    classified,
    pages: shift.pages.filter((page) => page.salesFrom !== null).map((page) => page.pageLabel),
    live: new Map(live.answer.sales.map((sale) => [Number(sale.transactionRef), sale])),
    works: new Map(works.map((work) => [work.ref, { userId: work.userId, kind: work.kind }])),
    senders,
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
      : { kind: row.home.home as SaleHomeKind, reason: row.home.reason as SaleHomeReason, pot: row.home.pot, shares: row.home.shares },
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
async function lineDetails(db: Database, subject: Subject, facts: DraftFacts, catalog: PageCatalog): Promise<Map<number, ShiftReportLineFacts>> {
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

/** The person's words on the facts: the version's lines, as they would be handed in now. Pure. */
export function draftLines(facts: Pick<DraftFacts, "classified" | "senders">, marks: readonly HandinMarkRow[]): HandinVersionLine[] {
  const markOf = new Map(marks.map((mark) => [mark.transactionId, mark]));
  return facts.classified.map((one) => {
    const mark = markOf.get(one.sale.transactionId);
    // A word the line no longer takes (the rule moved the sale) is set aside, not applied.
    const takes = (word: ShiftReportStatement) => (one.claimed === true ? word === "mine" : statementAllowed(one.group, word));
    const statement = mark?.statement != null && takes(mark.statement) ? mark.statement : null;
    const { amountMills, disputed } = lineAmount({
      group: one.group, netMills: one.sale.netMills, shareMills: one.shareMills, homeKind: one.sale.home.kind, statement, alreadyIn: one.alreadyIn !== null,
      claimed: one.claimed === true, otherReport: one.otherReport === true,
    });
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
      },
      statement,
      shareWithUserId: statement === "share" ? mark?.shareWithUserId ?? null : null,
      note: mark?.note ?? null,
      amountMills,
      added: one.added,
      disputed,
      alreadyIn: one.alreadyIn,
    };
  });
}

/** The page sums of lines: the person's lines and the claimed ones. Pure. */
export function linesPageSums(lines: readonly HandinVersionLine[], shiftPages: readonly string[]) {
  return pageSums(lines.filter((line) => line.group === "mine" || line.amountMills !== 0), shiftPages);
}

// ── Views ────────────────────────────────────────────────────────────────────

interface ViewContext {
  /** The draft's facts of each line; empty for a version. */
  details: Map<number, ShiftReportLineFacts>;
  catalog: PageCatalog;
  names: Map<number, string>;
  fans: Map<number, { fanRef: string | null; name: string | null; username: string | null }>;
}

function wireLine(line: HandinVersionLine, context: ViewContext): ShiftReportLine | null {
  if (line.transactionId === null || line.pageLabel === null) return null;
  const toName = line.rule.toUserId === null ? null : context.names.get(line.rule.toUserId) ?? null;
  return {
    transactionId: line.transactionId,
    group: line.group,
    pageLabel: line.pageLabel,
    platform: context.catalog.info.get(line.pageLabel)?.platform ?? "fansly",
    kind: line.kind,
    occurredAt: line.occurredAt ?? new Date(0).toISOString(),
    netMills: line.netMills,
    fan: context.fans.get(line.transactionId) ?? { fanRef: null, name: null, username: null },
    rule: {
      home: line.rule.home,
      reason: line.rule.reason,
      words: reasonWords({
        group: line.group,
        added: line.added,
        claimed: line.group === "mine" && line.added && line.statement === "mine",
        reason: line.rule.reason as SaleHomeReason,
        homeKind: line.rule.home as SaleHomeKind,
        toName,
        senderName: line.rule.senderUserId === null ? null : context.names.get(line.rule.senderUserId) ?? null,
        alreadyIn: line.alreadyIn,
      }),
      toUserId: line.rule.toUserId,
      toName,
      shareMills: line.rule.shareMills,
    },
    statement: line.statement,
    shareWithUserId: line.shareWithUserId,
    shareWithName: line.shareWithUserId === null ? null : context.names.get(line.shareWithUserId) ?? null,
    note: line.note,
    amountMills: line.amountMills,
    added: line.added,
    disputed: line.disputed,
    alreadyIn: line.alreadyIn,
    facts: context.details.get(line.transactionId) ?? null,
  };
}

function offPlatformWire(row: Pick<OffPlatformRow, "id" | "amountMills" | "fromWhom" | "whatFor" | "state">) {
  return { id: row.id, amountMills: row.amountMills, fromWhom: row.fromWhom, whatFor: row.whatFor, state: row.state === "withdrawn" ? "rejected" as const : row.state };
}

function bodyOf(input: {
  source: "draft" | "version";
  version: HandinVersionRow | null;
  lines: readonly HandinVersionLine[];
  offPlatform: ReadonlyArray<Pick<OffPlatformRow, "id" | "amountMills" | "fromWhom" | "whatFor" | "state">>;
  comment: string;
  shiftPages: readonly string[];
  cutTo: Set<string> | null;
  computedAt: Date;
  context: ViewContext;
}): ShiftReportBody {
  const visible = input.cutTo === null ? input.lines : input.lines.filter((line) => line.pageLabel !== null && input.cutTo!.has(line.pageLabel));
  const pages = input.cutTo === null ? input.shiftPages : input.shiftPages.filter((page) => input.cutTo!.has(page));
  const sums = linesPageSums(visible, pages);
  return {
    source: input.source,
    version: input.version?.version ?? null,
    submittedAt: input.version?.submittedAt.toISOString() ?? null,
    door: input.version?.door ?? null,
    lines: visible.map((line) => wireLine(line, input.context)).filter((line): line is ShiftReportLine => line !== null),
    // A colleague reads the report's sales, not what the person says came past the platform.
    offPlatform: input.cutTo === null ? input.offPlatform.map(offPlatformWire) : [],
    comment: input.comment,
    pages: sums.pages.map((page) => ({ ...page, platform: input.context.catalog.info.get(page.pageLabel)?.platform ?? "fansly" })),
    totalMills: sums.totalMills,
    cut: input.cutTo !== null && pages.length < input.shiftPages.length,
    computedAt: input.computedAt.toISOString(),
  };
}

function versionSummary(version: HandinVersionRow, names: Map<number, string>, keyNames: Map<number, string>) {
  return {
    version: version.version,
    submittedAt: version.submittedAt.toISOString(),
    door: version.door,
    by: version.agentKeyId !== null
      ? `${keyNames.get(version.agentKeyId) ?? "агент"}, со слов`
      : names.get(version.actorUserId ?? -1) ?? "",
    totalMills: version.totalMills,
  };
}

/** The newest version as today's posts in «Отчётность». */
function postsOf(version: HandinVersionRow, subject: Subject, context: ViewContext): ShiftReportResponse["posts"] {
  const tag = subject.person?.reportTag ?? `#${subject.person?.code ?? context.names.get(subject.shift.userId) ?? "чаттер"}`;
  const texts = postTexts({
    reportDate: subject.shift.reportDate,
    tag,
    pages: version.pages.map((page) => {
      const info = context.catalog.info.get(page.pageLabel);
      return { pageLabel: page.pageLabel, platform: info?.platform ?? "fansly", modelSlug: info?.modelSlug ?? page.pageLabel, modelName: info?.modelName ?? page.pageLabel, amountMills: page.amountMills };
    }),
    lines: version.lines.flatMap((line) => (line.transactionId === null ? [] : [{
      pageLabel: line.pageLabel,
      platform: line.pageLabel === null ? "fansly" : context.catalog.info.get(line.pageLabel)?.platform ?? "fansly",
      kind: line.kind,
      amountMills: line.amountMills,
      fan: context.fans.get(line.transactionId) ?? { fanRef: null, name: null, username: null },
      note: line.note,
    }])),
    comment: version.comment,
    offPlatform: version.offPlatform.filter((line) => line.state === "pending" || line.state === "confirmed"),
  });
  return texts.map((post) => ({ modelName: post.modelName, text: post.text }));
}

// ── Reads ────────────────────────────────────────────────────────────────────

async function readSubject(app: HandinApp, actor: HandinActor, subject: Subject, now: Date): Promise<ShiftReportResponse> {
  const { db } = app;
  const catalog = await pageCatalog(db);
  const access = accessOf(actor, subject, catalog);
  const handin = await findHandinByShift(db, subject.shift.id);
  const versions = handin === null ? [] : await listHandinVersions(db, handin.id);
  const latest = versions.at(-1) ?? null;
  const own = access.access === "own";
  const shiftPages = subject.shift.pages.filter((page) => page.salesFrom !== null).map((page) => page.pageLabel);

  // The person's draft: their own reading, a team lead's and the owner's before anything is handed in.
  const wantsDraft = own || (latest === null && access.draftPreview);
  const marks = handin === null || !wantsDraft ? [] : await listHandinMarks(db, handin.id);
  const facts = wantsDraft ? await draftFacts(db, subject, handin, catalog, now, marks) : null;
  const draft = facts === null ? null : draftLines(facts, marks);
  const offPlatform = handin === null ? [] : await listOffPlatform(db, handin.id);

  const lineIds = [...(draft ?? []), ...(latest?.lines ?? [])].flatMap((line) => (line.transactionId === null ? [] : [line.transactionId]));
  const nameIds = [
    subject.shift.userId,
    ...[...(draft ?? []), ...(latest?.lines ?? [])].flatMap((line) => [line.rule.toUserId, line.rule.senderUserId, line.shareWithUserId]),
    ...versions.map((version) => version.actorUserId),
  ].filter((id): id is number => id !== null);
  const names = await listHandinNames(db, nameIds);
  const fans = await listHandinSaleFans(db, lineIds);
  const details = facts === null ? new Map<number, ShiftReportLineFacts>() : await lineDetails(db, subject, facts, catalog);
  const context: ViewContext = { details, catalog, names, fans };
  const keyNames = await listHandinAgentKeyNames(db, versions.flatMap((version) => (version.agentKeyId === null ? [] : [version.agentKeyId])));

  let view: ShiftReportBody | null = null;
  if (own || (latest === null && access.draftPreview)) {
    view = bodyOf({
      source: "draft", version: null, lines: draft ?? [], offPlatform, comment: handin?.comment ?? "", shiftPages,
      cutTo: access.cutTo, computedAt: now, context,
    });
  } else if (latest !== null) {
    view = bodyOf({
      source: "version", version: latest, lines: latest.lines, offPlatform: latest.offPlatform.map((line) => ({ ...line })),
      comment: latest.comment, shiftPages: latest.pages.map((page) => page.pageLabel), cutTo: access.cutTo, computedAt: latest.submittedAt, context,
    });
  }

  let afterSubmission: ShiftReportResponse["afterSubmission"] = null;
  if (own && latest !== null && draft !== null) {
    const held = new Set(latest.lines.flatMap((line) => (line.transactionId === null ? [] : [line.transactionId])));
    const fresh = draft.filter((line) => line.group === "mine" && line.amountMills > 0 && line.transactionId !== null && !held.has(line.transactionId));
    if (fresh.length > 0) afterSubmission = { count: fresh.length, mills: fresh.reduce((sum, line) => sum + line.amountMills, 0) };
  }

  const colleagues = own && subject.enabled
    ? await listHandinColleagues(db, {
      pageIds: shiftPages.map((label) => catalog.idOf.get(label)).filter((id): id is number => id !== undefined),
      exceptUserIds: subject.userIds,
    })
    : [];

  return {
    shift: {
      id: subject.shift.id,
      userId: subject.shift.userId,
      personName: subject.person?.displayName ?? names.get(subject.shift.userId) ?? "",
      ongoing: subject.shift.state === "going",
      startedAt: subject.shift.startedAt.toISOString(),
      endedAt: subject.shift.endedAt.toISOString(),
      workedMinutes: subject.shift.workedMinutes,
      reportDate: subject.shift.reportDate,
      pages: shiftPageLabels(subject.shift),
    },
    access: access.access,
    enabled: subject.enabled,
    canEdit: own && subject.enabled,
    state: handin?.state ?? "open",
    latest: latest === null ? null : versionSummary(latest, names, keyNames),
    versions: [...versions].reverse().map((version) => versionSummary(version, names, keyNames)),
    view,
    afterSubmission,
    posts: own && latest !== null ? postsOf(latest, subject, context) : [],
    colleagues,
    serverNow: now.toISOString(),
  };
}

/** `shiftReport`: a shift and its report as the reader may see it. */
export async function readShiftReport(app: HandinApp, actor: HandinActor, shiftId: number, now: Date = new Date()): Promise<ShiftReportResponse> {
  const subject = await subjectOf(app.db, shiftId);
  return readSubject(app, actor, subject, now);
}

/** The shift an agent means: by id, else the person's latest; the person by Telegram id or code. */
export async function agentSubject(
  app: HandinApp,
  query: { telegramUserId?: number | undefined; person?: string | undefined; shiftId?: number | undefined },
  now: Date = new Date(),
): Promise<Subject> {
  const named = query.telegramUserId !== undefined || query.person !== undefined
    ? await findHandinPersonBy(app.db, { ...(query.person !== undefined ? { code: query.person } : {}), ...(query.telegramUserId !== undefined ? { telegramUserId: query.telegramUserId } : {}) })
    : null;
  if ((query.telegramUserId !== undefined || query.person !== undefined) && named === null) throw notFound();
  let shiftId = query.shiftId ?? null;
  if (shiftId === null) {
    const latest = await findLatestHandinShift(app.db, { userIds: named?.userIds ?? [], before: now });
    if (latest === null) throw notFound();
    shiftId = latest.id;
  }
  const subject = await subjectOf(app.db, shiftId).catch(() => {
    throw notFound();
  });
  if (named !== null && !subject.userIds.some((id) => named.userIds.includes(id))) throw notFound();
  return subject;
}

/** `agentShiftReport`: the person's report as the person sees it, for an agent writing their words. */
export async function readAgentShiftReport(app: HandinApp, principal: AgentAuthPrincipal, pageIds: readonly number[], query: Parameters<typeof agentSubject>[1], now: Date = new Date()) {
  const subject = await agentSubject(app, query, now);
  // Reading needs no sender: the words are written later, each checked.
  const actor = handinAgentActorOf(principal, pageIds, { telegramUserId: subject.person?.telegramUserId ?? 0 });
  return readSubject(app, actor, subject, now);
}

/** How many open drafts `shiftReportsList` computes for their total. */
const LIST_DRAFTS_MAX = 7;

/** `shiftReportsList`: a person's shifts of a window with their report's state. */
export async function listShiftReports(
  app: HandinApp,
  actor: HandinPersonActor,
  query: { from: string; to: string; userId?: number | undefined },
  now: Date = new Date(),
): Promise<ShiftReportsListResponse> {
  const { db } = app;
  const fromAt = new Date(`${query.from}T00:00:00+03:00`);
  const toAt = new Date(Date.parse(`${query.to}T00:00:00+03:00`) + DAY_MS);
  if (!(toAt > fromAt) || toAt.getTime() - fromAt.getTime() > 62 * DAY_MS) throw new BadRequestError("from..to must be 1 to 62 Moscow days");
  const userId = query.userId ?? actor.userId;
  const person = (await listHandinPeopleOfUsers(db, [userId])).get(userId) ?? null;
  const userIds = [...new Set([userId, ...(person?.userIds ?? [])])];
  const own = userIds.includes(actor.userId);
  const enabled = person?.submitsShiftSince != null;
  if (own && !enabled) return { enabled: false, enabledSince: null, shifts: [], serverNow: now.toISOString() };

  const catalog = await pageCatalog(db);
  let cutTo: Set<string> | null = null;
  if (!own && actor.role !== "owner") {
    cutTo = new Set(actor.pageIds.map((id) => catalog.labelOf.get(id)).filter((label): label is string => label !== undefined));
  }
  const shifts = (await listHandinShifts(db, { userIds, from: fromAt, to: toAt }))
    .filter((shift) => cutTo === null || shift.pages.some((page) => cutTo!.has(page.pageLabel)));
  const handins = await listHandinsOfShifts(db, shifts.map((shift) => shift.id));
  const versions = await listCurrentHandinVersions(db, [...handins.values()].map((handin) => handin.id));
  // The person's own shifts not handed in yet: their draft's total, the one number «Мои смены» shows until the hand-in
  // (the newest few; an older one shows none rather than slow the screen).
  const drafts = new Map<number, number>();
  if (own && enabled) {
    const since = person!.submitsShiftSince!.getTime();
    const open = shifts
      .filter((shift) => shift.startedAt.getTime() >= since && handins.get(shift.id)?.state !== "submitted")
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, LIST_DRAFTS_MAX);
    for (const shift of open) {
      const subject: Subject = { shift, person, userIds, enabled };
      const handin = handins.get(shift.id) ?? null;
      const marks = handin === null ? [] : await listHandinMarks(db, handin.id);
      const facts = await draftFacts(db, subject, handin, catalog, now, marks);
      drafts.set(shift.id, linesPageSums(draftLines(facts, marks), facts.pages).totalMills);
    }
  }
  return {
    enabled,
    enabledSince: person?.submitsShiftSince?.toISOString() ?? null,
    shifts: shifts.map((shift) => {
      const handin = handins.get(shift.id) ?? null;
      const version = handin === null ? null : versions.get(handin.id) ?? null;
      const total = version === null ? null
        : cutTo === null ? version.totalMills
          : version.pages.filter((page) => cutTo!.has(page.pageLabel)).reduce((sum, page) => sum + page.amountMills, 0);
      return {
        draftTotalMills: drafts.get(shift.id) ?? null,
        shiftId: shift.id,
        startedAt: shift.startedAt.toISOString(),
        endedAt: shift.endedAt.toISOString(),
        ongoing: shift.state === "going",
        reportDate: shift.reportDate,
        pages: shiftPageLabels(shift),
        state: handin?.state ?? "open",
        version: version?.version ?? null,
        submittedAt: version?.submittedAt.toISOString() ?? null,
        totalMills: total,
      };
    }),
    serverNow: now.toISOString(),
  };
}

// ── Writes ───────────────────────────────────────────────────────────────────

function writer(actor: HandinActor): { byUserId: number | null; byAgentKeyId: number | null; door: HandinDoor } {
  return actor.kind === "person"
    ? { byUserId: actor.userId, byAgentKeyId: null, door: actor.door }
    : { byUserId: null, byAgentKeyId: actor.agentKeyId, door: "telegram" };
}

async function writableSubject(app: HandinApp, actor: HandinActor, shiftId: number): Promise<{ subject: Subject; catalog: PageCatalog }> {
  const subject = await subjectOf(app.db, shiftId);
  const catalog = await pageCatalog(app.db);
  const access = accessOf(actor, subject, catalog);
  if (access.access !== "own" && actor.kind === "person") throw new ForbiddenError("Only the person hands their shift in");
  requireWriter(actor, subject);
  return { subject, catalog };
}

async function handinFor(db: Database, subject: Subject): Promise<HandinRow> {
  return ensureHandin(db, { shiftId: subject.shift.id, userId: subject.shift.userId, personId: subject.person?.personId ?? null, reportDate: subject.shift.reportDate });
}

/** `shiftReportLineSet`: what the person says of a sale of the draft, and its note. */
export async function setShiftReportLine(
  app: HandinApp,
  actor: HandinActor,
  input: { shiftId: number; transactionId: number; body: ShiftReportLineBody },
  now: Date = new Date(),
): Promise<{ savedAt: string }> {
  const { subject, catalog } = await writableSubject(app, actor, input.shiftId);
  const statement: ShiftReportStatement | null = input.body.statement;
  const note = input.body.note === undefined || input.body.note === null || input.body.note.trim() === "" ? null : input.body.note.trim();
  const shareWith = statement === "share" ? input.body.shareWithUserId ?? null : null;
  if (statement === "share" && shareWith === null) throw new BadRequestError("«делим с…» names the colleague", { reason: "share_with_missing" });

  const existing = await findHandinByShift(app.db, subject.shift.id);
  const marks = existing === null ? [] : await listHandinMarks(app.db, existing.id);
  const before = marks.find((mark) => mark.transactionId === input.transactionId);
  if (statement !== null && (before?.statement ?? null) !== statement) {
    // A new word: the sale must be a line of the draft that takes it — or, «моё», a sale the person may add by hand.
    const facts = await draftFacts(app.db, subject, existing, catalog, now, marks);
    const line = facts.classified.find((one) => one.sale.transactionId === input.transactionId);
    if (line === undefined) {
      if (statement !== "mine") throw new NotFoundError("This sale is not in the shift's draft");
      const claimable = await claimableSales(app.db, subject, actor, existing, now);
      if (!claimable.some((row) => row.transactionId === input.transactionId)) {
        throw new NotFoundError("This sale cannot be added to this report", { reason: "not_claimable" });
      }
    } else if (line.claimed === true ? statement !== "mine" : !statementAllowed(line.group, statement)) {
      throw new BadRequestError("This line does not take that word", { reason: "statement_not_allowed" });
    }
    if (statement === "mine" && note === null) throw new BadRequestError("«Это моё» needs one line of why", { reason: "note_required" });
    if (shareWith !== null && line !== undefined) {
      const colleagues = await listHandinColleagues(app.db, {
        pageIds: [line.sale.pageLabel].map((label) => catalog.idOf.get(label)).filter((id): id is number => id !== undefined),
        exceptUserIds: subject.userIds,
      });
      if (!colleagues.some((one) => one.userId === shareWith)) throw new BadRequestError("Share with a colleague of the page", { reason: "share_with_unknown" });
    }
  } else if (statement === "mine" && note === null) {
    throw new BadRequestError("«Это моё» needs one line of why", { reason: "note_required" });
  }

  const who = writer(actor);
  await app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const handin = await handinFor(db, subject);
    await setHandinMark(db, {
      handinId: handin.id, transactionId: input.transactionId, statement, shareWithUserId: shareWith, note,
      byUserId: who.byUserId, byAgentKeyId: who.byAgentKeyId, at: now,
    });
  });
  return { savedAt: now.toISOString() };
}

/** How far back a sale may be added by hand. */
export const CLAIMABLE_DAYS = 7;
const CLAIMABLE_LIMIT = 1000;

/**
 * The sales the person may add to this report by hand: of the last 7 days, on the pages they may open (an agent: of
 * its grant too), in no report of theirs (the newest version of each).
 */
async function claimableSales(db: Database, subject: Subject, actor: HandinActor, handin: HandinRow | null, now: Date): Promise<HandinSaleRow[]> {
  let pageIds = await listHandinAccessiblePageIds(db, subject.userIds);
  if (actor.kind === "agent") {
    const granted = new Set(actor.pageIds);
    pageIds = pageIds.filter((id) => granted.has(id));
  }
  const rows = await listHandinSalesOnPages(db, { pageIds, from: new Date(now.getTime() - CLAIMABLE_DAYS * DAY_MS), to: now, limit: CLAIMABLE_LIMIT });
  const reported = await listReportedSales(db, { userIds: subject.userIds, since: new Date(now.getTime() - (CLAIMABLE_DAYS + 3) * DAY_MS).toISOString().slice(0, 10) });
  return rows.filter((row) => {
    const held = reported.get(row.transactionId);
    return held === undefined || held.handinId === handin?.id;
  });
}

/**
 * `shiftReportClaimable`: what «Добавить → продажу» offers — the person's own writer only — nobody's sales first,
 * then the rest, the newest first, each with whose it is by the rule in plain words.
 */
export async function readShiftReportClaimable(app: HandinApp, actor: HandinActor, shiftId: number, now: Date = new Date()): Promise<ShiftReportClaimableResponse> {
  const { subject } = await writableSubject(app, actor, shiftId);
  const handin = await findHandinByShift(app.db, subject.shift.id);
  const rows = await claimableSales(app.db, subject, actor, handin, now);
  const names = await listHandinNames(app.db, rows.flatMap((row) => row.home?.shares.map((share) => share.userId) ?? []));
  const sales = rows.map((row) => {
    const to = row.home?.shares.find((share) => !subject.userIds.includes(share.userId)) ?? null;
    const own = row.home?.shares.some((share) => subject.userIds.includes(share.userId)) ?? false;
    const homeKind = (row.home?.home ?? "unknown") as SaleHomeKind;
    const words = row.home === null ? "правило ещё не посчитало её"
      : own ? "по правилу ваша, в отчёт другой вашей смены"
        : reasonWords({ group: "near", added: false, reason: row.home.reason as SaleHomeReason, homeKind, toName: to === null ? null : names.get(to.userId) ?? null, senderName: null, alreadyIn: null });
    return {
      transactionId: row.transactionId,
      pageLabel: row.pageLabel,
      platform: row.platform,
      kind: row.kind,
      occurredAt: row.occurredAt.toISOString(),
      netMills: row.netMills,
      fan: row.fan,
      home: homeKind,
      words,
    };
  });
  sales.sort((a, b) => Number(b.home === "nobody") - Number(a.home === "nobody") || b.occurredAt.localeCompare(a.occurredAt));
  return { sales, serverNow: now.toISOString() };
}

/** `shiftReportCommentSet`: the draft's comment. */
export async function setShiftReportComment(app: HandinApp, actor: HandinActor, input: { shiftId: number; comment: string }, now: Date = new Date()) {
  const { subject } = await writableSubject(app, actor, input.shiftId);
  await app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const handin = await handinFor(db, subject);
    await setHandinComment(db, { handinId: handin.id, comment: input.comment, at: now });
  });
  return { savedAt: now.toISOString() };
}

/** `shiftReportOffPlatformAdd`: «мимо площадки», waiting for the owner. */
export async function addShiftReportOffPlatform(app: HandinApp, actor: HandinActor, input: { shiftId: number; body: ShiftReportOffPlatformBody }, now: Date = new Date()) {
  const { subject } = await writableSubject(app, actor, input.shiftId);
  const who = writer(actor);
  const row = await app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const handin = await handinFor(db, subject);
    const added = await insertOffPlatform(db, {
      handinId: handin.id, userId: subject.shift.userId, amountMills: input.body.amountMills, fromWhom: input.body.fromWhom.trim(),
      whatFor: input.body.whatFor.trim(), byUserId: who.byUserId, byAgentKeyId: who.byAgentKeyId, at: now,
    });
    await insertHandinEvent(db, {
      handinId: handin.id, event: "shift_report.off_platform_added", door: who.door, actorUserId: who.byUserId, agentKeyId: who.byAgentKeyId,
      onBehalfOfUserId: actor.kind === "agent" ? subject.shift.userId : null,
      changes: { offPlatformId: added.id, ...(actor.kind === "agent" && actor.sourceRef !== null ? { sourceRef: actor.sourceRef } : {}) }, at: now,
    });
    return added;
  });
  return { line: offPlatformWire(row), savedAt: now.toISOString() };
}

/** `shiftReportOffPlatformWithdraw`: the person takes back a line the owner has not decided. */
export async function withdrawShiftReportOffPlatform(app: HandinApp, actor: HandinActor, input: { shiftId: number; offPlatformId: number }, now: Date = new Date()) {
  const { subject } = await writableSubject(app, actor, input.shiftId);
  const handin = await findHandinByShift(app.db, subject.shift.id);
  if (handin === null || !(await withdrawOffPlatform(app.db, { handinId: handin.id, id: input.offPlatformId, at: now }))) {
    throw new NotFoundError("No such «мимо площадки» line waiting in this report");
  }
  return { savedAt: now.toISOString() };
}

/**
 * Whether the ledger paid the person's report date: a day with money accrued and not wholly unpaid. Null — not known
 * (the ledger is not connected, did not answer, or does not know the person).
 */
export async function ledgerDayPaid(app: HandinApp, input: { personCode: string | null; reportDate: string }): Promise<boolean | null> {
  if (input.personCode === null || app.config.ledgerPayoutsKey == null) return null;
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

/**
 * `shiftReportSubmit`: «Сдать смену». The draft is computed now, the person's words read under the report's lock,
 * and the next version written; the matter «Сдайте смену» closes. A version after the ledger paid the day is kept
 * and raises a matter for the owner.
 */
export async function submitShiftReport(
  app: HandinApp,
  actor: HandinActor,
  input: { shiftId: number },
  options: { now?: Date; dayPaid?: (input: { personCode: string | null; reportDate: string }) => Promise<boolean | null> } = {},
): Promise<ShiftReportResponse> {
  const now = options.now ?? new Date();
  const { subject, catalog } = await writableSubject(app, actor, input.shiftId);
  if (actor.kind === "agent" && actor.sourceRef === null) throw new BadRequestError("A report is handed in «со слов» only with the message", { reason: "source_ref_required" });
  const existing = await findHandinByShift(app.db, subject.shift.id);
  const facts = await draftFacts(app.db, subject, existing, catalog, now, existing === null ? [] : await listHandinMarks(app.db, existing.id));
  const dayPaid = await (options.dayPaid ?? ((one) => ledgerDayPaid(app, one)))({ personCode: subject.person?.code ?? null, reportDate: subject.shift.reportDate });
  const who = writer(actor);

  const version = await app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const handin = await handinFor(db, subject);
    const marks = await listHandinMarks(db, handin.id);
    const lines = draftLines(facts, marks);
    const sums = linesPageSums(lines, facts.pages);
    const offPlatform = (await listOffPlatform(db, handin.id)).map((row) => ({ id: row.id, amountMills: row.amountMills, fromWhom: row.fromWhom, whatFor: row.whatFor, state: row.state }));
    const made = await insertHandinVersion(db, {
      handin,
      door: who.door,
      actorUserId: who.byUserId,
      agentKeyId: who.byAgentKeyId,
      telegramMessageRef: actor.kind === "agent" ? actor.sourceRef : null,
      telegramSenderId: actor.kind === "agent" ? actor.telegramUserId : null,
      totalMills: sums.totalMills,
      pages: sums.pages,
      lines,
      offPlatform,
      comment: handin.comment,
      dayPaid,
      ruleVersion: SALE_RULE.version,
      at: now,
    });
    await insertHandinEvent(db, {
      handinId: handin.id, event: "shift_report.submitted", door: who.door, actorUserId: who.byUserId, agentKeyId: who.byAgentKeyId,
      onBehalfOfUserId: actor.kind === "agent" ? subject.shift.userId : null,
      changes: {
        version: made.version, lines: lines.length,
        ...(actor.kind === "agent" ? { sourceRef: actor.sourceRef, telegramUserId: actor.telegramUserId } : {}),
      },
      at: now,
    });
    return made;
  });

  const system = { door: "system" as const };
  await closeMatter(app.db, { key: `${SHIFT_REPORT_MISSING_KIND}:${subject.shift.id}`, how: "resolved", writer: "server" }, system, now).catch((error: unknown) => {
    app.logger.warn({ shiftId: subject.shift.id, err: error instanceof Error ? error.message : String(error) }, "shift report: the matter «Сдайте смену» did not close");
  });
  if (dayPaid === true) {
    const pageIds = facts.pages.map((label) => catalog.idOf.get(label)).filter((id): id is number => id !== undefined);
    await openMatter(app.db, {
      key: `${SHIFT_REPORT_AFTER_PAID_KIND}:${version.id}`,
      kind: SHIFT_REPORT_AFTER_PAID_KIND,
      source: "server",
      title: `Отчёт смены после выплаты: ${subject.person?.displayName ?? "чаттер"}, ${subject.shift.reportDate}, версия ${version.version}`,
      object: { type: "shift", id: String(subject.shift.id) },
      pageIds,
      owner: { role: "owner" },
      money: true,
      evidence: { shiftId: subject.shift.id, reportDate: subject.shift.reportDate, version: version.version, totalMills: version.totalMills },
      link: `/workboard/shifts/report/${subject.shift.id}`,
    }, system, now).catch((error: unknown) => {
      app.logger.warn({ shiftId: subject.shift.id, err: error instanceof Error ? error.message : String(error) }, "shift report: the owner's matter «после выплаты» did not open");
    });
  }
  return readSubject(app, actor, subject, now);
}

// ── The ledger's feed ────────────────────────────────────────────────────────

const FEED_SETTLE_SECONDS = 10;

/** `agentShiftReportsFeed`: every version after the cursor, in the order made. */
export async function readShiftReportsFeed(
  app: HandinApp,
  input: { pageIds: readonly number[]; since?: string | undefined; limit: number },
  now: Date = new Date(),
): Promise<AgentShiftReportsFeedResponse> {
  const afterId = input.since === undefined ? 0 : Number(input.since);
  const rows = await listHandinVersionsAfter(app.db, { afterId, limit: input.limit, settleSeconds: FEED_SETTLE_SECONDS, pageIds: input.pageIds });
  return {
    reports: rows.map((row) => ({
      id: row.id,
      person: row.personCode,
      hubUserId: row.userId,
      shiftId: row.shiftId,
      reportDate: row.reportDate,
      version: row.version,
      submittedAt: row.submittedAt.toISOString(),
      door: row.door as ShiftReportDoor,
      telegramMessageRef: row.telegramMessageRef,
      totalMills: row.totalMills,
      pages: row.pages,
      lines: row.lines.flatMap((line) => (line.transactionId === null || line.pageLabel === null ? [] : [{
        transactionId: line.transactionId,
        pageLabel: line.pageLabel,
        group: line.group,
        netMills: line.netMills,
        ruleShareMills: line.rule.shareMills,
        ruleHome: line.rule.home,
        ruleReason: line.rule.reason,
        statement: line.statement,
        shareWithUserId: line.shareWithUserId,
        note: line.note,
        amountMills: line.amountMills,
        added: line.added,
        disputed: line.disputed,
      }])),
      offPlatform: row.offPlatform.filter((line) => line.state !== "withdrawn").map((line) => offPlatformWire(line)),
      comment: row.comment,
      dayPaid: row.dayPaid,
      ruleVersion: row.ruleVersion,
    })),
    next: String(rows.at(-1)?.id ?? afterId),
    serverNow: now.toISOString(),
  };
}

