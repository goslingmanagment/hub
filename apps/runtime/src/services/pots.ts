import { z } from "zod";

import type {
  LegacyLedgerPot,
  PotCreateBody,
  PotDetailResponse,
  PotDistributionItem,
  PotDistributionPreviewResponse,
  PotEligibleSale,
  PotFormula,
  PotSummary,
  PotsListResponse,
  PotUnroutedSale,
  PotUpdateBody,
} from "@agency_hub_core/contracts";
import {
  clearPotAutoPostHold,
  closeMatter,
  closePotRow,
  countActivePotDistributions,
  enqueueSaleHomeRefreshForPages,
  findPotByCode,
  findPotById,
  findPotDistributionById,
  hasLiveDistributionsBefore,
  holdPotAutoPost,
  insertPot,
  insertPotDistribution,
  listActivePotPartsForDay,
  listHandinNames,
  listMatterPageLabels,
  listOpenMattersOfKinds,
  listPersonRows,
  listPotAutoPostHolds,
  listPotCatalogModelsAndPages,
  listPotDistributions,
  listPotSaleHomesSince,
  listPots,
  listSaleHomesForPotCheck,
  lockWorkboardPots,
  losesPostedPotCoverage,
  openMatter,
  readPotsSwitch,
  reversePotDistributionRow,
  setPotsSwitch,
  sumActiveDistributedByTransactions,
  sumActiveDistributedByTransactionsInPot,
  summarizeActiveDistributionsByPot,
  updatePot,
  type Database,
  type MatterActor,
  type PotDistributionRow,
  type PotIntakeReason,
  type PotRow,
  type PotSaleHomeRow,
  type PotsSwitch,
} from "@agency_hub_core/db";
import { formatUsdFromMills } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { recordOwnerWrite, type HumanAuthPrincipal, type OperatorContext } from "./auth.ts";
import { moscowDayOf } from "./chatter-shifts.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
import { ledgerChecked, ledgerGet, list, micros, millsOf, type LedgerReadApp } from "./ledger-payouts.ts";
import {
  computePotDistributionLines,
  hasSaleLeftPot,
  potCoversPageDay,
  resolvePotParticipants,
  routePotOfSale,
  type PotRoutingSpec,
} from "./pots-rules.ts";
import { POT_OBSHAK } from "./sale-rule.ts";
import { realmOf, requireSameRealm } from "./sandbox/realm.ts";
import { loadParticipantContext, type ParticipantLookupContext } from "./page-workers.ts";
import { dayWords } from "./shift-handin-rules.ts";

/**
 * Workboard pots (0443, H11):
 *  - pot definitions (`pots`) and switch (`pots_switch`);
 *  - balance in base mills derived live from `sale_homes` (`home = 'pot'`, day >= `pots_from`) minus non-reversed
 *    `pot_distribution_parts` across ALL pots;
 *  - pure preview (`previewPotDistribution`) and immutable post (`postPotDistribution`) under global `lockWorkboardPots`
 *    enforcing `sale.net_mills - Σ(non-reversed parts across ALL pots) >= part.base_mills` for every sale;
 *  - day reconciliation (`reconcilePotsOfDay`) called at the end of `refreshSaleHomesForDay` (lock order strictly
 *    `settlements -> refresh_day -> pots`): auto-posts `auto_post` equal pots, auto-reverses single-sale auto
 *    distributions when a sale leaves, opens owner matters for manual distributions or missing participants, and keeps
 *    one aggregate `pot.unrouted:open` health matter;
 *  - ledger cutover validation (`validatePotDecisionTarget`) and legacy archive read (`readLegacyLedgerPots`).
 */

type PotsApp = Pick<AppContext, "db" | "config" | "logger">;

const SYSTEM: MatterActor = { door: "system" };

export const POT_UNROUTED_KIND = "pot.unrouted";
export const POT_NO_PARTICIPANTS_KIND = "pot.no_participants";
export const POT_SALE_LEFT_KIND = "pot.sale_left";

// ── Ledger schemas (legacy pots archive + pre-cutover coverage check) ────────

const ledgerPotParticipantSchema = z.object({
  person: z.string(),
  from: z.string(),
  to: z.string().nullable().optional().transform((v) => v ?? null),
});

const ledgerPotSchema = z.object({
  slug: z.string(),
  name: z.string(),
  model: z.string(),
  pages: list(z.string()),
  starts_at: z.string(),
  ends_at: z.string().nullable().optional().transform((v) => v ?? null),
  participants: list(ledgerPotParticipantSchema).optional().default([]),
  status: z.string(),
  sales: z.number().int().nonnegative().optional().default(0),
  net_micros: micros.optional().default(0),
});

const ledgerPotsListSchema = z.object({
  pots: list(ledgerPotSchema),
});

const ledgerPotShowSchema = z.object({
  pot: ledgerPotSchema,
});

// ── Ledger reads (NEVER called under any DB lock!) ───────────────────────────

export async function readLegacyLedgerPots(
  app: LedgerReadApp,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<{ available: boolean; error: string | null; pots: LegacyLedgerPot[] }> {
  if (app.config.ledgerPayoutsKey == null && options.fetchImpl === undefined) {
    return { available: false, error: "Ledger не подключён", pots: [] };
  }
  try {
    const body = await ledgerGet(app, "/v1/pots", {}, { client: "workboard-pots", ...options });
    const parsed = ledgerChecked(app.logger, ledgerPotsListSchema, body, "/v1/pots", "ledger pots: unexpected answer");
    return {
      available: true,
      error: null,
      pots: parsed.pots.map((pot): LegacyLedgerPot => ({
        slug: pot.slug,
        name: pot.name,
        model: pot.model,
        pages: pot.pages,
        startsAt: pot.starts_at,
        endsAt: pot.ends_at,
        status: pot.status,
        sales: pot.sales,
        netMills: millsOf(pot.net_micros),
        participants: pot.participants.map((p) => ({ person: p.person, from: p.from, to: p.to })),
      })),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { available: false, error: message, pots: [] };
  }
}

/**
 * Validates pot coverage BEFORE opening any DB transaction when deciding a sale «в общак <code>»:
 *  - For day < `pots_from` (or while `pots_from` is null): validates `pages`, `starts_at`, `ends_at` against ledger
 *    `GET /v1/pots/{slug}` (409 if not covered; skips ledger HTTP for test realm or unconfigured dev/test ledger).
 *  - For day >= `pots_from`: validates Hub pot exists in the same realm, is `open`, and covers page + day (409 if not).
 *    When `requestedPot` is omitted (e.g., Workboard «Остаётся в общаке» / pot offer), resolves the unique open Hub pot
 *    covering `(pageId, day)` instead of hardcoding `POT_OBSHAK`.
 */
export async function validatePotDecisionTarget(
  app: PotsApp,
  input: {
    pageId: number;
    pageLabel: string;
    day: string;
    requestedPot: string | null;
    fallbackHomePot?: string | null;
    fallbackReason?: string | null;
    isTest: boolean;
  },
  options: { fetchImpl?: typeof fetch } = {},
): Promise<{ era: "hub" | "ledger"; potCode: string }> {
  const { potsFrom } = await readPotsSwitch(app.db);
  const realm = input.isTest ? "test" : "live";

  if (potsFrom !== null && input.day >= potsFrom) {
    const realmPots = await listPots(app.db, realm);
    const explicit = input.requestedPot !== null && input.requestedPot.trim() !== "" && input.requestedPot !== POT_OBSHAK
      ? input.requestedPot.trim()
      : null;

    if (explicit !== null) {
      const pot = realmPots.find((one) => one.code === explicit);
      if (pot === undefined || pot.state !== "open" || !potCoversPageDay(pot, input.pageId, input.day)) {
        throw new ConflictError(`На ${input.day} открытого общака «${explicit}» для страницы ${input.pageLabel} нет`, {
          reason: "pot_not_covered",
        });
      }
      return { era: "hub", potCode: pot.code };
    }

    // No explicit code: prefer current explicit home pot if valid & open, else unique open page pot, else unique open pot.
    const homeExplicit = input.fallbackHomePot && input.fallbackHomePot !== POT_OBSHAK ? input.fallbackHomePot.trim() : null;
    if (homeExplicit !== null) {
      const pot = realmPots.find((one) => one.code === homeExplicit && one.state === "open" && potCoversPageDay(one, input.pageId, input.day));
      if (pot !== undefined) return { era: "hub", potCode: pot.code };
    }

    const openCovering = realmPots.filter((pot) => pot.state === "open" && potCoversPageDay(pot, input.pageId, input.day));
    const reasonMatches = input.fallbackReason === "post_tip" || input.fallbackReason === "campaign"
      ? openCovering.filter((pot) => pot.intakeReasons.includes(input.fallbackReason as PotIntakeReason))
      : openCovering.filter((pot) => pot.intakeReasons.length > 0);
    if (reasonMatches.length === 1) return { era: "hub", potCode: reasonMatches[0]!.code };
    if (openCovering.length === 1) return { era: "hub", potCode: openCovering[0]!.code };

    throw new ConflictError(
      openCovering.length === 0
        ? `На ${input.day} нет открытого общака для страницы ${input.pageLabel}`
        : `На ${input.day} для страницы ${input.pageLabel} открыто несколько общаков (${openCovering.map((p) => p.code).join(", ")}): укажите код`,
      { reason: "pot_not_covered" },
    );
  }

  // Ledger era: day < pots_from (or pots_from IS NULL).
  const explicit = input.requestedPot !== null && input.requestedPot.trim() !== "" && input.requestedPot !== POT_OBSHAK
    ? input.requestedPot.trim()
    : null;
  if (explicit === null) {
    return { era: "ledger", potCode: input.fallbackHomePot ?? POT_OBSHAK };
  }

  if (!input.isTest && (app.config.ledgerPayoutsKey != null || options.fetchImpl !== undefined)) {
    const body = await ledgerGet(app, `/v1/pots/${encodeURIComponent(explicit)}`, {}, {
      client: "workboard-pots",
      absentOn: [404],
      ...options,
    });
    if (body === undefined) {
      throw new ConflictError(`На ${input.day} общака «${explicit}» в ledger нет`, { reason: "pot_not_covered" });
    }
    const parsed = ledgerChecked(app.logger, ledgerPotShowSchema, body, `/v1/pots/${explicit}`, "ledger pot show: unexpected answer");
    const pot = parsed.pot;
    const pageCovered = pot.pages.includes(input.pageLabel);
    const dayCovered = pot.starts_at <= input.day && (pot.ends_at === null || input.day <= pot.ends_at);
    if (pot.status !== "open" || !pageCovered || !dayCovered) {
      throw new ConflictError(
        `На ${input.day} общак «${explicit}» не покрывает страницу ${input.pageLabel} (срок ${pot.starts_at}..${pot.ends_at ?? "без конца"})`,
        { reason: "pot_not_covered" },
      );
    }
  }
  return { era: "ledger", potCode: explicit };
}

// ── Switch CLI/service helper ────────────────────────────────────────────────

export async function setPotsFromSwitch(
  db: Database,
  input: { potsFrom: string | null; setBy: string; at: Date },
): Promise<PotsSwitch> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await lockWorkboardPots(tx);
    if (input.potsFrom === null) {
      const activeCount = await countActivePotDistributions(tx);
      if (activeCount > 0) {
        throw new ConflictError(
          `Нельзя выключить pots_from: уже есть проведённые раздачи в Workboard (${activeCount}). Остановите новые раздачи и оформите компенсации.`,
          { reason: "distributions_exist" },
        );
      }
      await setPotsSwitch(tx, { potsFrom: null, setBy: input.setBy, at: input.at });
    } else {
      const current = await readPotsSwitch(tx);
      if ((current.potsFrom === null || input.potsFrom > current.potsFrom) && await hasLiveDistributionsBefore(tx, input.potsFrom)) {
        throw new ConflictError("До выбранной даты уже есть проведённые раздачи", { reason: "distributions_exist" });
      }
      await setPotsSwitch(tx, { potsFrom: input.potsFrom, setBy: input.setBy, at: input.at });
      await enqueueSaleHomeRefreshForPages(tx, { pageIds: null, fromDay: input.potsFrom });
    }
    return readPotsSwitch(tx);
  });
}

// ── Participant loading helper (matches H8 `liveNobodyContext`) ──────────────

function routingSpecsOf(pots: readonly PotRow[]): PotRoutingSpec[] {
  return pots.map((pot) => ({
    id: pot.id,
    code: pot.code,
    pageIds: pot.pageIds,
    intakeReasons: pot.intakeReasons,
    opensOn: pot.opensOn,
    closesOn: pot.closesOn,
    state: pot.state,
  }));
}

function uniqueReasons(reasons: readonly PotIntakeReason[]): PotIntakeReason[] {
  return [...new Set(reasons)].sort() as PotIntakeReason[];
}

function validateOpeningDay(opensOn: string, potsFrom: string | null) {
  if (potsFrom !== null && opensOn < potsFrom) {
    throw new BadRequestError("Дата открытия раньше даты включения общаков", { reason: "before_pots_from" });
  }
}

function validatePotConfig(input: {
  pageIds: readonly number[];
  modelPageIds: ReadonlySet<number>;
  opensOn: string;
  closesOn: string | null;
  formula: PotFormula;
  autoPost: boolean;
  participantsMode: "page_workers" | "listed";
  participants: ReadonlyArray<{ personCode: string; fromDay: string; toDay: string | null }>;
  knownPeople: ReadonlySet<string>;
}): void {
  if (input.pageIds.length === 0) throw new BadRequestError("Выберите хотя бы одну страницу", { reason: "no_pages" });
  for (const pageId of input.pageIds) {
    if (!input.modelPageIds.has(pageId)) {
      throw new BadRequestError(`Страница #${pageId} не принадлежит выбранной модели`, { reason: "page_model_mismatch" });
    }
  }
  if (input.closesOn !== null && input.closesOn < input.opensOn) {
    throw new BadRequestError("Дата закрытия не может быть раньше даты открытия", { reason: "bad_dates" });
  }
  if (input.autoPost && input.formula.kind !== "equal") {
    throw new BadRequestError("Автопроведение доступно только для формулы «поровну» (equal)", { reason: "auto_post_requires_equal" });
  }
  if (input.participantsMode === "listed") {
    for (const entry of input.participants) {
      if (!input.knownPeople.has(entry.personCode)) {
        throw new BadRequestError(`Неизвестный код человека: ${entry.personCode}`, { reason: "person_unknown" });
      }
      if (entry.toDay !== null && entry.toDay < entry.fromDay) {
        throw new BadRequestError(`У участника ${entry.personCode} дата окончания раньше даты начала`, { reason: "bad_dates" });
      }
    }
  }
}

function toPotSummary(
  pot: PotRow,
  labelOf: ReadonlyMap<number, string>,
  stats: { eligibleBaseMills: number; postedBaseMills: number; balanceMills: number; eligibleCount: number; distributionsCount: number },
): PotSummary {
  return {
    id: pot.id,
    code: pot.code,
    name: pot.name,
    modelId: pot.modelId,
    modelSlug: pot.modelSlug,
    modelName: pot.modelName,
    pageIds: pot.pageIds,
    pageLabels: pot.pageIds.map((id) => labelOf.get(id) ?? `#${id}`),
    intakeReasons: pot.intakeReasons,
    opensOn: pot.opensOn,
    closesOn: pot.closesOn,
    participantsMode: pot.participantsMode,
    participants: pot.participants,
    formula: pot.formula,
    autoPost: pot.autoPost,
    state: pot.state,
    eligibleBaseMills: stats.eligibleBaseMills,
    postedBaseMills: stats.postedBaseMills,
    balanceMills: stats.balanceMills,
    eligibleCount: stats.eligibleCount,
    distributionsCount: stats.distributionsCount,
    createdAt: pot.createdAt.toISOString(),
    updatedAt: pot.updatedAt.toISOString(),
  };
}

async function toDistributionWires(db: Database, rows: readonly PotDistributionRow[]): Promise<PotDistributionItem[]> {
  const userIds = [...new Set(rows.flatMap((row) => [row.postedByUserId, row.reversedByUserId].filter((id): id is number => id !== null)))];
  const names = await listHandinNames(db, userIds);
  return rows.map((row) => ({
    id: row.id,
    potId: row.potId,
    day: row.day,
    formula: row.formula,
    baseMills: row.baseMills,
    lines: row.lines,
    parts: row.parts.map((part) => ({
      transactionId: part.transactionId,
      pageId: part.pageId,
      pageLabel: part.pageLabel ?? `#${part.pageId}`,
      baseMills: part.baseMills,
    })),
    postedAt: row.postedAt.toISOString(),
    postedByName: row.postedByUserId === null ? null : names.get(row.postedByUserId) ?? `#${row.postedByUserId}`,
    reversedAt: row.reversedAt?.toISOString() ?? null,
    reversedByName: row.reversedByUserId === null ? null : names.get(row.reversedByUserId) ?? `#${row.reversedByUserId}`,
    reversedReason: row.reversedReason,
  }));
}

interface RealmPotSnapshot {
  potsFrom: string | null;
  pots: PotRow[];
  statsByPot: Map<number, { eligibleBaseMills: number; postedBaseMills: number; balanceMills: number; eligibleCount: number; distributionsCount: number }>;
  routedSalesByPot: Map<number, Array<{ sale: PotSaleHomeRow; distributedAll: number; remaining: number }>>;
  unrouted: PotUnroutedSale[];
}

async function computeRealmPotSnapshot(db: Database, realm: "live" | "test"): Promise<RealmPotSnapshot> {
  const { potsFrom } = await readPotsSwitch(db);
  const pots = await listPots(db, realm);
  const specs = routingSpecsOf(pots);
  const distSummaries = await summarizeActiveDistributionsByPot(db, pots.map((p) => p.id));

  const statsByPot = new Map<number, { eligibleBaseMills: number; postedBaseMills: number; balanceMills: number; eligibleCount: number; distributionsCount: number }>();
  const routedSalesByPot = new Map<number, Array<{ sale: PotSaleHomeRow; distributedAll: number; remaining: number }>>();
  for (const pot of pots) {
    const dist = distSummaries.get(pot.id) ?? { postedBaseMills: 0, distributionsCount: 0 };
    statsByPot.set(pot.id, {
      eligibleBaseMills: dist.postedBaseMills,
      postedBaseMills: dist.postedBaseMills,
      balanceMills: 0,
      eligibleCount: 0,
      distributionsCount: dist.distributionsCount,
    });
    routedSalesByPot.set(pot.id, []);
  }

  const unrouted: PotUnroutedSale[] = [];
  if (potsFrom === null) {
    return { potsFrom, pots, statsByPot, routedSalesByPot, unrouted };
  }

  const sales = await listPotSaleHomesSince(db, { sinceDay: potsFrom, realm });
  const distributedAll = await sumActiveDistributedByTransactions(db, sales.map((sale) => sale.transactionId));

  for (const sale of sales) {
    const dist = distributedAll.get(sale.transactionId) ?? 0;
    const remaining = Math.max(0, sale.netMills - dist);
    const routed = routePotOfSale(sale, specs, potsFrom);
    if (routed.status === "routed") {
      routedSalesByPot.get(routed.potId)!.push({ sale, distributedAll: dist, remaining });
      const stats = statsByPot.get(routed.potId)!;
      stats.balanceMills += remaining;
      stats.eligibleBaseMills = stats.postedBaseMills + stats.balanceMills;
      if (remaining > 0) stats.eligibleCount += 1;
    } else if (routed.status === "unrouted" && remaining > 0) {
      unrouted.push({
        transactionId: sale.transactionId,
        pageId: sale.pageId,
        pageLabel: sale.pageLabel,
        modelSlug: sale.modelSlug,
        kind: sale.canonicalType,
        occurredAt: sale.occurredAt.toISOString(),
        day: sale.day,
        netMills: sale.netMills,
        remainingBaseMills: remaining,
        reason: sale.reason,
        pot: sale.pot,
        why: routed.why,
        matchingPotCodes: routed.matchingPotCodes,
      });
    }
  }
  return { potsFrom, pots, statsByPot, routedSalesByPot, unrouted };
}

/** A pot sale whose base is not (all) distributed yet, where the routing puts it: its open pot, its day, what remains. */
export interface PendingPotSale {
  pot: PotRow;
  transactionId: number;
  day: string;
  remainingMills: number;
}

/**
 * The realm's base still to distribute, sale by sale, from the same snapshot as the owner's «Общаки» (a sale routed
 * to an open pot with remaining base > 0): for a person's own expected share (`accountPots`, pots-mine.ts). The
 * realm's pots come with it; nothing of the owner's summary.
 */
export async function listPendingPotSales(db: Database, realm: "live" | "test"): Promise<{ potsFrom: string | null; pots: PotRow[]; pending: PendingPotSale[] }> {
  const snapshot = await computeRealmPotSnapshot(db, realm);
  const pending: PendingPotSale[] = [];
  for (const pot of snapshot.pots) {
    for (const entry of snapshot.routedSalesByPot.get(pot.id) ?? []) {
      if (entry.remaining > 0) pending.push({ pot, transactionId: entry.sale.transactionId, day: entry.sale.day, remainingMills: entry.remaining });
    }
  }
  return { potsFrom: snapshot.potsFrom, pots: snapshot.pots, pending };
}

/** Keeps the single aggregate `pot.unrouted:open` health matter in sync for the live realm (no per-sale matters). */
export async function syncUnroutedPotMatter(db: Database, now: Date): Promise<number> {
  const snapshot = await computeRealmPotSnapshot(db, "live");
  const key = `${POT_UNROUTED_KIND}:open`;
  if (snapshot.unrouted.length === 0) {
    const closed = await closeMatter(db, { key, how: "resolved", writer: "server" }, SYSTEM, now);
    return closed.transition === "closed" ? 1 : 0;
  }
  const totalMills = snapshot.unrouted.reduce((sum, item) => sum + item.remainingBaseMills, 0);
  const opened = await openMatter(db, {
    key,
    kind: POT_UNROUTED_KIND,
    source: "server",
    title: `Продажи в общак без общака: ${snapshot.unrouted.length} на ${formatUsdFromMills(totalMills)}`,
    object: null,
    pageIds: [...new Set(snapshot.unrouted.map((item) => item.pageId))],
    owner: { role: "owner" },
    money: true,
    evidence: {
      count: snapshot.unrouted.length,
      totalMills,
      transactionIds: snapshot.unrouted.slice(0, 200).map((item) => item.transactionId),
    },
    link: "/workboard/money/pots?tab=unrouted",
  }, SYSTEM, now);
  return opened.transition === "unchanged" ? 0 : 1;
}

// ── Owner API reads & writes ─────────────────────────────────────────────────

export async function readPotsList(
  app: PotsApp,
  principal: HumanAuthPrincipal,
  options: { fetchImpl?: typeof fetch; now?: Date; includeLegacyArchive?: boolean } = {},
): Promise<PotsListResponse> {
  const now = options.now ?? new Date();
  const realm = realmOf(principal);
  const [snapshot, pages, models, peopleRows, legacyArchive] = await Promise.all([
    computeRealmPotSnapshot(app.db, realm),
    listMatterPageLabels(app.db),
    listPotCatalogModelsAndPages(app.db, realm),
    listPersonRows(app.db, realm),
    options.includeLegacyArchive === false
      ? Promise.resolve({ available: false, error: null, pots: [] as LegacyLedgerPot[] })
      : realm === "test"
        ? Promise.resolve({ available: false, error: "В тестовой команде архив ledger не читается", pots: [] as LegacyLedgerPot[] })
        : readLegacyLedgerPots(app, options),
  ]);

  return {
    potsFrom: snapshot.potsFrom,
    pots: snapshot.pots.map((pot) => toPotSummary(pot, pages.labelOf, snapshot.statsByPot.get(pot.id)!)),
    unroutedCount: snapshot.unrouted.length,
    unroutedBaseMills: snapshot.unrouted.reduce((sum, item) => sum + item.remainingBaseMills, 0),
    unrouted: snapshot.unrouted,
    models: models.map((m) => ({ id: m.modelId, slug: m.modelSlug, name: m.modelName, pages: m.pages })),
    people: peopleRows
      .filter((person) => person.kind === "human" && (person.role === "chatter" || person.role === "team_lead"))
      .map((person) => ({ code: person.code, displayName: person.displayName, role: person.role, state: person.state })),
    legacyArchive,
    serverNow: now.toISOString(),
  };
}

export async function readPotDetail(
  app: PotsApp,
  principal: HumanAuthPrincipal,
  potId: number,
  now: Date = new Date(),
  participantDay = moscowDayOf(now.getTime()),
): Promise<PotDetailResponse> {
  const pot = await findPotById(app.db, potId);
  if (pot === null) throw new NotFoundError("Общак не найден");
  requireSameRealm(principal, pot.isTest, () => new NotFoundError("Общак не найден"));

  const realm = pot.isTest ? "test" : "live";
  const [snapshot, pages, distributions, participantCtx] = await Promise.all([
    computeRealmPotSnapshot(app.db, realm),
    listMatterPageLabels(app.db),
    listPotDistributions(app.db, pot.id),
    loadParticipantContext(app.db, realm, participantDay),
  ]);

  const routedEntries = snapshot.routedSalesByPot.get(pot.id) ?? [];
  const distributedHere = await sumActiveDistributedByTransactionsInPot(
    app.db,
    pot.id,
    routedEntries.map((entry) => entry.sale.transactionId),
  );
  const sales: PotEligibleSale[] = routedEntries.map((entry) => {
    const here = distributedHere.get(entry.sale.transactionId) ?? 0;
    const elsewhere = Math.max(0, entry.distributedAll - here);
    return {
      transactionId: entry.sale.transactionId,
      pageId: entry.sale.pageId,
      pageLabel: entry.sale.pageLabel,
      kind: entry.sale.canonicalType,
      occurredAt: entry.sale.occurredAt.toISOString(),
      day: entry.sale.day,
      netMills: entry.sale.netMills,
      distributedElsewhereMills: elsewhere,
      distributedHereMills: here,
      remainingBaseMills: entry.remaining,
      reason: entry.sale.reason,
    };
  });

  const activeParticipants = resolvePotParticipants({
    day: participantDay,
    mode: pot.participantsMode,
    pageIds: pot.pageIds,
    listed: pot.participants,
    people: participantCtx.people,
    workingPages: participantCtx.workingPages,
    slots: participantCtx.slots,
  });

  return {
    potsFrom: snapshot.potsFrom,
    pot: toPotSummary(pot, pages.labelOf, snapshot.statsByPot.get(pot.id)!),
    activeParticipants,
    sales,
    distributions: await toDistributionWires(app.db, distributions),
    serverNow: now.toISOString(),
  };
}

export async function createPot(
  app: PotsApp,
  principal: HumanAuthPrincipal,
  body: PotCreateBody,
  now: Date = new Date(),
  operator?: OperatorContext,
): Promise<{ pot: PotSummary; savedAt: string }> {
  const realm = realmOf(principal);
  const catalog = await listPotCatalogModelsAndPages(app.db, realm);
  const model = catalog.find((one) => one.modelId === body.modelId);
  if (model === undefined) throw new NotFoundError("Модель не найдена");

  const pageIds = [...new Set(body.pageIds)].sort((a, b) => a - b);
  const people = await listPersonRows(app.db, realm);
  const knownPeople = new Set(people.filter((p) => p.kind === "human").map((p) => p.code));
  const intakeReasons = uniqueReasons(body.intakeReasons);
  validatePotConfig({
    pageIds,
    modelPageIds: new Set(model.pages.map((p) => p.id)),
    opensOn: body.opensOn,
    closesOn: body.closesOn,
    formula: body.formula,
    autoPost: body.autoPost,
    participantsMode: body.participantsMode,
    participants: body.participants,
    knownPeople,
  });

  const created = await app.db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await lockWorkboardPots(tx);
    const { potsFrom } = await readPotsSwitch(tx);
    validateOpeningDay(body.opensOn, potsFrom);
    const existing = await findPotByCode(tx, body.code);
    if (existing !== null) throw new ConflictError(`Общак с кодом «${body.code}» уже существует`, { reason: "code_taken" });
    const row = await insertPot(tx, {
      code: body.code,
      name: body.name,
      modelId: body.modelId,
      pageIds,
      intakeReasons,
      opensOn: body.opensOn,
      closesOn: body.closesOn,
      participantsMode: body.participantsMode,
      participants: body.participantsMode === "listed" ? body.participants : [],
      formula: body.formula,
      autoPost: body.autoPost,
      createdByUserId: principal.user.id,
    }, now);
    if (potsFrom !== null) {
      const fromDay = body.opensOn > potsFrom ? body.opensOn : potsFrom;
      await enqueueSaleHomeRefreshForPages(tx, { pageIds, fromDay });
    }
    await recordOwnerWrite(tx, principal.user.id, operator, "pot.created", {
      potId: row.id, code: row.code, modelSlug: model.modelSlug,
      pageLabels: model.pages.filter((page) => pageIds.includes(page.id)).map((page) => page.label),
    });
    return row;
  });

  if (realm === "live") await syncUnroutedPotMatter(app.db, now).catch(() => undefined);
  const [snapshot, pages] = await Promise.all([computeRealmPotSnapshot(app.db, realm), listMatterPageLabels(app.db)]);
  return { pot: toPotSummary(created, pages.labelOf, snapshot.statsByPot.get(created.id)!), savedAt: now.toISOString() };
}

export async function updatePotService(
  app: PotsApp,
  principal: HumanAuthPrincipal,
  potId: number,
  body: PotUpdateBody,
  now: Date = new Date(),
  operator?: OperatorContext,
): Promise<{ pot: PotSummary; savedAt: string }> {
  const existing = await findPotById(app.db, potId);
  if (existing === null) throw new NotFoundError("Общак не найден");
  requireSameRealm(principal, existing.isTest, () => new NotFoundError("Общак не найден"));

  const realm = existing.isTest ? "test" : "live";
  const catalog = await listPotCatalogModelsAndPages(app.db, realm);
  const model = catalog.find((one) => one.modelId === existing.modelId);
  if (model === undefined) throw new NotFoundError("Модель общака не найдена");
  const people = await listPersonRows(app.db, realm);
  const knownPeople = new Set(people.filter((p) => p.kind === "human").map((p) => p.code));

  const updated = await app.db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await lockWorkboardPots(tx);
    const { potsFrom } = await readPotsSwitch(tx);
    const current = await findPotById(tx, potId);
    if (current === null) throw new NotFoundError("Общак не найден");
    if (current.state !== "open") throw new ConflictError("Закрытый общак нельзя редактировать", { reason: "pot_closed" });

    const nextPageIds = body.pageIds === undefined ? current.pageIds : [...new Set(body.pageIds)].sort((a, b) => a - b);
    const nextIntake = body.intakeReasons === undefined ? current.intakeReasons : uniqueReasons(body.intakeReasons);
    const nextOpensOn = body.opensOn ?? current.opensOn;
    const nextClosesOn = body.closesOn !== undefined ? body.closesOn : current.closesOn;
    const nextMode = body.participantsMode ?? current.participantsMode;
    const nextParticipants = body.participants !== undefined
      ? (nextMode === "listed" ? body.participants : [])
      : (nextMode === "listed" ? current.participants : []);
    const nextFormula = body.formula ?? current.formula;
    const nextAutoPost = body.autoPost ?? current.autoPost;

    if (await losesPostedPotCoverage(tx, current, {
      pageIds: nextPageIds, opensOn: nextOpensOn, closesOn: nextClosesOn, intakeReasons: nextIntake,
    })) {
      throw new ConflictError("Изменение исключает продажу из проведённой раздачи", { reason: "posted_coverage" });
    }
    validateOpeningDay(nextOpensOn, potsFrom);
    validatePotConfig({
      pageIds: nextPageIds,
      modelPageIds: new Set(model.pages.map((p) => p.id)),
      opensOn: nextOpensOn,
      closesOn: nextClosesOn,
      formula: nextFormula,
      autoPost: nextAutoPost,
      participantsMode: nextMode,
      participants: nextParticipants,
      knownPeople,
    });

    const row = (await updatePot(tx, potId, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      pageIds: nextPageIds,
      intakeReasons: nextIntake,
      opensOn: nextOpensOn,
      closesOn: nextClosesOn,
      participantsMode: nextMode,
      participants: nextParticipants,
      formula: nextFormula,
      autoPost: nextAutoPost,
    }, now))!;

    if (potsFrom !== null) {
      const affectedPages = [...new Set([...current.pageIds, ...nextPageIds])];
      const earliestOpen = current.opensOn < nextOpensOn ? current.opensOn : nextOpensOn;
      const fromDay = earliestOpen > potsFrom ? earliestOpen : potsFrom;
      await enqueueSaleHomeRefreshForPages(tx, { pageIds: affectedPages, fromDay });
    }
    await recordOwnerWrite(tx, principal.user.id, operator, "pot.updated", { potId: row.id, code: row.code });
    return row;
  });

  if (realm === "live") await syncUnroutedPotMatter(app.db, now).catch(() => undefined);
  const [snapshot, pages] = await Promise.all([computeRealmPotSnapshot(app.db, realm), listMatterPageLabels(app.db)]);
  return { pot: toPotSummary(updated, pages.labelOf, snapshot.statsByPot.get(updated.id)!), savedAt: now.toISOString() };
}

export async function closePot(
  app: PotsApp,
  principal: HumanAuthPrincipal,
  potId: number,
  now: Date = new Date(),
  operator?: OperatorContext,
): Promise<{ pot: PotSummary; savedAt: string }> {
  const existing = await findPotById(app.db, potId);
  if (existing === null) throw new NotFoundError("Общак не найден");
  requireSameRealm(principal, existing.isTest, () => new NotFoundError("Общак не найден"));
  const realm = existing.isTest ? "test" : "live";

  const closed = await app.db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await lockWorkboardPots(tx);
    if (!(await closePotRow(tx, potId, now))) {
      throw new ConflictError("Общак уже закрыт", { reason: "already_closed" });
    }
    const row = (await findPotById(tx, potId))!;
    const { potsFrom } = await readPotsSwitch(tx);
    if (potsFrom !== null) {
      await enqueueSaleHomeRefreshForPages(tx, { pageIds: row.pageIds, fromDay: potsFrom });
    }
    await recordOwnerWrite(tx, principal.user.id, operator, "pot.closed", { potId: row.id, code: row.code });
    return row;
  });

  if (realm === "live") await syncUnroutedPotMatter(app.db, now).catch(() => undefined);
  const [snapshot, pages] = await Promise.all([computeRealmPotSnapshot(app.db, realm), listMatterPageLabels(app.db)]);
  return { pot: toPotSummary(closed, pages.labelOf, snapshot.statsByPot.get(closed.id)!), savedAt: now.toISOString() };
}

export async function createPagePots(
  app: PotsApp,
  principal: HumanAuthPrincipal,
  body: { opensOn?: string | undefined },
  now: Date = new Date(),
  operator?: OperatorContext,
): Promise<{ created: PotSummary[]; skippedPageLabels: string[]; savedAt: string }> {
  const realm = realmOf(principal);
  const catalog = await listPotCatalogModelsAndPages(app.db, realm);
  const today = moscowDayOf(now.getTime());

  const createdRows: PotRow[] = [];
  const skippedPageLabels: string[] = [];

  await app.db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await lockWorkboardPots(tx);
    const { potsFrom } = await readPotsSwitch(tx);
    if (body.opensOn !== undefined) validateOpeningDay(body.opensOn, potsFrom);
    const existing = await listPots(tx, realm);
    const usedCodes = new Set(existing.map((p) => p.code));
    const affectedPageIds: number[] = [];

    for (const model of catalog) {
      for (const page of model.pages) {
        const covered = existing.some(
          (pot) =>
            pot.state === "open"
            && pot.pageIds.includes(page.id)
            && pot.intakeReasons.includes("post_tip")
            && pot.intakeReasons.includes("campaign"),
        );
        if (covered) {
          skippedPageLabels.push(page.label);
          continue;
        }
        const replacement = existing.some((pot) => pot.state === "closed" && pot.pageIds.includes(page.id));
        const opensOn = body.opensOn ?? (replacement && (potsFrom === null || today > potsFrom) ? today : potsFrom ?? today);
        const baseCode = `page-${page.label.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || String(page.id)}`.slice(0, 58);
        let code = baseCode;
        let suffix = 2;
        while (usedCodes.has(code)) {
          code = `${baseCode}-${suffix}`;
          suffix += 1;
        }
        usedCodes.add(code);
        const inserted = await insertPot(tx, {
          code,
          name: `Общак ${page.label}`,
          modelId: model.modelId,
          pageIds: [page.id],
          intakeReasons: ["campaign", "post_tip"],
          opensOn,
          closesOn: null,
          participantsMode: "page_workers",
          participants: [],
          formula: { kind: "equal", params: {} },
          autoPost: true,
          createdByUserId: principal.user.id,
        }, now);
        createdRows.push(inserted);
        affectedPageIds.push(page.id);
      }
    }

    if (potsFrom !== null && affectedPageIds.length > 0) {
      const fromDay = createdRows.map((pot) => pot.opensOn).sort()[0]!;
      await enqueueSaleHomeRefreshForPages(tx, { pageIds: affectedPageIds, fromDay });
    }
    await recordOwnerWrite(tx, principal.user.id, operator, "pot.create_page_pots", {
      potIds: createdRows.map((row) => row.id), skippedPageLabels,
    });
  });

  if (realm === "live") await syncUnroutedPotMatter(app.db, now).catch(() => undefined);
  const [snapshot, pages] = await Promise.all([computeRealmPotSnapshot(app.db, realm), listMatterPageLabels(app.db)]);
  return {
    created: createdRows.map((row) => toPotSummary(row, pages.labelOf, snapshot.statsByPot.get(row.id)!)),
    skippedPageLabels,
    savedAt: now.toISOString(),
  };
}

// ── Pure preview («Распределить») & immutable post («Провести») ──────────────

async function prepareDistributionParts(
  db: Database,
  input: {
    pot: PotRow;
    realmPots: readonly PotRow[];
    potsFrom: string | null;
    requestedParts?: ReadonlyArray<{ transactionId: number; baseMills: number }> | undefined;
  },
): Promise<{
  ok: true;
  parts: Array<{ transactionId: number; pageId: number; pageLabel: string; baseMills: number }>;
  baseMills: number;
  earliestSaleDay: string;
} | {
  ok: false;
  reason: string;
  message: string;
}> {
  if (input.potsFrom === null) {
    return { ok: false, reason: "pots_not_active", message: "Общаки в Workboard ещё не включены (pots_from не задан)" };
  }
  const specs = routingSpecsOf(input.realmPots);

  if (input.requestedParts !== undefined) {
    if (input.requestedParts.length === 0) {
      return { ok: false, reason: "empty_parts", message: "Выберите хотя бы одну продажу" };
    }
    const seenTx = new Set<number>();
    for (const part of input.requestedParts) {
      if (!Number.isSafeInteger(part.baseMills) || part.baseMills <= 0) {
        return { ok: false, reason: "invalid_part_base", message: `База части по продаже ${part.transactionId} должна быть больше нуля` };
      }
      if (seenTx.has(part.transactionId)) {
        return { ok: false, reason: "duplicate_transaction", message: `Продажа ${part.transactionId} указана дважды` };
      }
      seenTx.add(part.transactionId);
    }

    const txIds = input.requestedParts.map((p) => p.transactionId);
    const [homes, distributedAll] = await Promise.all([
      listSaleHomesForPotCheck(db, txIds),
      sumActiveDistributedByTransactions(db, txIds),
    ]);

    const parts: Array<{ transactionId: number; pageId: number; pageLabel: string; baseMills: number }> = [];
    let baseMills = 0;
    for (const req of input.requestedParts) {
      const home = homes.get(req.transactionId);
      if (home === undefined || home.isTest !== input.pot.isTest) {
        return { ok: false, reason: "sale_not_in_pot", message: `Продажа ${req.transactionId} не найдена в этом общаке` };
      }
      const routed = routePotOfSale(home, specs, input.potsFrom);
      if (routed.status !== "routed" || routed.potId !== input.pot.id) {
        return { ok: false, reason: "sale_not_in_pot", message: `Продажа ${req.transactionId} сейчас не относится к общаку «${input.pot.code}»` };
      }
      const already = distributedAll.get(req.transactionId) ?? 0;
      const remaining = home.netMills - already;
      if (remaining < req.baseMills) {
        return {
          ok: false,
          reason: "insufficient_remaining_base",
          message: `По продаже ${req.transactionId} свободный остаток базы (${remaining} mills) меньше запрошенных ${req.baseMills} mills`,
        };
      }
      parts.push({ transactionId: home.transactionId, pageId: home.pageId, pageLabel: home.pageLabel, baseMills: req.baseMills });
      baseMills += req.baseMills;
    }
    return { ok: true, parts, baseMills, earliestSaleDay: [...homes.values()].map((home) => home.day).sort()[0]! };
  }

  // Default: all currently eligible sales routed to this pot with remaining base > 0.
  const sales = await listPotSaleHomesSince(db, {
    sinceDay: input.potsFrom,
    realm: input.pot.isTest ? "test" : "live",
    pageIds: input.pot.pageIds,
  });
  const distributedAll = await sumActiveDistributedByTransactions(db, sales.map((s) => s.transactionId));
  const parts: Array<{ transactionId: number; pageId: number; pageLabel: string; baseMills: number }> = [];
  let baseMills = 0;
  let earliestSaleDay = "";
  for (const sale of sales) {
    const routed = routePotOfSale(sale, specs, input.potsFrom);
    if (routed.status !== "routed" || routed.potId !== input.pot.id) continue;
    const remaining = sale.netMills - (distributedAll.get(sale.transactionId) ?? 0);
    if (remaining <= 0) continue;
    if (!earliestSaleDay) earliestSaleDay = sale.day;
    parts.push({ transactionId: sale.transactionId, pageId: sale.pageId, pageLabel: sale.pageLabel, baseMills: remaining });
    baseMills += remaining;
  }
  if (parts.length === 0 || baseMills <= 0) {
    return { ok: false, reason: "empty_balance", message: "Нет свободного остатка базы для распределения" };
  }
  return { ok: true, parts, baseMills, earliestSaleDay };
}

async function unknownFormulaPeople(db: Database, realm: "live" | "test", formula: PotFormula, recipients: readonly string[]) {
  const people = await listPersonRows(db, realm);
  const eligible = new Set(people.filter((p) => p.kind === "human"
    && (formula.kind === "equal" || p.role === "chatter" || p.role === "team_lead")).map((p) => p.code));
  const entries = formula.kind === "manual" ? formula.params.shares : formula.params.weights;
  const named = entries && typeof entries === "object" ? Object.keys(entries).map((code) => code.trim()).filter(Boolean) : [];
  return [...new Set([...recipients, ...named])].filter((code) => !eligible.has(code));
}

/** Pure preview («Распределить»): zero DB writes. */
export async function previewPotDistribution(
  app: PotsApp,
  principal: HumanAuthPrincipal,
  potId: number,
  body: { day?: string | undefined; formula?: PotFormula | undefined; parts?: ReadonlyArray<{ transactionId: number; baseMills: number }> | undefined },
  now: Date = new Date(),
): Promise<PotDistributionPreviewResponse> {
  const pot = await findPotById(app.db, potId);
  if (pot === null) throw new NotFoundError("Общак не найден");
  requireSameRealm(principal, pot.isTest, () => new NotFoundError("Общак не найден"));

  const realm = pot.isTest ? "test" : "live";
  const day = body.day ?? moscowDayOf(now.getTime());
  const formula = body.formula ?? pot.formula;
  const [{ potsFrom }, realmPots, participantCtx] = await Promise.all([
    readPotsSwitch(app.db),
    listPots(app.db, realm),
    loadParticipantContext(app.db, realm, day),
  ]);

  const participants = resolvePotParticipants({
    day,
    mode: pot.participantsMode,
    pageIds: pot.pageIds,
    listed: pot.participants,
    people: participantCtx.people,
    workingPages: participantCtx.workingPages,
    slots: participantCtx.slots,
  });

  if (pot.state !== "open") {
    return {
      potId: pot.id,
      day,
      formula,
      participants,
      parts: [],
      baseMills: 0,
      lines: [],
      error: { reason: "pot_closed", message: "Общак закрыт" },
      serverNow: now.toISOString(),
    };
  }
  if (potsFrom !== null && day < potsFrom) {
    return {
      potId: pot.id,
      day,
      formula,
      participants,
      parts: [],
      baseMills: 0,
      lines: [],
      error: { reason: "before_pots_from", message: `День раздачи ${day} раньше даты включения общаков ${potsFrom}` },
      serverNow: now.toISOString(),
    };
  }

  const prepared = await prepareDistributionParts(app.db, { pot, realmPots, potsFrom, requestedParts: body.parts });
  const dayError = prepared.ok && (day < prepared.earliestSaleDay || day > moscowDayOf(now.getTime()));
  if (!prepared.ok || dayError) {
    return {
      potId: pot.id,
      day,
      formula,
      participants,
      parts: [],
      baseMills: 0,
      lines: [],
      error: prepared.ok ? { reason: "invalid_distribution_day", message: "Проверьте день раздачи" } : { reason: prepared.reason, message: prepared.message },
      serverNow: now.toISOString(),
    };
  }

  const computed = computePotDistributionLines({ baseMills: prepared.baseMills, formula, participants });
  if (!computed.ok) {
    return {
      potId: pot.id,
      day,
      formula,
      participants,
      parts: prepared.parts,
      baseMills: prepared.baseMills,
      lines: [],
      error: { reason: computed.reason, message: computed.message },
      serverNow: now.toISOString(),
    };
  }

  // Check named recipients even when a zero share or an unused weight produced no line.
  if (computed.normalizedFormula.kind !== "equal") {
    const unknown = await unknownFormulaPeople(app.db, realm, formula, computed.lines.map((line) => line.personCode));
    if (unknown.length > 0) {
      return {
        potId: pot.id,
        day,
        formula: computed.normalizedFormula,
        participants,
        parts: prepared.parts,
        baseMills: prepared.baseMills,
        lines: [],
        error: { reason: "person_unknown", message: `Неизвестные коды людей: ${unknown.join(", ")}` },
        serverNow: now.toISOString(),
      };
    }
  }

  return {
    potId: pot.id,
    day,
    formula: computed.normalizedFormula,
    participants,
    parts: prepared.parts,
    baseMills: prepared.baseMills,
    lines: computed.lines,
    error: null,
    serverNow: now.toISOString(),
  };
}

/**
 * Immutable post («Провести») under global `lockWorkboardPots`:
 * verifies pot is open, every part routes to this pot on day >= `pots_from`, global remaining base >= part.base_mills
 * across ALL pots, and Σ parts === Σ lines === base_mills > 0.
 */
export async function postPotDistribution(
  app: PotsApp,
  principal: HumanAuthPrincipal,
  potId: number,
  body: { day?: string | undefined; formula?: PotFormula | undefined; parts?: ReadonlyArray<{ transactionId: number; baseMills: number }> | undefined },
  now: Date = new Date(),
  operator?: OperatorContext,
): Promise<{ distribution: PotDistributionItem; savedAt: string }> {
  const preCheck = await findPotById(app.db, potId);
  if (preCheck === null) throw new NotFoundError("Общак не найден");
  requireSameRealm(principal, preCheck.isTest, () => new NotFoundError("Общак не найден"));

  const realm = preCheck.isTest ? "test" : "live";
  const day = body.day ?? moscowDayOf(now.getTime());

  const created = await app.db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await lockWorkboardPots(tx);

    const pot = await findPotById(tx, potId);
    if (pot === null) throw new NotFoundError("Общак не найден");
    if (pot.state !== "open") throw new ConflictError("Закрытый общак нельзя распределять", { reason: "pot_closed" });

    const { potsFrom } = await readPotsSwitch(tx);
    if (potsFrom === null) throw new ConflictError("Общаки в Workboard ещё не включены", { reason: "pots_not_active" });
    if (day < potsFrom) {
      throw new ConflictError(`День раздачи ${day} раньше даты включения общаков ${potsFrom}`, { reason: "before_pots_from" });
    }

    const realmPots = await listPots(tx, realm);
    const prepared = await prepareDistributionParts(tx, { pot, realmPots, potsFrom, requestedParts: body.parts });
    if (!prepared.ok) {
      throw new ConflictError(prepared.message, { reason: prepared.reason });
    }

    if (day > moscowDayOf(now.getTime()) || day < prepared.earliestSaleDay) {
      throw new BadRequestError("День раздачи должен быть между первой продажей и сегодняшним днём", { reason: "invalid_distribution_day" });
    }
    const participantCtx = await loadParticipantContext(tx, realm, day);
    const participants = resolvePotParticipants({
      day,
      mode: pot.participantsMode,
      pageIds: pot.pageIds,
      listed: pot.participants,
      people: participantCtx.people,
      workingPages: participantCtx.workingPages,
      slots: participantCtx.slots,
    });

    const formula = body.formula ?? pot.formula;
    const computed = computePotDistributionLines({ baseMills: prepared.baseMills, formula, participants });
    if (!computed.ok) {
      throw new ConflictError(computed.message, { reason: computed.reason });
    }

    const unknown = await unknownFormulaPeople(tx, realm, formula, computed.lines.map((line) => line.personCode));
    if (unknown.length > 0) {
      throw new BadRequestError(`Неизвестные коды людей: ${unknown.join(", ")}`, { reason: "person_unknown" });
    }

    const linesTotal = computed.lines.reduce((sum, line) => sum + line.baseMills, 0);
    const partsTotal = prepared.parts.reduce((sum, part) => sum + part.baseMills, 0);
    if (linesTotal !== prepared.baseMills || partsTotal !== prepared.baseMills || prepared.baseMills <= 0) {
      throw new ConflictError("Инвариант суммы раздачи нарушен", { reason: "sum_invariant_failed" });
    }

    const distribution = await insertPotDistribution(tx, {
      potId: pot.id,
      day,
      formula: computed.normalizedFormula,
      baseMills: prepared.baseMills,
      lines: computed.lines,
      parts: prepared.parts.map((part) => ({ transactionId: part.transactionId, pageId: part.pageId, baseMills: part.baseMills })),
      postedByUserId: principal.user.id,
      agentKeyId: operator?.agentKeyId ?? null,
      postedAt: now,
    });
    await recordOwnerWrite(tx, principal.user.id, operator, "pot.distribution_posted", {
      potId, code: pot.code, distributionId: distribution.id, day, baseMills: distribution.baseMills,
    });
    return distribution;
  });

  if (realm === "live") await syncUnroutedPotMatter(app.db, now).catch(() => undefined);
  const [wire] = await toDistributionWires(app.db, [created]);
  return { distribution: wire!, savedAt: now.toISOString() };
}

async function syncExcessBaseMatters(tx: Database, checkedHomes: ReadonlyMap<number, PotSaleHomeRow>, now: Date) {
  if (!checkedHomes.size) return 0;
  let mattersTouched = 0;
  const open = new Set((await listOpenMattersOfKinds(tx, ["pot.excess_base"])).map((matter) => matter.key));
  const totals = await sumActiveDistributedByTransactions(tx, [...checkedHomes.keys()]);
  for (const sale of checkedHomes.values()) {
    if (sale.isTest) continue;
    const distributed = totals.get(sale.transactionId) ?? 0;
    const key = `pot.excess_base:${sale.transactionId}`;
    if (distributed > sale.netMills) {
      const opened = await openMatter(tx, {
        key, kind: "pot.excess_base", source: "server", object: null, owner: { role: "owner" }, money: true,
        title: "Распределённая база превышает уточнённую сумму продажи", pageIds: [sale.pageId],
        evidence: { transactionId: sale.transactionId, distributed, netMills: sale.netMills },
        link: "/workboard/money/pots",
      }, SYSTEM, now);
      if (opened.transition !== "unchanged") mattersTouched += 1;
    } else if (open.has(key)) {
      const closed = await closeMatter(tx, { key, how: "resolved", writer: "server" }, SYSTEM, now);
      if (closed.transition === "closed") mattersTouched += 1;
    }
  }
  return mattersTouched;
}

/** Reverses a posted distribution once with a mandatory reason, restoring remaining base and emitting K2 `reversed`. */
export async function reversePotDistribution(
  app: PotsApp,
  principal: HumanAuthPrincipal,
  distributionId: number,
  body: { reason: string },
  now: Date = new Date(),
  operator?: OperatorContext,
): Promise<{ distribution: PotDistributionItem; savedAt: string }> {
  const reason = body.reason.trim();
  if (reason === "") throw new BadRequestError("Укажите причину сторно", { reason: "reason_required" });

  const existing = await findPotDistributionById(app.db, distributionId);
  if (existing === null) throw new NotFoundError("Раздача не найдена");
  const reversed = await app.db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await lockWorkboardPots(tx);
    const pot = await findPotById(tx, existing.potId);
    if (pot === null) throw new NotFoundError("Общак не найден");
    requireSameRealm(principal, pot.isTest, () => new NotFoundError("Раздача не найдена"));
    const ok = await reversePotDistributionRow(tx, {
      distributionId,
      reversedByUserId: principal.user.id,
      reason,
      at: now,
    });
    if (!ok) throw new ConflictError("Раздача уже сторнирована", { reason: "already_reversed" });
    // Always hold reversed sales against future auto-posts (even if the pot is currently manual and later switched
    // to autoPost, or if participants/routing later change); manual postPotDistribution remains allowed.
    const participantsByDay = new Map<string, string[]>();
    for (const part of existing.parts) {
      const day = part.saleDay ?? existing.day;
      let participants = participantsByDay.get(day);
      if (!participants) {
        const ctx = await loadParticipantContext(tx, realmOf(principal), day);
        participants = resolvePotParticipants({
          ...ctx, day, mode: pot.participantsMode, pageIds: pot.pageIds, listed: pot.participants,
        });
        participantsByDay.set(day, participants);
      }
      await holdPotAutoPost(tx, part.transactionId, pot.id, participants);
    }
    if (!pot.isTest) {
      const homes = await listSaleHomesForPotCheck(tx, existing.parts.map((part) => part.transactionId));
      await syncExcessBaseMatters(tx, homes, now);
      await closeMatter(tx, { key: `${POT_SALE_LEFT_KIND}:${distributionId}`, how: "resolved", writer: "server" }, SYSTEM, now);
    }
    await recordOwnerWrite(tx, principal.user.id, operator, "pot.distribution_reversed", {
      distributionId, potId: pot.id, reversalReason: reason,
    });
    return (await findPotDistributionById(tx, distributionId))!;
  });

  if (realmOf(principal) === "live") await syncUnroutedPotMatter(app.db, now).catch(() => undefined);
  const [wire] = await toDistributionWires(app.db, [reversed]);
  return { distribution: wire!, savedAt: now.toISOString() };
}

// ── Auto-post & reconciliation (called from `refreshSaleHomesForDay`) ────────

export interface ReconcilePotsDayResult {
  autoPosted: number;
  autoReversed: number;
  mattersTouched: number;
}

/**
 * Reconciles Workboard pots for Moscow `day` INSIDE `refreshSaleHomesForDay`'s transaction:
 *  - strictly follows lock order `settlements -> refresh_day -> pots` (`lockWorkboardPots`);
 *  - no-op while `pots_from` is null or `day < pots_from`;
 *  - if a sale moved out of a pot with a non-reversed part:
 *      - `auto_post` pot -> auto-reverses (`reversed_reason = 'sale_left_pot'`), emitting K2 `reversed`;
 *      - manual pot -> opens an owner matter (`pot.sale_left:<distributionId>`) so owner reverses explicitly;
 *  - for each sale on `day` routed to an open `auto_post = true` pot with remaining base > 0:
 *      - computes `equal` lines on `day` and posts immediately (`day = saleDay`, `posted_by_user_id = null`);
 *      - if 0 participants -> opens owner matter (`pot.no_participants:<code>:<day>`) instead of posting empty;
 *  - syncs the single aggregate `pot.unrouted:open` health matter for the live realm.
 */
export async function reconcilePotsOfDay(
  tx: Database,
  day: string,
  now: Date,
): Promise<ReconcilePotsDayResult> {
  await lockWorkboardPots(tx);
  const { potsFrom } = await readPotsSwitch(tx);
  if (potsFrom === null || day < potsFrom) {
    return { autoPosted: 0, autoReversed: 0, mattersTouched: 0 };
  }

  let autoPosted = 0;
  let autoReversed = 0;
  let mattersTouched = 0;

  const allPots = await listPots(tx, "both");
  const potsByRealm: Record<"live" | "test", PotRow[]> = {
    live: allPots.filter((p) => !p.isTest),
    test: allPots.filter((p) => p.isTest),
  };
  const specsByRealm: Record<"live" | "test", PotRoutingSpec[]> = {
    live: routingSpecsOf(potsByRealm.live),
    test: routingSpecsOf(potsByRealm.test),
  };

  // 1. Detect sales that left a pot with an active distribution part on `day`.
  const activeParts = await listActivePotPartsForDay(tx, day);
  const checkedHomes = await listSaleHomesForPotCheck(tx, activeParts.map((part) => part.transactionId));
  const reversedDistIds = new Set<number>();
  const needsOwnerReview = new Map<number, { potCode: string; potName: string; pageIds: Set<number>; txIds: number[] }>();
  const checkedLiveDistIds = new Set<number>();

  for (const part of activeParts) {
    const currentHome = checkedHomes.get(part.transactionId);
    const left = hasSaleLeftPot(part.potCode, currentHome, potsFrom);
    if (!part.isTest) checkedLiveDistIds.add(part.distributionId);
    if (!left) continue;

    if (currentHome !== undefined && part.autoPosted && currentHome.canonicalType !== "chargeback") {
      if (!reversedDistIds.has(part.distributionId)) {
        const ok = await reversePotDistributionRow(tx, {
          distributionId: part.distributionId,
          reversedByUserId: null,
          reason: "sale_left_pot",
          at: now,
        });
        if (ok) autoReversed += 1;
        reversedDistIds.add(part.distributionId);
      }
    } else if (!part.isTest) {
      const entry = needsOwnerReview.get(part.distributionId) ?? {
        potCode: part.potCode,
        potName: part.potName,
        pageIds: new Set<number>(),
        txIds: [],
      };
      entry.pageIds.add(part.pageId);
      entry.txIds.push(part.transactionId);
      needsOwnerReview.set(part.distributionId, entry);
    }
  }

  for (const [distId, info] of needsOwnerReview) {
    const opened = await openMatter(tx, {
      key: `${POT_SALE_LEFT_KIND}:${distId}`,
      kind: POT_SALE_LEFT_KIND,
      source: "server",
      title: `Продажа ушла из проведённой раздачи #${distId} общака «${info.potName}»`,
      object: null,
      pageIds: [...info.pageIds],
      owner: { role: "owner" },
      money: true,
      evidence: { distributionId: distId, potCode: info.potCode, transactionIds: info.txIds },
      link: `/workboard/money/pots?pot=${encodeURIComponent(info.potCode)}`,
    }, SYSTEM, now);
    if (opened.transition !== "unchanged") mattersTouched += 1;
  }
  for (const matter of await listOpenMattersOfKinds(tx, [POT_SALE_LEFT_KIND])) {
    const distId = Number(matter.evidence.distributionId);
    if (!checkedLiveDistIds.has(distId) || needsOwnerReview.has(distId)) continue;
    const closed = await closeMatter(tx, { key: matter.key, how: "resolved", writer: "server" }, SYSTEM, now);
    if (closed.transition === "closed") mattersTouched += 1;
  }

  mattersTouched += await syncExcessBaseMatters(tx, checkedHomes, now);

  // 2. Auto-post remaining base for sales on `day` routed to open `auto_post = true` pots.
  const dayPotSales = await listPotSaleHomesSince(tx, { sinceDay: day, day, realm: "both" });
  const distributedNow = await sumActiveDistributedByTransactions(tx, dayPotSales.map((s) => s.transactionId));
  const participantCtxCache = new Map<"live" | "test", ParticipantLookupContext>();
  const potById = new Map(allPots.map((p) => [p.id, p]));
  const wantNoParticipants = new Set<string>();

  const heldTransactions = new Set<number>();
  const holds = await listPotAutoPostHolds(tx, day);
  const heldHomes = await listSaleHomesForPotCheck(tx, holds.map((hold) => hold.transactionId));
  async function participantsOf(pot: PotRow) {
    const realm = pot.isTest ? "test" : "live";
    let ctx = participantCtxCache.get(realm);
    if (ctx === undefined) {
      ctx = await loadParticipantContext(tx, realm, day);
      participantCtxCache.set(realm, ctx);
    }
    return resolvePotParticipants({ ...ctx, day, mode: pot.participantsMode, pageIds: pot.pageIds, listed: pot.participants });
  }
  for (const hold of holds) {
    const sale = heldHomes.get(hold.transactionId);
    // Keep the manual-reversal hold as long as the sale stays in pots, regardless of pot or participant edits;
    // only clear it if the sale leaves pots altogether.
    if (sale !== undefined && sale.home === "pot") {
      heldTransactions.add(hold.transactionId);
      continue;
    }
    await clearPotAutoPostHold(tx, hold.transactionId, hold.potId);
  }

  for (const sale of dayPotSales) {
    if (heldTransactions.has(sale.transactionId)) continue;
    const realm = sale.isTest ? "test" : "live";
    const routed = routePotOfSale(sale, specsByRealm[realm], potsFrom);
    if (routed.status !== "routed") continue;
    const pot = potById.get(routed.potId);
    if (pot === undefined || pot.state !== "open" || !pot.autoPost) continue;

    const already = distributedNow.get(sale.transactionId) ?? 0;
    const remaining = sale.netMills - already;
    if (remaining <= 0) continue;

    const participants = await participantsOf(pot);
    const noPartKey = `${POT_NO_PARTICIPANTS_KIND}:${pot.code}:${day}`;
    if (participants.length === 0) {
      if (!pot.isTest) {
        wantNoParticipants.add(noPartKey);
        const opened = await openMatter(tx, {
          key: noPartKey,
          kind: POT_NO_PARTICIPANTS_KIND,
          source: "server",
          title: `Нет участников общака «${pot.name}» на ${dayWords(day)}`,
          object: null,
          pageIds: pot.pageIds,
          owner: { role: "owner" },
          money: true,
          evidence: { potCode: pot.code, day, transactionId: sale.transactionId },
          link: `/workboard/money/pots?pot=${encodeURIComponent(pot.code)}`,
        }, SYSTEM, now);
        if (opened.transition !== "unchanged") mattersTouched += 1;
      }
      continue;
    }

    const computed = computePotDistributionLines({
      baseMills: remaining,
      formula: { kind: "equal", params: {} },
      participants,
    });
    if (!computed.ok) continue;

    await insertPotDistribution(tx, {
      potId: pot.id,
      day,
      formula: computed.normalizedFormula,
      baseMills: remaining,
      lines: computed.lines,
      parts: [{ transactionId: sale.transactionId, pageId: sale.pageId, baseMills: remaining }],
      postedByUserId: null,
      postedAt: now,
    });
    distributedNow.set(sale.transactionId, already + remaining);
    autoPosted += 1;
  }

  // Close resolved `pot.no_participants:*:<day>` matters for this day.
  const openNoParticipants = await listOpenMattersOfKinds(tx, [POT_NO_PARTICIPANTS_KIND]);
  for (const matter of openNoParticipants) {
    if (!matter.key.endsWith(`:${day}`) || wantNoParticipants.has(matter.key)) continue;
    const closed = await closeMatter(tx, { key: matter.key, how: "resolved", writer: "server" }, SYSTEM, now);
    if (closed.transition === "closed") mattersTouched += 1;
  }

  // 3. Keep the single aggregate `pot.unrouted:open` health matter in sync for the live realm.
  mattersTouched += await syncUnroutedPotMatter(tx, now);

  return { autoPosted, autoReversed, mattersTouched };
}
