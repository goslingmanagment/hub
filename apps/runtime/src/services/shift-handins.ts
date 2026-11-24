import type {
  AgentShiftReportsFeedResponse,
  ShiftReportLineFacts,
  ShiftReportBody,
  ShiftReportClaimableResponse,
  ShiftReportDoor,
  ShiftReportLine,
  ShiftReportLineBody,
  ShiftReportOffPlatformBody,
  ShiftReportResponse,
  ShiftReportsListResponse,
} from "@agency_hub_core/contracts";
import {
  closeMatter,
  findHandinByShift,
  findHandinPersonBy,
  findHandinPersonOfUser,
  findHandinShift,
  findLatestHandinShift,
  insertHandinEvent,
  insertOffPlatform,
  insertSaleClaim,
  listCurrentHandinVersions,
  listHandinAgentKeyNames,
  listHandinColleagues,
  listHandinMarks,
  listHandinPostCopies,
  listHandinNames,
  listHandinPeopleOfUsers,
  listHandinSaleFans,
  listHandinSalesOnPages,
  listHandinAccessiblePageIds,
  listHandinShifts,
  listHandinsOfShifts,
  listHandinVersions,
  holdHandinFeedVersions,
  listHandinFeedHeld,
  listHandinVersionsAfter,
  placeHandinVersionsInFeed,
  releaseHandinFeedHeld,
  listOffPlatform,
  listOpenPotOffers,
  listReportedSales,
  listSaleClaims,
  updateSaleClaim,
  reopenSaleClaim,
  openMatter,
  setHandinComment,
  setHandinMark,
  withdrawOffPlatform,
  type Database,
  type HandinPerson,
  type HandinRow,
  type HandinSaleRow,
  type HandinShift,
  type HandinVersionLine,
  type HandinVersionMadeFor,
  type HandinVersionOffPlatform,
  type HandinVersionRow,
} from "@agency_hub_core/db";
import { userIsTest } from "./sandbox/realm.ts";

import type { AgentAuthPrincipal } from "./auth.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
import { ledgerGet } from "./ledger-payouts.ts";
import { parseLedgerReportDays } from "./ledger-reports.ts";
import { pagesWithLines, reportSums } from "./sale-claim-rules.ts";
import { claimsOfReport, runSaleClaims, settleAskedTakes } from "./sale-claims.ts";
import { checkReportNow, moveWhenDue, syncCheckMatters } from "./shift-handin-check.ts";
import { boardOn, phaseOf, readBoard } from "./shift-report-board-view.ts";
import { holdsSale, PhaseConflictError } from "./shift-report-phases.ts";
import type { SaleHomeKind, SaleHomeReason } from "./sale-rule.ts";
import {
  commentText,
  postTexts,
  reasonWords,
  statementAllowed,
  type Statement,
} from "./shift-handin-rules.ts";
import {
  accessOf,
  commentsOf,
  draftFacts,
  draftLines,
  handinAgentActorOf,
  handinFor,
  ledgerStatementOf,
  lineDetails,
  modelsOfPages,
  notFound,
  offPlatformOfRows,
  pageCatalog,
  pageModelOf,
  postPagesOf,
  reportDateOf,
  ruleWordsOfLine,
  shiftPageLabels,
  subjectOf,
  versionReportDate,
  writableSubject,
  writer,
  SHIFT_REPORT_AFTER_PAID_KIND,
  SHIFT_REPORT_MISSING_KIND,
  type HandinActor,
  type HandinApp,
  type HandinPersonActor,
  type PageCatalog,
  type Subject,
} from "./shift-report-draft.ts";

// The draft core's names the other services import from here (they live in shift-report-draft.ts).
export {
  draftLines,
  handinActorOf,
  handinAgentActorOf,
  modelsOfPages,
  pageCatalog,
  SHIFT_REPORT_MISSING_KIND,
  SHIFT_REPORTS_MISSING_KIND,
  type HandinPersonActor,
} from "./shift-report-draft.ts";

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

const DAY_MS = 86_400_000;

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
      words: ruleWordsOfLine(line, context.names),
      toUserId: line.rule.toUserId,
      toName,
      shareMills: line.rule.shareMills,
    },
    statement: ledgerStatementOf(line.statement),
    shareWithUserId: line.shareWithUserId,
    shareWithName: line.shareWithUserId === null ? null : context.names.get(line.shareWithUserId) ?? null,
    note: line.note,
    amountMills: line.amountMills,
    claimedMills: line.claimedMills ?? null,
    added: line.added,
    disputed: line.disputed,
    alreadyIn: line.alreadyIn,
    facts: context.details.get(line.transactionId) ?? null,
  };
}

function offPlatformWire(row: HandinVersionOffPlatform) {
  return {
    id: row.id, amountMills: row.amountMills, fromWhom: row.fromWhom, whatFor: row.whatFor,
    state: row.state === "withdrawn" ? "rejected" as const : row.state, pageLabel: row.pageLabel ?? null,
  };
}

/**
 * What a reader may see of a report (a draft or a version): the lines and pages of their pages, «мимо площадки» only
 * uncut, and the sums made of exactly that. The one projection of rights the body, its totals, the versions' history
 * and the list of shifts read (review R2-c). `cutTo` null — the whole report.
 */
function projectionOf(input: {
  lines: readonly HandinVersionLine[];
  offPlatform: readonly HandinVersionOffPlatform[];
  shiftPages: readonly string[];
  cutTo: Set<string> | null;
}) {
  const cut = input.cutTo;
  const lines = cut === null ? input.lines : input.lines.filter((line) => line.pageLabel !== null && cut.has(line.pageLabel));
  const pages = cut === null ? input.shiftPages : input.shiftPages.filter((page) => cut.has(page));
  // A colleague reads the report's sales, not what the person says came past the platform: nor its sums.
  const offPlatform = cut === null ? input.offPlatform : [];
  return { lines, pages, offPlatform, sums: reportSums(lines, pages, offPlatform), cut: cut !== null && pages.length < input.shiftPages.length };
}

/**
 * A handed-in report (a version, or a candidate the board checks) as the reader may see it: whole — its stored total and
 * pages; cut — its projection's (`projectionOf`). The total `shiftReportsList` and the version history show, and every
 * report of «Смены → Отчёты» (team-shift-reports.ts).
 */
export function reportSeenBy(report: Pick<HandinVersionRow, "totalMills" | "pages" | "lines" | "offPlatform">, cutTo: Set<string> | null) {
  if (cutTo === null) return { totalMills: report.totalMills, pages: report.pages.map((page) => ({ pageLabel: page.pageLabel, amountMills: page.amountMills })), lines: report.lines, cut: false };
  const seen = projectionOf({ lines: report.lines, offPlatform: report.offPlatform, shiftPages: report.pages.map((page) => page.pageLabel), cutTo });
  return { totalMills: seen.sums.totalMills, pages: seen.sums.pages, lines: seen.lines, cut: seen.cut };
}

/** A version's total as the reader may see it: the stored one whole, else its projection's. */
function versionTotalFor(version: HandinVersionRow, cutTo: Set<string> | null): number {
  return reportSeenBy(version, cutTo).totalMills;
}

function bodyOf(input: {
  source: "draft" | "version";
  version: HandinVersionRow | null;
  subject: Pick<Subject, "shift">;
  lines: readonly HandinVersionLine[];
  offPlatform: readonly HandinVersionOffPlatform[];
  comment: string;
  modelComments: Readonly<Record<string, string>>;
  shiftPages: readonly string[];
  cutTo: Set<string> | null;
  computedAt: Date;
  context: ViewContext;
}): ShiftReportBody {
  const seen = projectionOf(input);
  // The models of the posts the report makes (a draft's as a hand-in now would make them), cut to the reader's pages.
  const whole = input.version ?? { pages: reportSums(input.lines, input.shiftPages, input.offPlatform).pages, lines: [...input.lines] };
  const comments = commentsOf({ ...whole, comment: input.comment, modelComments: input.modelComments }, input.subject, input.context.catalog, input.cutTo);
  return {
    source: input.source,
    version: input.version?.version ?? null,
    submittedAt: input.version?.submittedAt.toISOString() ?? null,
    door: input.version?.door ?? null,
    lines: seen.lines.map((line) => wireLine(line, input.context)).filter((line): line is ShiftReportLine => line !== null),
    offPlatform: seen.offPlatform.map(offPlatformWire),
    comment: input.comment,
    comments,
    pages: seen.sums.pages.map((page) => ({ ...page, platform: input.context.catalog.info.get(page.pageLabel)?.platform ?? "fansly" })),
    totalMills: seen.sums.totalMills,
    cut: seen.cut,
    computedAt: input.computedAt.toISOString(),
  };
}

/** Why the system made a version, in plain words: «согласие: Алекс», «решение владельца: пополам». */
export function madeForWords(madeFor: HandinVersionMadeFor | null, actorName: string | null): string | null {
  if (madeFor === null) return null;
  if (madeFor.kind === "off_platform") return madeFor.decision === "confirmed" ? "владелец подтвердил «мимо площадки»" : "владелец отклонил «мимо площадки»";
  if (madeFor.kind === "decision" && madeFor.decisionId === null) {
    return madeFor.outcome === "merged" ? "смена объединена с другой" : madeFor.outcome === "moved" ? "отчёт перенесён в объединённую смену" : "смена отменена";
  }
  if (madeFor.kind === "decision") return madeFor.outcome === "cancelled" ? "решение о продаже отменено" : "решение о продаже, записанное со слов";
  switch (madeFor.outcome) {
    case "agreed": return `согласие${actorName ? `: ${actorName}` : " второй стороны"}`;
    case "taken": return `записано по слову${actorName ? `: ${actorName}` : " коллеги"}`;
    case "first":
    case "second": return "решение владельца по спору о продаже";
    case "half": return "решение владельца: пополам";
    case "nobody": return "решение владельца: никому";
    case "pot": return "решение владельца: в общак";
    case "rule": return "решение: по правилу";
    case "withdrawn": return "запись продажи отменена: по правилу";
    case "disputed": return "спор о продаже: до решения по правилу";
    default: return null;
  }
}

/**
 * A version in the history, as the reader may see it (the body's projection, review R2-c): a cut reader gets the total
 * of their pages, and why the system made it only when it is a sale of theirs (never «мимо площадки»).
 */
function versionSummary(version: HandinVersionRow, names: Map<number, string>, keyNames: Map<number, string>, cutTo: Set<string> | null) {
  const actor = version.agentKeyId !== null
    ? `${keyNames.get(version.agentKeyId) ?? "агент"}, со слов`
    : names.get(version.actorUserId ?? -1) ?? "";
  const why = version.madeFor;
  const madeFor = cutTo === null || why === null ? why
    : why.kind !== "off_platform" && version.lines.some((line) => line.transactionId === why.transactionId && line.pageLabel !== null && cutTo.has(line.pageLabel))
      ? why
      : null;
  return {
    version: version.version,
    submittedAt: version.submittedAt.toISOString(),
    door: version.door,
    by: actor,
    totalMills: versionTotalFor(version, cutTo),
    madeFor: madeForWords(madeFor, version.agentKeyId !== null ? null : names.get(version.actorUserId ?? -1) ?? null),
  };
}

/** The newest version as today's posts in «Отчётность». */
function postsOf(version: HandinVersionRow, subject: Subject, handin: HandinRow, context: ViewContext): ShiftReportResponse["posts"] {
  return modelPostsOf(version, subject, handin, context).map((post) => ({ modelSlug: post.modelSlug, modelName: post.modelName, text: post.text }));
}

/** The version's posts, one per model, with the model's slug (the copy to «Отчётность» goes by it). */
export function modelPostsOf(version: HandinVersionRow, subject: Pick<Subject, "shift" | "person">, handin: Pick<HandinRow, "reportDate">, context: Pick<ViewContext, "catalog" | "names" | "fans">) {
  const tag = subject.person?.reportTag ?? `#${subject.person?.code ?? context.names.get(subject.shift.userId) ?? "чаттер"}`;
  return postTexts({
    reportDate: versionReportDate(version, handin),
    tag,
    pages: postPagesOf(version, subject).map((page) => {
      const info = context.catalog.info.get(page.pageLabel);
      return { pageLabel: page.pageLabel, platform: info?.platform ?? "fansly", ...pageModelOf(context.catalog, page.pageLabel), amountMills: page.amountMills };
    }),
    lines: version.lines.flatMap((line) => (line.transactionId === null ? [] : [{
      pageLabel: line.pageLabel,
      platform: line.pageLabel === null ? "fansly" : context.catalog.info.get(line.pageLabel)?.platform ?? "fansly",
      kind: line.kind,
      amountMills: line.amountMills,
      claimedMills: line.claimedMills ?? null,
      fan: context.fans.get(line.transactionId) ?? { fanRef: null, name: null, username: null },
      note: line.note,
    }])),
    comment: version.comment,
    modelComments: version.modelComments,
    offPlatform: version.offPlatform.filter((line) => line.state === "pending" || line.state === "confirmed"),
    // «Отчёт № N» last, as the board's post has it. No «не в смене» lines: a page the shift did not hold is never among the
    // post's accounts (review 12.11 round 2, (8)).
    number: version.version,
  });
}

/**
 * The posts of a handed-in version as «Скопировать пост» gives them, one per model with its slug: the text the
 * server's copy to «Отчётность» sends (people-messages, package S). Null — the shift or the version is gone.
 */
export async function readHandinVersionPosts(
  app: Pick<HandinApp, "db">,
  input: { shiftId: number; version: number },
): Promise<{ reportDate: string; startedAt: Date; endedAt: Date; posts: Array<{ modelSlug: string; modelName: string; text: string }> } | null> {
  const { db } = app;
  const shift = await findHandinShift(db, input.shiftId);
  if (shift === null || shift.state === "dropped") return null;
  const handin = await findHandinByShift(db, shift.id);
  const version = handin === null ? undefined : (await listHandinVersions(db, handin.id)).find((one) => one.version === input.version);
  if (handin === null || version === undefined) return null;
  const person = await findHandinPersonOfUser(db, shift.userId);
  const catalog = await pageCatalog(db);
  const names = await listHandinNames(db, [shift.userId]);
  const fans = await listHandinSaleFans(db, version.lines.flatMap((line) => (line.transactionId === null ? [] : [line.transactionId])));
  return {
    reportDate: versionReportDate(version, handin), startedAt: shift.startedAt, endedAt: shift.endedAt,
    posts: modelPostsOf(version, { shift, person }, handin, { catalog, names, fans }),
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** What is due on a report by now, done before it is read; a failure is logged and the pass does it later. */
async function dueNow(app: HandinApp, input: { handin: HandinRow; subject: Subject; catalog: PageCatalog }, now: Date): Promise<void> {
  const { handin, subject, catalog } = input;
  const logged = (what: string) => (error: unknown) => {
    app.logger.warn({ shiftId: subject.shift.id, err: error instanceof Error ? error.message : String(error) }, `shift report: ${what} on read failed; the pass will`);
    return false;
  };
  if (phaseOf(handin) === "checking") {
    await checkReportNow(app, { handinId: handin.id, shiftId: subject.shift.id, catalog }, now).catch(logged("Hub's check"));
    await moveWhenDue(app.db, { shiftId: subject.shift.id }, now).catch(logged("the move to «Подтвердите»"));
  }
  await settleAskedTakes(app, { handinId: handin.id, userIds: subject.userIds }, now).catch(logged("a take still asked"));
}

export async function readSubject(app: HandinApp, actor: HandinActor, subject: Subject, now: Date, options: { withPost?: boolean } = {}): Promise<ShiftReportResponse> {
  const { db } = app;
  const catalog = await pageCatalog(db);
  const access = accessOf(actor, subject, catalog);
  // What is due by now happens before the board is drawn (the pass is only the backstop): Hub's check of a report in
  // «Проверка», its move to «Подтвердите» when Gengar's 10 minutes are up, a take on its sales still asked.
  const found = await findHandinByShift(db, subject.shift.id);
  if (found !== null) await dueNow(app, { handin: found, subject, catalog }, now);
  const handin = found === null ? null : await findHandinByShift(db, subject.shift.id);
  const versions = handin === null ? [] : await listHandinVersions(db, handin.id);
  const latest = versions.at(-1) ?? null;
  const own = access.access === "own";
  const shiftPages = subject.shift.pages.filter((page) => page.salesFrom !== null).map((page) => page.pageLabel);

  // The person's draft: their own reading, a team lead's and the owner's before anything is handed in.
  const wantsDraft = own || (latest === null && access.draftPreview);
  const marks = handin === null || !wantsDraft ? [] : await listHandinMarks(db, handin.id);
  const facts = wantsDraft ? await draftFacts(db, subject, handin, catalog, now, marks) : null;
  const draft = facts === null ? null : draftLines(facts, marks);
  const offPlatform = handin === null ? [] : offPlatformOfRows(await listOffPlatform(db, handin.id), catalog.labelOf);

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
  const posts = own && latest !== null && handin !== null ? postsOf(latest, subject, handin, context) : [];

  let view: ShiftReportBody | null = null;
  if (own || (latest === null && access.draftPreview)) {
    view = bodyOf({
      source: "draft", version: null, subject, lines: draft ?? [], offPlatform, comment: handin?.comment ?? "", modelComments: handin?.modelComments ?? {},
      shiftPages, cutTo: access.cutTo, computedAt: now, context,
    });
  } else if (latest !== null) {
    view = bodyOf({
      source: "version", version: latest, subject, lines: latest.lines, offPlatform: latest.offPlatform.map((line) => ({ ...line })),
      comment: latest.comment, modelComments: latest.modelComments, shiftPages: latest.pages.map((page) => page.pageLabel), cutTo: access.cutTo,
      computedAt: latest.submittedAt, context,
    });
  }

  let afterSubmission: ShiftReportResponse["afterSubmission"] = null;
  if (own && latest !== null && draft !== null) {
    // Held as the board holds it (`holdsSale`): a $0 line with nothing on it holds nothing.
    const held = new Set(latest.lines.filter(holdsSale).flatMap((line) => (line.transactionId === null ? [] : [line.transactionId])));
    const fresh = draft.filter((line) => line.group === "mine" && line.amountMills > 0 && line.transactionId !== null && !held.has(line.transactionId));
    if (fresh.length > 0) afterSubmission = { count: fresh.length, mills: fresh.reduce((sum, line) => sum + line.amountMills, 0) };
  }

  const colleagues = own && subject.enabled
    ? await listHandinColleagues(db, {
      pageIds: shiftPages.map((label) => catalog.idOf.get(label)).filter((id): id is number => id !== undefined),
      exceptUserIds: subject.userIds,
    })
    : [];

  // The claims of the report's sales (package G): someone's claim of the person's sale, the person's own, answered here.
  const claims = await claimsOfReport(db, {
    shiftId: subject.shift.id,
    handinId: handin?.id ?? null,
    userIds: subject.userIds,
    lineIds: [...new Set(lineIds)],
    own,
    readerUserId: actor.kind === "person" ? actor.userId : subject.shift.userId,
    cutToPageIds: access.cutTo === null ? null : new Set([...access.cutTo].map((label) => catalog.idOf.get(label)).filter((id): id is number => id !== undefined)),
  });

  return {
    shift: {
      id: subject.shift.id,
      userId: subject.shift.userId,
      personName: subject.person?.displayName ?? names.get(subject.shift.userId) ?? "",
      ongoing: subject.shift.state === "going",
      startedAt: subject.shift.startedAt.toISOString(),
      endedAt: subject.shift.endedAt.toISOString(),
      workedMinutes: subject.shift.workedMinutes,
      reportDate: reportDateOf(subject.shift, handin),
      pages: shiftPageLabels(subject.shift),
    },
    access: access.access,
    enabled: subject.enabled,
    canEdit: own && subject.enabled,
    state: handin?.state ?? "open",
    latest: latest === null ? null : versionSummary(latest, names, keyNames, access.cutTo),
    versions: [...versions].reverse().map((version) => versionSummary(version, names, keyNames, access.cutTo)),
    view,
    afterSubmission,
    posts,
    colleagues,
    claims,
    boardShift: boardOn(subject),
    board: await readBoard({
      db, subject, catalog, cutTo: access.cutTo, draftPreview: access.draftPreview, handin, versions, draft, now,
      posts: posts.map((post) => ({ modelSlug: post.modelSlug, modelName: post.modelName })),
      postCopies: handin === null ? [] : await listHandinPostCopies(db, handin.id),
      // Asked only once the post was copied: before that there is nothing for the ledger to have seen.
      postSeen: options.withPost === true && own && latest !== null && handin?.postCopiedAt != null ? await postSeenOf(app, subject, versionReportDate(latest, handin)) : null,
      actor: { access: access.access, kind: actor.kind, enabled: subject.enabled },
    }),
    serverNow: now.toISOString(),
  };
}

/** `shiftReport`: a shift and its report as the reader may see it (the board's own read asks whether the ledger has seen the post). */
export async function readShiftReport(app: HandinApp, actor: HandinActor, shiftId: number, now: Date = new Date()): Promise<ShiftReportResponse> {
  const subject = await subjectOf(app.db, shiftId);
  return readSubject(app, actor, subject, now, { withPost: true });
}

/**
 * Whether the ledger has seen the post of the person's report day: its report days (`/v1/report-days`, the read «Мои
 * смены» makes) list a post of that day. Null — not known (the ledger away, not connected, or another person's rows).
 */
async function postSeenOf(app: HandinApp, subject: Subject, reportDate: string): Promise<boolean | null> {
  // The test team is never asked of the ledger (sandbox/realm.ts): «не известно».
  if (await userIsTest(app, subject.shift.userId)) return null;
  try {
    const body = await ledgerGet(app, "/v1/report-days", { from: reportDate, to: reportDate, hub_user_id: String(subject.shift.userId) }, { client: "shift-report-board" });
    const days = parseLedgerReportDays(app, body).filter((day) => day.report_date === reportDate && (subject.person === null || day.person === subject.person.code));
    return days.some((day) => day.posted_at !== null || day.post_id !== null);
  } catch {
    return null;
  }
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

/**
 * The person's OWN shifts not handed in yet, begun since their switch: each one's draft total now, the one number «Мои
 * смены» shows until the hand-in («предварительно») — the newest few; an older one shows none rather than slow the
 * screen. Only ever for the reader's own shifts (`shiftReportsList`, «Смены → Отчёты»): a draft is its person's.
 */
export async function ownDraftTotals(
  db: Database,
  input: { person: HandinPerson; userIds: number[]; shifts: readonly HandinShift[]; handins: ReadonlyMap<number, HandinRow>; catalog: PageCatalog; now: Date },
): Promise<Map<number, number>> {
  const drafts = new Map<number, number>();
  const { person, userIds, handins, catalog, now } = input;
  if (person.submitsShiftSince === null) return drafts;
  const since = person.submitsShiftSince.getTime();
  const open = input.shifts
    .filter((shift) => shift.startedAt.getTime() >= since && handins.get(shift.id)?.state !== "submitted")
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
    .slice(0, LIST_DRAFTS_MAX);
  for (const shift of open) {
    const subject: Subject = { shift, person, userIds, enabled: true };
    const handin = handins.get(shift.id) ?? null;
    const marks = handin === null ? [] : await listHandinMarks(db, handin.id);
    const facts = await draftFacts(db, subject, handin, catalog, now, marks);
    const offPlatform = handin === null ? [] : offPlatformOfRows(await listOffPlatform(db, handin.id), catalog.labelOf);
    drafts.set(shift.id, reportSums(draftLines(facts, marks), facts.pages, offPlatform).totalMills);
  }
  return drafts;
}

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
  const drafts = own && enabled ? await ownDraftTotals(db, { person: person!, userIds, shifts, handins, catalog, now }) : new Map<number, number>();
  return {
    enabled,
    enabledSince: person?.submitsShiftSince?.toISOString() ?? null,
    shifts: shifts.map((shift) => {
      const handin = handins.get(shift.id) ?? null;
      const version = handin === null ? null : versions.get(handin.id) ?? null;
      const total = version === null ? null : versionTotalFor(version, cutTo);
      // The board's phase, read as the board reads it (shift-report-board-view.ts): «Мои смены» names the next step by it.
      const phase = boardOn({ person, shift }) ? phaseOf(handin) : null;
      return {
        phase,
        postCopied: own && phase === "counted" ? handin?.postCopiedAt != null : null,
        draftTotalMills: drafts.get(shift.id) ?? null,
        shiftId: shift.id,
        startedAt: shift.startedAt.toISOString(),
        endedAt: shift.endedAt.toISOString(),
        ongoing: shift.state === "going",
        reportDate: reportDateOf(shift, handin),
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

/** `shiftReportLineSet`: what the person says of a sale of the draft, and its note. */
export async function setShiftReportLine(
  app: HandinApp,
  actor: HandinActor,
  input: { shiftId: number; transactionId: number; body: ShiftReportLineBody },
  now: Date = new Date(),
): Promise<{ savedAt: string }> {
  const { subject, catalog } = await writableSubject(app, actor, input.shiftId);
  const existing = await findHandinByShift(app.db, subject.shift.id);
  const marks = existing === null ? [] : await listHandinMarks(app.db, existing.id);
  const before = marks.find((mark) => mark.transactionId === input.transactionId);
  // No word in the body: the comment alone, the word as it stands (written as stored: an old-way gift stays «не моё»
  // with its question). No comment in the body: the comment as it stands. A write never carries back what it did not say.
  const keepWord = input.body.statement === undefined;
  const statement: Statement | null = keepWord ? before?.statement ?? null : input.body.statement ?? null;
  // «Олега» on one's own sale (the board, package R): given to a colleague of the sale's page, settled at once in theirs.
  const giveTo = statement === "give" ? (keepWord ? before?.toUserId : input.body.toUserId) ?? null : null;
  if (statement === "give" && giveTo === null) throw new BadRequestError("«Отдать» names the colleague", { reason: "give_to_missing" });
  const note = input.body.note === undefined ? before?.note ?? null
    : input.body.note === null || input.body.note.trim() === "" ? null : input.body.note.trim();
  const shareWith = statement === "share" ? (keepWord ? before?.shareWithUserId : input.body.shareWithUserId) ?? null : null;
  if (statement === "share" && shareWith === null) throw new BadRequestError("«делим с…» names the colleague", { reason: "share_with_missing" });

  // The word changes when its kind or its colleague does («пополам с Олегом» → «пополам с Тимуром» is a new word).
  const wordChanged = (before?.statement ?? null) !== statement || (before?.shareWithUserId ?? null) !== shareWith || (before?.toUserId ?? null) !== giveTo;
  // The person's own word on this sale already settled between the two (a take that stands, an agreement): its terms
  // made the reports' versions and the sale's home, so the line is their own now and «моя» is no word of it (the draft
  // sets it aside; the board sends none). No word here keeps theirs and writes the comment, in any phase; another word
  // would say one thing while the settlement counts another — «Отменить» first, else only the decider.
  if (wordChanged && existing !== null && before?.statement != null
    && (await listSaleClaims(app.db, { transactionIds: [input.transactionId], states: ["agreed"], kinds: ["claim"] })).some((claim) => claim.claimantHandinId === existing.id)) {
    if (statement !== null) throw new ConflictError("This sale is already settled: only the decider changes it now", { reason: "claim_settled" });
    const who = writer(actor);
    await setHandinMark(app.db, {
      handinId: existing.id, transactionId: input.transactionId, statement: before.statement, shareWithUserId: before.shareWithUserId, toUserId: before.toUserId ?? null,
      note, byUserId: who.byUserId, byAgentKeyId: who.byAgentKeyId, at: now,
    });
    return { savedAt: now.toISOString() };
  }
  // On the board, ticks and «чья» change only while it is edited (draft, «Правка»); a sale's comment any time.
  const phase = phaseOf(existing);
  if (boardOn(subject) && wordChanged && phase !== "draft" && phase !== "fixing") throw new PhaseConflictError(subject.shift.id, phase);
  // «Пополам» or «отдать» with a colleague who hands shifts in the old way (no board): the decider decides — a Telegram
  // post knows decisions, not agreements (arena round 3) — and no day of silence runs.
  let oldWayTo: { userId: number; pageId: number | null } | null = null;
  if (statement !== null && wordChanged) {
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
    // Given to the pot by its holder: the owner decides it; nobody takes it meanwhile.
    if (statement === "mine" && (await listOpenPotOffers(app.db)).some((one) => one.transactionId === input.transactionId && !subject.userIds.includes(one.userId))) {
      throw new ConflictError("This sale waits for the owner's word on the pot", { reason: "pot_offer_open" });
    }
    if ((shareWith !== null || giveTo !== null) && line !== undefined) {
      const colleagues = await listHandinColleagues(app.db, {
        pageIds: [line.sale.pageLabel].map((label) => catalog.idOf.get(label)).filter((id): id is number => id !== undefined),
        exceptUserIds: subject.userIds,
      });
      if (shareWith !== null && !colleagues.some((one) => one.userId === shareWith)) throw new BadRequestError("Share with a colleague of the page", { reason: "share_with_unknown" });
      if (giveTo !== null && !colleagues.some((one) => one.userId === giveTo)) throw new BadRequestError("Give to a colleague of the page", { reason: "give_to_unknown" });
      const colleague = shareWith ?? giveTo!;
      const theirs = await findHandinPersonOfUser(app.db, colleague);
      if (boardOn(subject) && line.group === "mine" && theirs?.submitsShiftSince == null) oldWayTo = { userId: colleague, pageId: catalog.idOf.get(line.sale.pageLabel) ?? null };
    }
  } else if (statement === "mine" && note === null) {
    throw new BadRequestError("«Это моё» needs one line of why", { reason: "note_required" });
  }

  const who = writer(actor);
  await app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const handin = await handinFor(db, subject);
    // Given to a colleague without the board: the person's share goes now (their «не моё»), the colleague's waits for the
    // decider; «пополам» keeps the person's half and the other half waits.
    const written = oldWayTo !== null && statement === "give" ? "not_mine" as const : statement;
    await setHandinMark(db, {
      handinId: handin.id, transactionId: input.transactionId, statement: written, shareWithUserId: shareWith, toUserId: written === "give" ? giveTo : null, note,
      byUserId: who.byUserId, byAgentKeyId: who.byAgentKeyId, at: now,
    });
    if (wordChanged) {
      // A new word takes back a question asked from the draft about this sale.
      for (const claim of (await listSaleClaims(db, { transactionIds: [input.transactionId], states: ["asked", "owner"] }))) {
        // Not a disagreement with Gengar's card: that one is the decider's, whatever the word (review round 2).
        if (claim.claimantHandinId === handin.id && claim.origin === "draft" && !(claim.escalatedWhy === "disagree" && claim.answer === null)) {
          await updateSaleClaim(db, claim.id, { state: "withdrawn", closedAt: now }, now, { ifState: claim.state });
        }
      }
    }
    if (oldWayTo !== null) {
      const fields = {
        pageId: oldWayTo.pageId, kind: "claim" as const, claimantVersion: null, statement: statement === "share" ? "share" as const : null,
        shareWithUserId: statement === "share" ? oldWayTo.userId : null, claimantNote: note, claimedAt: now, sideShiftId: null,
        state: "owner" as const, escalatedAt: now, escalatedWhy: "no_side" as const,
      };
      const known = (await listSaleClaims(db, { transactionIds: [input.transactionId] }))
        .find((claim) => claim.claimantHandinId === handin.id && claim.sideUserId === oldWayTo!.userId);
      if (known === undefined) {
        await insertSaleClaim(db, { ...fields, transactionId: input.transactionId, claimantUserId: subject.shift.userId, claimantHandinId: handin.id, sideUserId: oldWayTo.userId, origin: "draft" }, now);
      } else if (known.state === "withdrawn") {
        await reopenSaleClaim(db, known.id, fields, now);
      }
    }
  });
  if (oldWayTo !== null) await runSaleClaims(app, now).catch(() => undefined);
  // «Общак» said or taken back: the owner's matter opens or closes now, not at the next pass.
  if (statement === "pot" || before?.statement === "pot") {
    await syncCheckMatters(app, now).catch((error: unknown) => {
      app.logger.warn({ shiftId: subject.shift.id, err: error instanceof Error ? error.message : String(error) }, "shift report: the pot's matter did not follow the word; the next pass will");
    });
  }
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
  // A sale someone gave to the pot waits for the owner: never «ничья → Это моё» meanwhile.
  const potOffers = new Set((await listOpenPotOffers(app.db)).map((one) => one.transactionId));
  const sales = rows.map((row) => {
    if (potOffers.has(row.transactionId)) {
      return {
        transactionId: row.transactionId, pageLabel: row.pageLabel, platform: row.platform, kind: row.kind, occurredAt: row.occurredAt.toISOString(),
        netMills: row.netMills, fan: row.fan, home: "pot", words: "общак, решает владелец",
      };
    }
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

/**
 * `shiftReportCommentSet`: the draft's comment. With a model: that model's own (0432), for its post and the next shift
 * on its pages; the model must be one of the report's. Without: the one comment of every post.
 */
export async function setShiftReportComment(
  app: HandinApp,
  actor: HandinActor,
  input: { shiftId: number; comment: string; modelSlug?: string | undefined },
  now: Date = new Date(),
) {
  const { subject, catalog } = await writableSubject(app, actor, input.shiftId);
  const modelSlug = input.modelSlug ?? null;
  if (modelSlug !== null && !(await isReportModel(app.db, { subject, catalog, modelSlug }, now))) {
    throw new BadRequestError("This model is not one of the report's pages", { reason: "model_not_in_report" });
  }
  await app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const handin = await handinFor(db, subject);
    await setHandinComment(db, { handinId: handin.id, comment: input.comment, modelSlug, at: now });
  });
  return { savedAt: now.toISOString() };
}

/**
 * Whether a model is one of the report's: of the shift's pages or its counted version's, else of the posts the draft
 * would make now (the models its `comments` offer: a page of a «долёт» too).
 */
async function isReportModel(db: Database, input: { subject: Subject; catalog: PageCatalog; modelSlug: string }, now: Date): Promise<boolean> {
  const { subject, catalog, modelSlug } = input;
  const ofPages = (labels: readonly string[]) => labels.some((label) => pageModelOf(catalog, label).modelSlug === modelSlug);
  if (ofPages(shiftPageLabels(subject.shift))) return true;
  const handin = await findHandinByShift(db, subject.shift.id);
  if (handin === null) return false;
  const latest = (await listCurrentHandinVersions(db, [handin.id])).get(handin.id);
  if (latest !== undefined && ofPages(latest.pages.map((page) => page.pageLabel))) return true;
  const marks = await listHandinMarks(db, handin.id);
  const facts = await draftFacts(db, subject, handin, catalog, now, marks);
  const lines = draftLines(facts, marks);
  const offPlatform = offPlatformOfRows(await listOffPlatform(db, handin.id), catalog.labelOf);
  const draft = { pages: reportSums(lines, facts.pages, offPlatform).pages, lines, comment: handin.comment, modelComments: handin.modelComments };
  return commentsOf(draft, subject, catalog, null).some((one) => one.modelSlug === modelSlug);
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
 * After a version the person made («Подтверждаю», «Досдать»): «Сдайте смену» closes, a version after the ledger paid the
 * day raises the owner's matter, and a statement that touches another person reaches them now.
 */
export async function afterPersonVersion(
  app: HandinApp,
  input: { subject: Subject; catalog: PageCatalog; version: { id: number; version: number; totalMills: number }; pages: readonly string[]; paidDay: string; dayPaid: boolean | null },
  now: Date,
): Promise<void> {
  const { subject, catalog, version } = input;
  const system = { door: "system" as const };
  await closeMatter(app.db, { key: `${SHIFT_REPORT_MISSING_KIND}:${subject.shift.id}`, how: "resolved", writer: "server" }, system, now).catch((error: unknown) => {
    app.logger.warn({ shiftId: subject.shift.id, err: error instanceof Error ? error.message : String(error) }, "shift report: the matter «Сдайте смену» did not close");
  });
  if (input.dayPaid === true) {
    const pageIds = input.pages.map((label) => catalog.idOf.get(label)).filter((id): id is number => id !== undefined);
    await openMatter(app.db, {
      key: `${SHIFT_REPORT_AFTER_PAID_KIND}:${version.id}`,
      kind: SHIFT_REPORT_AFTER_PAID_KIND,
      source: "server",
      title: `Отчёт смены после выплаты: ${subject.person?.displayName ?? "чаттер"}, ${input.paidDay}, версия ${version.version}`,
      object: { type: "shift", id: String(subject.shift.id) },
      pageIds,
      owner: { role: "owner" },
      money: true,
      evidence: { shiftId: subject.shift.id, reportDate: input.paidDay, version: version.version, totalMills: version.totalMills },
      link: `/workboard/report/${subject.shift.id}`,
    }, system, now).catch((error: unknown) => {
      app.logger.warn({ shiftId: subject.shift.id, err: error instanceof Error ? error.message : String(error) }, "shift report: the owner's matter «после выплаты» did not open");
    });
  }
  await runSaleClaims(app, now).catch((error: unknown) => {
    app.logger.warn({ shiftId: subject.shift.id, err: error instanceof Error ? error.message : String(error) }, "shift report: the claims pass after a version failed; the next one will");
  });
}

/**
 * A version's line as the ledger's feed serves it: the format never changes (R-board §8) — the board's «отдал» and «в
 * общак» read as «не моё» (`ledgerStatementOf`), an off-platform line is not a line here. Pure.
 */
export function feedLineOf(line: HandinVersionLine): AgentShiftReportsFeedResponse["reports"][number]["lines"] {
  if (line.transactionId === null || line.pageLabel === null) return [];
  return [{
    transactionId: line.transactionId,
    pageLabel: line.pageLabel,
    group: line.group,
    netMills: line.netMills,
    ruleShareMills: line.rule.shareMills,
    ruleHome: line.rule.home,
    ruleReason: line.rule.reason,
    statement: ledgerStatementOf(line.statement),
    shareWithUserId: line.shareWithUserId,
    note: line.note,
    amountMills: line.amountMills,
    claimedMills: line.claimedMills ?? null,
    added: line.added,
    disputed: line.disputed,
    settled: line.settled ?? null,
  }];
}

// ── The ledger's feed ────────────────────────────────────────────────────────

/**
 * `agentShiftReportsFeed`: every version after the cursor, in the feed's order. The versions committed since the last
 * read are placed first (0405, `placeHandinVersionsInFeed`): a version is placed only once committed, after every place
 * given before, so a version whose transaction commits after a later one's is served after it — the cursor (`next`, a
 * place) never passes a version not served yet, however the hand-ins interleave (review R2-b). A place moves only to
 * the end (a held version released for its key): a reader keeps versions by id, and a report's newest is its highest
 * `version`.
 */
export async function readShiftReportsFeed(
  app: HandinApp,
  input: { pageIds: readonly number[]; since?: string | undefined; limit: number; agentKeyId?: number | undefined; realm?: "live" | "test" },
  now: Date = new Date(),
): Promise<AgentShiftReportsFeedResponse> {
  const afterSeq = input.since === undefined ? 0 : Number(input.since);
  // Held back for the key's pages (review R2b-4): kept per key and listed on its every read until it may read them.
  // Then the version gets a new place at the end of the feed and leaves the list, before this read: the cursor serves
  // it like any other, so an answer that is lost is asked again and brings it again.
  if (input.agentKeyId !== undefined) await releaseHandinFeedHeld(app.db, { agentKeyId: input.agentKeyId, pageIds: input.pageIds });
  await placeHandinVersionsInFeed(app.db);
  const read = await listHandinVersionsAfter(app.db, { afterSeq, limit: input.limit, pageIds: input.pageIds, realm: input.realm ?? "live" });
  let held = read.held;
  if (input.agentKeyId !== undefined) {
    await holdHandinFeedVersions(app.db, { agentKeyId: input.agentKeyId, versionIds: read.held.map((one) => one.id) });
    held = await listHandinFeedHeld(app.db, { agentKeyId: input.agentKeyId, pageIds: input.pageIds });
  }
  // The feed keeps one comment (0432): the models' own as one text, by the models of the version's pages.
  const catalog = read.served.some((row) => Object.keys(row.modelComments).length > 0) ? await pageCatalog(app.db) : null;
  const feedComment = (row: (typeof read.served)[number]) => (catalog === null ? row.comment
    : commentText(row, modelsOfPages(catalog, row.pages.map((page) => page.pageLabel)), { line: (name, text) => `«${name}»: ${text}`, separator: "\n" }));
  return {
    reports: read.served.map((row) => ({
      id: row.id,
      seq: row.seq,
      person: row.personCode,
      hubUserId: row.userId,
      shiftId: row.shiftId,
      reportDate: row.reportDate,
      version: row.version,
      submittedAt: row.submittedAt.toISOString(),
      door: row.door as ShiftReportDoor,
      telegramMessageRef: row.telegramMessageRef,
      totalMills: row.totalMills,
      // Every line's page is a page of the version: one stored before `reportSums` named them all gets them here, at 0.
      pages: pagesWithLines(row.pages.map((page) => page.pageLabel), row.lines)
        .map((pageLabel) => row.pages.find((page) => page.pageLabel === pageLabel) ?? { pageLabel, amountMills: 0 }),
      lines: row.lines.flatMap(feedLineOf),
      offPlatform: row.offPlatform.filter((line) => line.state !== "withdrawn").map((line) => offPlatformWire(line)),
      comment: feedComment(row),
      dayPaid: row.dayPaid,
      ruleVersion: row.ruleVersion,
      madeFor: row.madeFor === null ? null : {
        kind: row.madeFor.kind,
        claimId: row.madeFor.kind === "claim" ? row.madeFor.claimId : null,
        decisionId: row.madeFor.kind === "decision" ? row.madeFor.decisionId : null,
        offPlatformId: row.madeFor.kind === "off_platform" ? row.madeFor.offPlatformId : null,
        transactionId: row.madeFor.kind === "claim" || row.madeFor.kind === "decision" ? row.madeFor.transactionId : null,
        outcome: row.madeFor.kind === "off_platform" ? row.madeFor.decision : row.madeFor.outcome,
        byUserId: row.actorUserId,
      },
    })),
    held: held.map((one) => ({ ...one, reason: "page_outside_key" as const })),
    next: String(read.last ?? afterSeq),
    // `limit` counts places, held ones too: a page may carry fewer reports than asked, none even, while places follow.
    more: read.more,
    serverNow: now.toISOString(),
  };
}

