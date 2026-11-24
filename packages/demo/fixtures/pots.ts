import type {
  KernelOperationResponse,
  PotCreateBody,
  PotDistributionItem,
  PotDistributionLine,
  PotFormula,
  PotSummary,
  PotUpdateBody,
} from "@agency_hub_core/contracts";

import { millsFromDollars, millsFromInteger, millsToNumber } from "@agency_hub_core/shared";

import { demoError, type DemoHandlers } from "../core.ts";
import { DEMO_DATA_PAGES, DEMO_MODELS, DEMO_USERS } from "../world.ts";

/**
 * Workboard pots (0443, H11) in the demo, kept in memory until restart.
 * Synthetic demo models, pages, people and amounts only (from `../world.ts`).
 */

interface DemoPotRecord {
  id: number;
  code: string;
  name: string;
  modelId: number;
  modelSlug: string;
  modelName: string;
  pageIds: number[];
  intakeReasons: Array<"post_tip" | "campaign">;
  opensOn: string;
  closesOn: string | null;
  participantsMode: "page_workers" | "listed";
  participants: Array<{ personCode: string; fromDay: string; toDay: string | null }>;
  formula: PotFormula;
  autoPost: boolean;
  state: "open" | "closed";
  createdAt: string;
  updatedAt: string;
}

interface DemoPotSale {
  transactionId: number;
  pageId: number;
  pageLabel: string;
  kind: string;
  occurredAt: string;
  day: string;
  netMills: number;
  reason: string;
  potCode: string;
}

const DEMO_PEOPLE = DEMO_USERS.filter((u) => u.role !== "owner").map((u) => ({
  code: u.username,
  displayName: u.name,
  role: u.role,
  state: u.active ? "active" : "left",
}));

const DEMO_CATALOG_MODELS = DEMO_MODELS.map((m) => ({
  id: m.id,
  slug: m.slug,
  name: m.name,
  pages: DEMO_DATA_PAGES.filter((p) => p.modelSlug === m.slug).map((p) => ({
    id: p.id,
    label: p.label,
    platform: p.platform,
  })),
}));

const PAGE_LABEL_BY_ID = new Map(DEMO_DATA_PAGES.map((p) => [p.id, p.label]));

let nextPotId = 10;
let nextDistId = 200;

const demoPots: DemoPotRecord[] = [
  {
    id: 1,
    code: "page-mia-1",
    name: "Общак mia-1",
    modelId: 1,
    modelSlug: "mia-hart",
    modelName: "Mia Hart",
    pageIds: [11],
    intakeReasons: ["campaign", "post_tip"],
    opensOn: "2026-12-01",
    closesOn: null,
    participantsMode: "page_workers",
    participants: [],
    formula: { kind: "equal", params: {} },
    autoPost: true,
    state: "open",
    createdAt: "2026-12-01T09:00:00.000Z",
    updatedAt: "2026-12-01T09:00:00.000Z",
  },
  {
    id: 2,
    code: "mia-winter-promo",
    name: "Зимний ивент Mia",
    modelId: 1,
    modelSlug: "mia-hart",
    modelName: "Mia Hart",
    pageIds: [11, 12],
    intakeReasons: [],
    opensOn: "2026-12-01",
    closesOn: "2026-12-15",
    participantsMode: "listed",
    participants: [
      { personCode: "alex.k", fromDay: "2026-12-01", toDay: null },
      { personCode: "kate.v", fromDay: "2026-12-01", toDay: null },
    ],
    formula: { kind: "weights", params: { weights: { "alex.k": 2, "kate.v": 1 } } },
    autoPost: false,
    state: "open",
    createdAt: "2026-12-01T09:05:00.000Z",
    updatedAt: "2026-12-01T09:05:00.000Z",
  },
];

const demoPotSales: DemoPotSale[] = [
  {
    transactionId: 910_001,
    pageId: 11,
    pageLabel: "mia-1",
    kind: "tip",
    occurredAt: "2026-12-02T11:20:00.000Z",
    day: "2026-12-02",
    netMills: 40_000,
    reason: "post_tip",
    potCode: "page-mia-1",
  },
  {
    transactionId: 910_002,
    pageId: 11,
    pageLabel: "mia-1",
    kind: "message_purchase",
    occurredAt: "2026-12-02T14:40:00.000Z",
    day: "2026-12-02",
    netMills: 90_000,
    reason: "decision",
    potCode: "mia-winter-promo",
  },
  {
    transactionId: 910_003,
    pageId: 12,
    pageLabel: "mia-2",
    kind: "tip",
    occurredAt: "2026-12-03T16:10:00.000Z",
    day: "2026-12-03",
    netMills: 60_000,
    reason: "decision",
    potCode: "mia-winter-promo",
  },
];

const demoDistributions: PotDistributionItem[] = [
  {
    id: 101,
    potId: 1,
    day: "2026-12-02",
    formula: { kind: "equal", params: {} },
    baseMills: 40_000,
    lines: [
      { personCode: "alex.k", baseMills: 20_000, basis: "1/2" },
      { personCode: "kate.v", baseMills: 20_000, basis: "1/2" },
    ],
    parts: [{ transactionId: 910_001, pageId: 11, pageLabel: "mia-1", baseMills: 40_000 }],
    postedAt: "2026-12-02T11:25:00.000Z",
    postedByName: null,
    reversedAt: null,
    reversedByName: null,
    reversedReason: null,
  },
];

function activeDistributedByTx(): Map<number, number> {
  const out = new Map<number, number>();
  for (const dist of demoDistributions) {
    if (dist.reversedAt !== null) continue;
    for (const part of dist.parts) {
      out.set(part.transactionId, (out.get(part.transactionId) ?? 0) + part.baseMills);
    }
  }
  return out;
}

function activeParticipantsOf(pot: DemoPotRecord): string[] {
  if (pot.participantsMode === "listed") {
    return [...new Set(pot.participants.map((p) => p.personCode))].sort();
  }
  const labels = new Set(pot.pageIds.map((id) => PAGE_LABEL_BY_ID.get(id)).filter((v): v is string => v !== undefined));
  return DEMO_USERS
    .filter((u) => u.active && u.role === "chatter" && u.pages.some((p) => labels.has(p)))
    .map((u) => u.username)
    .sort();
}

function summarizePot(pot: DemoPotRecord): PotSummary {
  const distAll = activeDistributedByTx();
  const potSales = demoPotSales.filter((s) => s.potCode === pot.code);
  const eligibleBaseMills = potSales.reduce((sum, s) => sum + s.netMills, 0);
  const balanceMills = potSales.reduce((sum, s) => sum + Math.max(0, s.netMills - (distAll.get(s.transactionId) ?? 0)), 0);
  const activeDists = demoDistributions.filter((d) => d.potId === pot.id && d.reversedAt === null);
  const postedBaseMills = activeDists.reduce((sum, d) => sum + d.baseMills, 0);
  return {
    id: pot.id,
    code: pot.code,
    name: pot.name,
    modelId: pot.modelId,
    modelSlug: pot.modelSlug,
    modelName: pot.modelName,
    pageIds: pot.pageIds,
    pageLabels: pot.pageIds.map((id) => PAGE_LABEL_BY_ID.get(id) ?? `#${id}`),
    intakeReasons: pot.intakeReasons,
    opensOn: pot.opensOn,
    closesOn: pot.closesOn,
    participantsMode: pot.participantsMode,
    participants: pot.participants,
    formula: pot.formula,
    autoPost: pot.autoPost,
    state: pot.state,
    eligibleBaseMills,
    postedBaseMills,
    balanceMills,
    eligibleCount: potSales.length,
    distributionsCount: activeDists.length,
    createdAt: pot.createdAt,
    updatedAt: pot.updatedAt,
  };
}

function computeDemoLines(baseMills: number, formula: PotFormula, participants: string[]): PotDistributionLine[] {
  const sorted = [...new Set(participants)].sort();
  if (sorted.length === 0) return [];
  if (formula.kind === "manual") {
    const raw = (formula.params.shares ?? {}) as Record<string, number>;
    return Object.entries(raw)
      .filter(([, v]) => Number(v) > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([personCode, val]) => ({ personCode, baseMills: Math.trunc(Number(val)), basis: "вручную" }));
  }
  if (formula.kind === "weights") {
    const raw = (formula.params.weights ?? {}) as Record<string, number>;
    const totalBase = millsFromInteger(baseMills);
    const pairs = sorted.map((code) => {
      const weight = Number(raw[code] ?? 1);
      const scaled = millsFromDollars(weight > 0 ? weight : 1);
      return { code, weight: weight > 0 ? weight : 1, scaled: scaled > 0n ? scaled : 1n };
    });
    const totalScaled = pairs.reduce((s, p) => s + p.scaled, 0n);
    const totalDisplay = pairs.reduce((s, x) => s + x.weight, 0);
    let distributed = 0n;
    const rows = pairs.map((p) => {
      const share = (totalBase * p.scaled) / totalScaled;
      distributed += share;
      return { personCode: p.code, baseMills: millsToNumber(share), basis: `по весам (${p.weight}/${totalDisplay})` };
    });
    const rem = Number(totalBase - distributed);
    for (let i = 0; i < rem; i++) rows[i % rows.length]!.baseMills += 1;
    return rows;
  }
  const each = Math.floor(baseMills / sorted.length);
  const rem = baseMills - each * sorted.length;
  return sorted.map((personCode, idx) => ({
    personCode,
    baseMills: each + (idx < rem ? 1 : 0),
    basis: `1/${sorted.length}`,
  }));
}

export const potsHandlers: DemoHandlers = {
  potsList: ({ now }): KernelOperationResponse<"potsList"> => ({
    potsFrom: "2026-12-01",
    pots: demoPots.map(summarizePot),
    unroutedCount: 0,
    unroutedBaseMills: 0,
    unrouted: [],
    models: DEMO_CATALOG_MODELS,
    people: DEMO_PEOPLE,
    legacyArchive: {
      available: true,
      error: null,
      pots: [
        {
          slug: "autumn-launch",
          name: "Осенний запуск (архив)",
          model: "mia-hart",
          pages: ["mia-1"],
          startsAt: "2026-11-01",
          endsAt: "2026-11-30",
          status: "closed",
          sales: 12,
          netMills: 320_000,
          participants: [{ person: "alex.k", from: "2026-11-01", to: "2026-11-30" }],
        },
      ],
    },
    serverNow: now.toISOString(),
  }),

  potDetail: ({ params, now }): KernelOperationResponse<"potDetail"> | ReturnType<typeof demoError> => {
    const potId = Number(params.potId);
    const pot = demoPots.find((p) => p.id === potId);
    if (!pot) return demoError(404, "not_found", "Общак не найден");
    const distAll = activeDistributedByTx();
    const distHere = new Map<number, number>();
    for (const d of demoDistributions) {
      if (d.potId !== pot.id || d.reversedAt !== null) continue;
      for (const p of d.parts) distHere.set(p.transactionId, (distHere.get(p.transactionId) ?? 0) + p.baseMills);
    }
    return {
      potsFrom: "2026-12-01",
      pot: summarizePot(pot),
      activeParticipants: activeParticipantsOf(pot),
      sales: demoPotSales
        .filter((s) => s.potCode === pot.code)
        .map((s) => {
          const all = distAll.get(s.transactionId) ?? 0;
          const here = distHere.get(s.transactionId) ?? 0;
          return {
            transactionId: s.transactionId,
            pageId: s.pageId,
            pageLabel: s.pageLabel,
            kind: s.kind,
            occurredAt: s.occurredAt,
            day: s.day,
            netMills: s.netMills,
            distributedElsewhereMills: Math.max(0, all - here),
            distributedHereMills: here,
            remainingBaseMills: Math.max(0, s.netMills - all),
            reason: s.reason,
          };
        }),
      distributions: demoDistributions.filter((d) => d.potId === pot.id).sort((a, b) => b.id - a.id),
      serverNow: now.toISOString(),
    };
  },

  potCreate: ({ body, now }): KernelOperationResponse<"potCreate"> | ReturnType<typeof demoError> => {
    const input = body as PotCreateBody;
    if (demoPots.some((p) => p.code === input.code)) {
      return demoError(409, "code_taken", `Общак «${input.code}» уже существует`);
    }
    const model = DEMO_MODELS.find((m) => m.id === input.modelId);
    if (!model) return demoError(400, "model_not_found", "Модель не найдена");
    const rec: DemoPotRecord = {
      id: nextPotId++,
      code: input.code,
      name: input.name,
      modelId: model.id,
      modelSlug: model.slug,
      modelName: model.name,
      pageIds: [...input.pageIds],
      intakeReasons: [...(input.intakeReasons ?? [])],
      opensOn: input.opensOn,
      closesOn: input.closesOn ?? null,
      participantsMode: input.participantsMode,
      participants: input.participants ?? [],
      formula: input.formula,
      autoPost: input.autoPost ?? false,
      state: "open",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    demoPots.push(rec);
    return { pot: summarizePot(rec), savedAt: now.toISOString() };
  },

  potUpdate: ({ params, body, now }): KernelOperationResponse<"potUpdate"> | ReturnType<typeof demoError> => {
    const pot = demoPots.find((p) => p.id === Number(params.potId));
    if (!pot) return demoError(404, "not_found", "Общак не найден");
    if (pot.state !== "open") return demoError(409, "pot_closed", "Закрытый общак нельзя редактировать");
    const patch = body as PotUpdateBody;
    if (patch.name !== undefined) pot.name = patch.name;
    if (patch.pageIds !== undefined) pot.pageIds = [...patch.pageIds];
    if (patch.intakeReasons !== undefined) pot.intakeReasons = [...patch.intakeReasons];
    if (patch.opensOn !== undefined) pot.opensOn = patch.opensOn;
    if (patch.closesOn !== undefined) pot.closesOn = patch.closesOn;
    if (patch.participantsMode !== undefined) pot.participantsMode = patch.participantsMode;
    if (patch.participants !== undefined) pot.participants = patch.participants;
    if (patch.formula !== undefined) pot.formula = patch.formula;
    if (patch.autoPost !== undefined) pot.autoPost = patch.autoPost;
    pot.updatedAt = now.toISOString();
    return { pot: summarizePot(pot), savedAt: now.toISOString() };
  },

  potClose: ({ params, now }): KernelOperationResponse<"potClose"> | ReturnType<typeof demoError> => {
    const pot = demoPots.find((p) => p.id === Number(params.potId));
    if (!pot) return demoError(404, "not_found", "Общак не найден");
    pot.state = "closed";
    pot.updatedAt = now.toISOString();
    return { pot: summarizePot(pot), savedAt: now.toISOString() };
  },

  potsCreatePagePots: ({ now }): KernelOperationResponse<"potsCreatePagePots"> => {
    const created: PotSummary[] = [];
    const skippedPageLabels: string[] = [];
    for (const model of DEMO_CATALOG_MODELS) {
      for (const page of model.pages) {
        const covered = demoPots.some(
          (p) => p.state === "open" && p.pageIds.includes(page.id) && p.intakeReasons.includes("post_tip") && p.intakeReasons.includes("campaign"),
        );
        if (covered) {
          skippedPageLabels.push(page.label);
          continue;
        }
        const rec: DemoPotRecord = {
          id: nextPotId++,
          code: `page-${page.label}`,
          name: `Общак ${page.label}`,
          modelId: model.id,
          modelSlug: model.slug,
          modelName: model.name,
          pageIds: [page.id],
          intakeReasons: ["campaign", "post_tip"],
          opensOn: "2026-12-01",
          closesOn: null,
          participantsMode: "page_workers",
          participants: [],
          formula: { kind: "equal", params: {} },
          autoPost: true,
          state: "open",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        };
        demoPots.push(rec);
        created.push(summarizePot(rec));
      }
    }
    return { created, skippedPageLabels, savedAt: now.toISOString() };
  },

  potDistributionPreview: ({ params, body, now }): KernelOperationResponse<"potDistributionPreview"> | ReturnType<typeof demoError> => {
    const pot = demoPots.find((p) => p.id === Number(params.potId));
    if (!pot) return demoError(404, "not_found", "Общак не найден");
    const req = (body ?? {}) as { day?: string; formula?: PotFormula; parts?: Array<{ transactionId: number; baseMills: number }> };
    const day = req.day ?? "2026-12-03";
    const formula = req.formula ?? pot.formula;
    const participants = activeParticipantsOf(pot);
    const distAll = activeDistributedByTx();
    const parts = (req.parts ?? demoPotSales.filter((s) => s.potCode === pot.code).map((s) => ({
      transactionId: s.transactionId,
      baseMills: Math.max(0, s.netMills - (distAll.get(s.transactionId) ?? 0)),
    }))).filter((p) => p.baseMills > 0).map((p) => {
      const sale = demoPotSales.find((s) => s.transactionId === p.transactionId)!;
      return { transactionId: p.transactionId, pageId: sale.pageId, pageLabel: sale.pageLabel, baseMills: p.baseMills };
    });
    const baseMills = parts.reduce((sum, p) => sum + p.baseMills, 0);
    if (baseMills <= 0) {
      return {
        potId: pot.id, day, formula, participants, parts: [], baseMills: 0, lines: [],
        error: { reason: "empty_balance", message: "Свободный остаток в базе равен нулю" },
        serverNow: now.toISOString(),
      };
    }
    const lines = computeDemoLines(baseMills, formula, participants);
    return {
      potId: pot.id, day, formula, participants, parts, baseMills, lines,
      error: lines.length === 0 ? { reason: "no_participants", message: "Нет участников" } : null,
      serverNow: now.toISOString(),
    };
  },

  potDistributionPost: ({ params, body, now }): KernelOperationResponse<"potDistributionPost"> | ReturnType<typeof demoError> => {
    const pot = demoPots.find((p) => p.id === Number(params.potId));
    if (!pot) return demoError(404, "not_found", "Общак не найден");
    const req = (body ?? {}) as { day?: string; formula?: PotFormula; parts?: Array<{ transactionId: number; baseMills: number }> };
    const day = req.day ?? "2026-12-03";
    const formula = req.formula ?? pot.formula;
    const participants = activeParticipantsOf(pot);
    const distAll = activeDistributedByTx();
    const parts = (req.parts ?? demoPotSales.filter((s) => s.potCode === pot.code).map((s) => ({
      transactionId: s.transactionId,
      baseMills: Math.max(0, s.netMills - (distAll.get(s.transactionId) ?? 0)),
    }))).filter((p) => p.baseMills > 0).map((p) => {
      const sale = demoPotSales.find((s) => s.transactionId === p.transactionId)!;
      return { transactionId: p.transactionId, pageId: sale.pageId, pageLabel: sale.pageLabel, baseMills: p.baseMills };
    });
    const baseMills = parts.reduce((sum, p) => sum + p.baseMills, 0);
    if (baseMills <= 0) return demoError(409, "empty_balance", "Свободный остаток в базе равен нулю");
    const lines = computeDemoLines(baseMills, formula, participants);
    const dist: PotDistributionItem = {
      id: nextDistId++,
      potId: pot.id,
      day,
      formula,
      baseMills,
      lines,
      parts,
      postedAt: now.toISOString(),
      postedByName: "Владелец",
      reversedAt: null,
      reversedByName: null,
      reversedReason: null,
    };
    demoDistributions.push(dist);
    return { distribution: dist, savedAt: now.toISOString() };
  },

  potDistributionReverse: ({ params, body, now }): KernelOperationResponse<"potDistributionReverse"> | ReturnType<typeof demoError> => {
    const dist = demoDistributions.find((d) => d.id === Number(params.distributionId));
    if (!dist) return demoError(404, "not_found", "Раздача не найдена");
    if (dist.reversedAt !== null) return demoError(409, "already_reversed", "Раздача уже сторнирована");
    dist.reversedAt = now.toISOString();
    dist.reversedByName = "Владелец";
    dist.reversedReason = ((body as { reason?: string })?.reason ?? "Сторно").trim();
    return { distribution: dist, savedAt: now.toISOString() };
  },
};
