import { createHash } from "node:crypto";

import type { ClientSaleSightingsBody } from "@agency_hub_core/contracts";
import {
  bumpPagePolls,
  closeMatter,
  findHandinById,
  countLateSales,
  findHandinByShift,
  findHandinPersonOfUser,
  insertHandinCandidate,
  insertObservation,
  listHandinCandidates,
  listHandinMarks,
  listHandinNames,
  listCandidatesUnderCheck,
  listHandinsOfGoneShifts,
  listHandinsPostCopiedBehind,
  listHandinVersions,
  listKnownPlatformRefs,
  listMatterPageLabels,
  listOpenMattersOfKinds,
  listOpenPotOffers,
  listSightingsHubNowHolds,
  listSightingsUnmatchedSince,
  listStatementPasses,
  listTransactionChecks,
  listWalletRescans,
  lockSaleSettlements,
  moveHandinToShift,
  openMatter,
  setCandidateHubCheck,
  setHandinLateSales,
  setHandinPhase,
  setSaleSightingMatched,
  supersedeOpenCandidates,
  upsertSaleSighting,
  insertHandinVersion,
  type CandidateHubPage,
  type CandidateRow,
  type Database,
  type HandinVersionLine,
  type MatterActor,
} from "@agency_hub_core/db";
import { SHIFT_REPORT_CHECK_MINUTES } from "@agency_hub_core/contracts";
import { formatUsdFromMills } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import type { HumanAuthPrincipal } from "./auth.ts";
import { ForbiddenError, NotFoundError } from "./errors.ts";
import { clientCaptureProducer } from "./ingest-observations.ts";
import { SALE_RULE } from "./sale-rule.ts";
import { disputeDecider, phaseOf, postPagesDiffer } from "./shift-report-board-view.ts";
import { draftFacts, draftLines, linesPageSums, pageCatalog, subjectOf, type PageCatalog, type Subject } from "./shift-handins.ts";

/**
 * «Hub сверяет суммы» and «Нет в Hub» (products plan 2026-11-13, package R §5, brief R1b): Hub's own check of every page
 * of a handed-in shift, the sightings of sales the site showed and Hub does not hold, and the board's other minute
 * work (the pot's offers, the «после сдачи» mark, a shift cancelled or merged, a post copied before a change).
 *
 * The check asks nothing of a platform itself. Fansly: «Sync now» on the page's wallet (`bumpPagePolls`, the file
 * `transactions`) — the page's actor reads it at its own pace, through its own egress; «сошлись» needs a CERTIFIED window
 * read (`transactions.rescan`'s receipt) that began after the cutoff — the head walk stops at the first known row and
 * proves no coverage. OnlyFans: ChatSpace's statement as the extension's feed reports it — a ledger pass read back to
 * Hub's newest row after the cutoff, and every row of the page's window confirmed by the statement. Then every row of the
 * window is compared (a sale the candidate lacks, a net or a state that changed): nothing → `matched`; something →
 * `found` and the candidate is re-made with it while it waits. Coverage not proven → `running` / `statement`, and after
 * 10 minutes `unchecked` (the person may confirm; the check goes on, and what it finds later becomes «после сдачи»). A
 * page Hub cannot ask (no engine row, no ChatSpace feed) is `unchecked` at once: never «сошлись» without the proof.
 */

type CheckApp = Pick<AppContext, "db" | "logger">;
const SYSTEM: MatterActor = { door: "system" };
const DAY_MS = 86_400_000;
const CHECK_MS = SHIFT_REPORT_CHECK_MINUTES * 60_000;
/** How long the check keeps looking at a page after the hand-in. */
const CHECK_KEEPS_MS = 2 * DAY_MS;
/** A sighting not in Hub this long is the decider's. */
export const SIGHTING_UNMATCHED_MS = 48 * 3_600_000;
export const SIGHTING_UNMATCHED_KIND = "shift.report.sighting_unmatched";
export const POT_OFFER_KIND = "sale.pot_offer";
export const POST_CHANGED_KIND = "shift.report.post_changed";
export const SHIFT_CANCELLED_KIND = "shift.report.shift_cancelled";
export const SALE_SIGHTINGS_OBSERVATION_KIND = "client.sale_sightings.v1";

// ── The page's state, pure ───────────────────────────────────────────────────

export interface PageCheckInput {
  /** Hub can ask for the page's read (an engine row for Fansly, a statement pass known for OnlyFans). */
  askable: boolean;
  /** A read that proves the window was covered, made after the cutoff. */
  covered: boolean;
  /** Sales of the window the candidate lacks, and rows whose net or state changed. */
  missing: { count: number; mills: number };
  changed: number;
  platform: "fansly" | "onlyfans";
  /** Since the hand-in. */
  waitedMs: number;
}

/** A page's state from what Hub knows now. Pure (tests/shift-handin-check.test.ts). */
export function pageCheckState(input: PageCheckInput): CandidateHubPage["state"] {
  if (!input.askable) return "unchecked";
  if (input.covered) return input.missing.count > 0 || input.changed > 0 ? "found" : "matched";
  if (input.waitedMs >= CHECK_MS) return "unchecked";
  return input.platform === "onlyfans" ? "statement" : "running";
}

/** A page's answer is final once its coverage was proven (`at` set); an unchecked page without proof is looked at again. */
const finalPage = (page: CandidateHubPage) => page.at !== null && (page.state === "matched" || page.state === "found");

/** What the check compares on a page: sales of the window the candidate lacks, and lines whose net or state changed. Pure. */
export function compareWindow(input: {
  candidate: readonly HandinVersionLine[];
  draft: readonly HandinVersionLine[];
  now: ReadonlyMap<number, { netMills: number; state: string }>;
  pageLabel: string;
}): { missing: { count: number; mills: number; ids: number[] }; changed: number } {
  const held = new Set(input.candidate.flatMap((line) => (line.transactionId === null ? [] : [line.transactionId])));
  const missing = input.draft.filter((line) => line.pageLabel === input.pageLabel && line.transactionId !== null && !held.has(line.transactionId)
    && line.group === "mine" && line.amountMills > 0);
  const changed = input.candidate.filter((line) => {
    if (line.pageLabel !== input.pageLabel || line.transactionId === null) return false;
    const fact = input.now.get(line.transactionId);
    return fact === undefined || fact.netMills !== line.netMills || fact.state === "unknown";
  }).length;
  return { missing: { count: missing.length, mills: missing.reduce((sum, line) => sum + line.amountMills, 0), ids: missing.map((line) => line.transactionId!) }, changed };
}

// ── The check ────────────────────────────────────────────────────────────────

/**
 * At a hand-in: each page's first state, and the wallet reads asked of the sync (after the candidate is written). A page
 * Hub cannot ask is `unchecked` from the start.
 */
export async function startHubCheck(db: Database, input: { subject: Subject; catalog: PageCatalog }): Promise<{ pages: CandidateHubPage[]; ask: () => Promise<void> }> {
  const labels = input.subject.shift.pages.map((page) => page.pageLabel);
  const ids = new Map(labels.flatMap((label) => {
    const id = input.catalog.idOf.get(label);
    return id === undefined ? [] : [[label, id] as const];
  }));
  const rescans = await listWalletRescans(db, [...ids.values()]);
  const passes = await listStatementPasses(db, [...ids.values()]);
  const pages: CandidateHubPage[] = labels.map((label) => {
    const id = ids.get(label);
    const platform = input.catalog.info.get(label)?.platform;
    const askable = id !== undefined && (platform === "onlyfans" ? passes.has(id) : rescans.has(id));
    return { pageLabel: label, state: askable ? (platform === "onlyfans" ? "statement" : "running") : "unchecked", foundCount: 0, foundMills: 0, at: null };
  });
  const fansly = labels.flatMap((label) => (input.catalog.info.get(label)?.platform === "fansly" && rescans.has(ids.get(label) ?? -1) ? [ids.get(label)!] : []));
  return {
    pages,
    // «Sync now» on the wallet: the page's actor reads it under its own pace; nothing is sent from here.
    ask: async () => {
      for (const pageId of fansly) await bumpPagePolls(db, { pageId, files: ["transactions"] });
    },
  };
}

/** The check's minute work: every candidate still checked, its pages looked at again; a page that found more re-makes it. */
export async function runHubChecks(app: CheckApp, now: Date): Promise<number> {
  const { db } = app;
  const catalog = await pageCatalog(db);
  let touched = 0;
  for (const row of await listCandidatesUnderCheck(db, new Date(now.getTime() - CHECK_KEEPS_MS))) {
    const changed = await checkCandidate(app, { ...row, catalog }, now)
      .catch((error: unknown) => {
        app.logger.warn({ candidateId: row.candidateId, err: error instanceof Error ? error.message : String(error) }, "hub check: a candidate was not checked; the next pass will");
        return false;
      });
    if (changed) touched += 1;
  }
  return touched;
}

async function checkCandidate(app: CheckApp, input: { candidateId: number; handinId: number; shiftId: number; catalog: PageCatalog }, now: Date): Promise<boolean> {
  const { db } = app;
  const candidate = (await listHandinCandidates(db, input.handinId)).find((one) => one.id === input.candidateId);
  if (candidate === undefined || candidate.supersededAt !== null) return false;
  const subject = await subjectOf(db, input.shiftId).catch(() => null);
  if (subject === null) return false;
  const pages = candidate.hubCheck.length > 0 ? candidate.hubCheck : (await startHubCheck(db, { subject, catalog: input.catalog })).pages;
  const open = pages.filter((page) => !finalPage(page));
  if (open.length === 0) {
    await setCandidateHubCheck(db, { candidateId: candidate.id, pages, done: true, at: now });
    return true;
  }
  const ids = new Map(pages.flatMap((page) => {
    const id = input.catalog.idOf.get(page.pageLabel);
    return id === undefined ? [] : [[page.pageLabel, id] as const];
  }));
  const rescans = await listWalletRescans(db, [...ids.values()]);
  const passes = await listStatementPasses(db, [...ids.values()]);
  const facts = await listTransactionChecks(db, candidate.lines.flatMap((line) => (line.transactionId === null ? [] : [line.transactionId])));
  const handin = await findHandinByShift(db, subject.shift.id);
  const marks = handin === null ? [] : await listHandinMarks(db, handin.id);
  const draft = draftLines(await draftFacts(db, subject, handin, input.catalog, candidate.cutoffAt, marks), marks);
  const waitedMs = now.getTime() - candidate.madeAt.getTime();
  let found = false;
  const next = pages.map((page): CandidateHubPage => {
    if (finalPage(page)) return page;
    const id = ids.get(page.pageLabel);
    const platform = input.catalog.info.get(page.pageLabel)?.platform === "onlyfans" ? "onlyfans" as const : "fansly" as const;
    const rescan = id === undefined ? undefined : rescans.get(id);
    const pass = id === undefined ? undefined : passes.get(id);
    const lines = candidate.lines.filter((line) => line.pageLabel === page.pageLabel && line.transactionId !== null);
    const covered = platform === "fansly"
      ? rescan !== undefined && rescan.walkStartedAt !== null && rescan.walkStartedAt.getTime() >= candidate.cutoffAt.getTime()
      : pass !== undefined && pass.getTime() >= candidate.cutoffAt.getTime() && lines.every((line) => facts.get(line.transactionId!)?.statementSeen === true);
    const compared = compareWindow({ candidate: candidate.lines, draft, now: facts, pageLabel: page.pageLabel });
    const state = pageCheckState({
      askable: platform === "onlyfans" ? pass !== undefined : rescan !== undefined, covered, missing: compared.missing, changed: compared.changed, platform, waitedMs,
    });
    if (state === "found") found = true;
    return { pageLabel: page.pageLabel, state, foundCount: compared.missing.count + compared.changed, foundMills: compared.missing.mills, at: covered ? now.toISOString() : null };
  });
  const done = next.every(finalPage);
  await setCandidateHubCheck(db, { candidateId: candidate.id, pages: next, done, at: now });
  if (found && handin !== null && (phaseOf(handin) === "checking" || phaseOf(handin) === "confirm")) {
    // The re-read found more, or a sum or a state changed: the candidate is re-made from the draft at the same cutoff,
    // the person sees it before confirming (and confirms again).
    const remade = await remakeAt(db, { subject, catalog: input.catalog, previous: candidate, now });
    if (remade !== null) await setCandidateHubCheck(db, { candidateId: remade.id, pages: next, done, at: now });
  }
  return true;
}

/** A new candidate from the draft at the old cutoff, superseding the old one (the board names the rows it added). */
async function remakeAt(db: Database, input: { subject: Subject; catalog: PageCatalog; previous: CandidateRow; now: Date }): Promise<CandidateRow | null> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockSaleSettlements(txDb);
    const handin = await findHandinByShift(txDb, input.subject.shift.id, { lock: true });
    if (handin === null || (handin.phase !== "checking" && handin.phase !== "confirm")) return null;
    const marks = await listHandinMarks(txDb, handin.id);
    const facts = await draftFacts(txDb, input.subject, handin, input.catalog, input.previous.cutoffAt, marks);
    const lines = draftLines(facts, marks);
    const sums = linesPageSums(lines, facts.pages, input.previous.offPlatform);
    return insertHandinCandidate(txDb, {
      handinId: handin.id, door: input.previous.door, actorUserId: input.previous.actorUserId, agentKeyId: input.previous.agentKeyId,
      telegramMessageRef: input.previous.telegramMessageRef, telegramSenderId: input.previous.telegramSenderId, cutoffAt: input.previous.cutoffAt,
      totalMills: sums.totalMills, pages: sums.pages, lines, offPlatform: input.previous.offPlatform, comment: handin.comment,
      ruleVersion: SALE_RULE.version, hubCheck: input.previous.hubCheck, at: input.now,
    });
  });
}

// ── «Нет в Hub» ──────────────────────────────────────────────────────────────

/**
 * What a page's own list on the site showed (the extension's observers): JOURNALED FIRST — one `observations` row per
 * row the site showed, keyed by the page and the platform's reference (digests only: a key outlives a fan's erasure) —
 * then kept as a sighting while Hub holds no transaction with that reference. Idempotent by (page, reference). Only a
 * person with the board, on a page their token may work.
 */
export async function recordSaleSightings(app: Pick<AppContext, "db" | "logger">, principal: HumanAuthPrincipal, body: ClientSaleSightingsBody, now: Date = new Date()) {
  if (principal.authMethod !== "device_token") throw new ForbiddenError("The extension's device token only");
  const person = await findHandinPersonOfUser(app.db, principal.user.id);
  if (person?.submitsShiftSince == null) throw new ForbiddenError("The board is not switched on for this person");
  const catalog = await pageCatalog(app.db);
  const pageId = catalog.idOf.get(body.pageLabel);
  if (pageId === undefined || !principal.assignedPageIds.includes(pageId)) throw new NotFoundError("No such page of yours");
  const platform = catalog.info.get(body.pageLabel)?.platform ?? "fansly";
  const producer = clientCaptureProducer(principal, null);
  const known = await listKnownPlatformRefs(app.db, { pageId, refs: body.rows.map((row) => row.platformRef) });
  let kept = 0;
  for (const row of body.rows) {
    const payload = { pageLabel: body.pageLabel, row };
    await insertObservation(app.db, {
      source: "client_capture",
      producer,
      platform: platform === "onlyfans" ? "onlyfans" : "fansly",
      accountId: pageId,
      kind: SALE_SIGHTINGS_OBSERVATION_KIND,
      payload,
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
      idempotencyKey: `sale_sighting:${pageId}:${createHash("sha256").update(row.platformRef).digest("hex").slice(0, 32)}:${createHash("sha256").update(JSON.stringify(row)).digest("hex").slice(0, 16)}`,
      observedAt: now,
      actorPrincipalId: principal.user.id,
    });
    if (known.has(row.platformRef)) continue;
    await upsertSaleSighting(app.db, {
      pageId, platformRef: row.platformRef, kind: row.kind, fanRef: row.fanRef, fanName: row.fanName, occurredAt: new Date(row.occurredAt),
      grossMills: row.grossMills, netMills: row.netMills, seenByUserId: principal.user.id, seenByDeviceTokenId: principal.deviceTokenId ?? null,
    }, now);
    kept += 1;
  }
  return { kept, known: body.rows.length - kept, serverNow: now.toISOString() };
}

/** A sighting whose transaction arrived is matched (no longer «нет в Hub»; its sale is a line of the draft from now on). */
export async function matchSightings(app: CheckApp, now: Date): Promise<number> {
  let matched = 0;
  for (const one of await listSightingsHubNowHolds(app.db, 500)) {
    await setSaleSightingMatched(app.db, { id: one.sightingId, transactionId: one.transactionId, at: now });
    matched += 1;
  }
  return matched;
}

// ── The board's other minute work ────────────────────────────────────────────

/**
 * The matters of «нет в Hub» unmatched for 48 hours (the decider's; a matched one closes it), the pot's offers (the
 * owner's, one per sale, closed by his decision or the word taken back), and a post copied before a version changed a
 * page sum (the person's: «Пост изменился»).
 */
export async function syncCheckMatters(app: CheckApp, now: Date): Promise<number> {
  const { db } = app;
  const pages = await listMatterPageLabels(db);
  let touched = 0;
  const want = new Set<string>();
  const open = async (input: Parameters<typeof openMatter>[1]) => {
    want.add(input.key);
    const opened = await openMatter(db, input, SYSTEM, now);
    if (opened.transition !== "unchanged") touched += 1;
  };
  const decider = disputeDecider({ modelSlug: null });
  for (const one of await listSightingsUnmatchedSince(db, new Date(now.getTime() - SIGHTING_UNMATCHED_MS))) {
    await open({
      key: `${SIGHTING_UNMATCHED_KIND}:${one.id}`, kind: SIGHTING_UNMATCHED_KIND, source: "server",
      title: `Есть на сайте, нет в Hub: ${one.pageLabel}, ${formatUsdFromMills(one.netMills)}, ${one.occurredAt.toISOString().slice(0, 10)}`,
      object: { type: "sale_sighting", id: String(one.id) }, pageIds: [one.pageId],
      owner: decider.kind === "owner" ? { role: "owner" } : { userId: decider.user?.userId ?? 0 }, money: true,
      evidence: { sightingId: one.id, netMills: one.netMills, occurredAt: one.occurredAt.toISOString() }, link: null,
    });
  }
  const offers = await listOpenPotOffers(db);
  const names = await listHandinNames(db, offers.map((one) => one.userId));
  for (const one of offers) {
    await open({
      key: `${POT_OFFER_KIND}:${one.transactionId}`, kind: POT_OFFER_KIND, source: "server",
      title: `${names.get(one.userId) ?? "Чаттер"} отдаёт продажу в общак: ${formatUsdFromMills(one.netMills)}, ${one.occurredAt.toISOString().slice(0, 10)}`,
      object: { type: "transaction", id: String(one.transactionId) }, pageIds: [one.pageId], owner: { role: "owner" }, money: true,
      evidence: { transactionId: one.transactionId, shiftId: one.shiftId }, link: `/workboard/decisions?dispute=${one.transactionId}#questions`,
    });
  }
  for (const one of await listHandinsPostCopiedBehind(db)) {
    const versions = await listHandinVersions(db, one.handinId);
    const copied = versions.find((version) => version.version === one.copied);
    const current = versions.at(-1);
    if (copied === undefined || current === undefined || !postPagesDiffer(copied.pages, current.pages)) continue;
    await open({
      key: `${POST_CHANGED_KIND}:${one.handinId}`, kind: POST_CHANGED_KIND, source: "server",
      title: "Пост изменился. Исправьте прежний пост в «Отчётности», новый не пишите",
      object: { type: "shift", id: String(one.shiftId) },
      pageIds: current.pages.map((page) => pages.idOf.get(page.pageLabel)).filter((id): id is number => id !== undefined),
      owner: { userId: one.userId }, money: false, evidence: { shiftId: one.shiftId, copied: one.copied, current: one.current }, link: `/workboard/report/${one.shiftId}`,
    });
  }
  for (const matter of await listOpenMattersOfKinds(db, [SIGHTING_UNMATCHED_KIND, POT_OFFER_KIND, POST_CHANGED_KIND])) {
    if (want.has(matter.key)) continue;
    const closed = await closeMatter(db, { key: matter.key, how: "resolved", writer: "server" }, SYSTEM, now);
    if (closed.transition === "closed") touched += 1;
  }
  return touched;
}

/** «После сдачи», cheaply: the count of the person's sales on a counted shift no version holds (the pulse's dot). */
export async function syncLateMarks(app: CheckApp, now: Date): Promise<number> {
  let changed = 0;
  for (const one of await countLateSales(app.db, { since: new Date(now.getTime() - 7 * DAY_MS) })) {
    if (one.lateSales === one.current) continue;
    await setHandinLateSales(app.db, { handinId: one.handinId, lateSales: one.lateSales });
    changed += 1;
  }
  return changed;
}

/**
 * A shift row cancelled or merged after a hand-in. Cancelled: its open candidate is superseded and, when a version
 * counts lines, the system makes a version with none (the ledger and the rule stop counting it); the person gets a
 * matter. Merged: the report moves to the shift that remains when that shift has none (else as cancelled).
 */
export async function settleGoneShifts(app: CheckApp, now: Date): Promise<number> {
  const { db } = app;
  let touched = 0;
  for (const one of await listHandinsOfGoneShifts(db)) {
    if (one.state === "merged" && one.mergedInto !== null && (await moveHandinToShift(db, { handinId: one.handinId, shiftId: one.mergedInto }))) {
      touched += 1;
      continue;
    }
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Database;
      await lockSaleSettlements(txDb);
      await supersedeOpenCandidates(txDb, { handinId: one.handinId, at: now });
      const handin = (await findHandinById(txDb, one.handinId))!;
      const latest = (await listHandinVersions(txDb, one.handinId)).at(-1);
      if (latest !== undefined && latest.lines.length > 0) {
        // A version with no lines, made by the system (`decision`, outcome `cancelled`: what rules without the shift).
        await insertHandinVersion(txDb, {
          handin, door: latest.door === "telegram" ? "workboard" : latest.door, actorUserId: latest.actorUserId ?? one.userId, agentKeyId: null,
          telegramMessageRef: null, telegramSenderId: null, totalMills: 0, pages: latest.pages.map((page) => ({ pageLabel: page.pageLabel, amountMills: 0 })),
          lines: [], offPlatform: [], comment: latest.comment, dayPaid: null, ruleVersion: SALE_RULE.version,
          madeFor: { kind: "decision", decisionId: null, transactionId: null, outcome: "cancelled" }, reportDate: latest.reportDate ?? handin.reportDate, at: now,
        });
        await setHandinPhase(txDb, { handinId: one.handinId, phase: "counted", at: now });
      } else {
        await setHandinPhase(txDb, { handinId: one.handinId, phase: "draft", at: now });
      }
    });
    await openMatter(db, {
      key: `${SHIFT_CANCELLED_KIND}:${one.shiftId}`, kind: SHIFT_CANCELLED_KIND, source: "server",
      title: "Смена отменена: её отчёт больше не считается", object: { type: "shift", id: String(one.shiftId) }, pageIds: [],
      owner: { userId: one.userId }, money: false, evidence: { shiftId: one.shiftId }, link: null,
    }, SYSTEM, now);
    touched += 1;
  }
  return touched;
}
