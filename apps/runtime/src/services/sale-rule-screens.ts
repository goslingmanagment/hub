import { listOwnerLoginIds, listSaleHomes, readSaleRuleSwitch, type Database, type SaleHomeRow, type ShiftSale } from "@agency_hub_core/db";

import { dayOfWork, moscowDayOf } from "./chatter-shifts.ts";
import { computeSaleHomes, registrySlots } from "./sale-homes.ts";
import { SALE_HOME_KINDS, SALE_RULE, type SaleHomeKind } from "./sale-rule.ts";
import { reportDateOfShift } from "./shift-rows.ts";

/**
 * The screens' side of the one rule of whose a sale is (sale-rule.ts). From the Moscow day of the switch
 * (`sale_rule_switch.screens_from`, 0381) on, «Смены», «Люди», «Мои смены», the shift review and the morning
 * report count a sale where `sale_homes` puts it; null — off, every screen counts exactly as before.
 *
 * THE CUT. A shift whose report date (`reportDateOfShift`, ledger's rule, the `shifts.report_date` of its row) is
 * the switch's day or later is counted by the rule and dated by its report date; an earlier one keeps the old
 * count and its old day (`dayOfShift`), so a week before the switch never moves. A look-in is cut by its own day.
 * A sale an old shift counts is not counted again by a ruled one (a PPV bought on the last evening before the
 * switch whose sender's next shift is after it stays with the evening's holder).
 *
 * THE HOMES. `sale_homes` as the hourly job wrote it, and the open window computed now with the same function
 * and facts (`computeSaleHomes`): the sales since the earliest of today's Moscow midnight and the start of any
 * work going on, a PPV still waiting for its sender, and any sale the job has not written yet. So the running
 * shift never lags the job's hour, and a closed day reads what the job stored.
 *
 * A READ-ONLY STAND (never production: NODE_ENV=production ignores both) can act as if the switch were set and
 * as if the job had just run: `HUB_SALE_RULE_SCREENS_FROM=YYYY-MM-DD` (or `off`) and `HUB_SALE_HOMES_LIVE=1`.
 */

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface ScreensRule {
  /** The first Moscow day (YYYY-MM-DD) the screens count by the rule. */
  from: string;
  /** Every home computed now, the stored ones aside (a stand's view of the job's next run). */
  live: boolean;
}

/** A stand's overrides, read only outside production: `screensFrom` undefined — the stored switch. Pure. */
export function standOverrides(env: NodeJS.ProcessEnv = process.env): { screensFrom?: string | null; live: boolean } {
  if (env.NODE_ENV === "production") return { live: false };
  const asked = env.HUB_SALE_RULE_SCREENS_FROM?.trim();
  const live = env.HUB_SALE_HOMES_LIVE === "1";
  if (asked === undefined || asked === "") return { live };
  if (asked === "off") return { screensFrom: null, live };
  if (!DAY.test(asked) || Number.isNaN(Date.parse(`${asked}T00:00:00Z`))) throw new Error("HUB_SALE_RULE_SCREENS_FROM: a Moscow day YYYY-MM-DD or off");
  return { screensFrom: asked, live };
}

/** The screens' switch: the stored one (a stand's override outside production); null — off. */
export async function readScreensRule(db: Database, env: NodeJS.ProcessEnv = process.env): Promise<ScreensRule | null> {
  const override = standOverrides(env);
  const from = override.screensFrom !== undefined ? override.screensFrom : (await readSaleRuleSwitch(db)).screensFrom;
  return from === null ? null : { from, live: override.live };
}

/** A sale's home as the screens read it. */
export interface ScreenHome {
  transactionId: number;
  kind: SaleHomeKind;
  reason: string;
  /** A shift or look-in home's shares; the person's work as the rule named it (`<userId>:<startedAt ISO>`). */
  shares: ReadonlyArray<{ userId: number; workRef: string | null; mills: number }>;
}

const KINDS: ReadonlySet<string> = new Set(SALE_HOME_KINDS);

function storedHome(row: Pick<SaleHomeRow, "transactionId" | "home" | "reason" | "shares">): ScreenHome {
  return {
    transactionId: row.transactionId,
    kind: KINDS.has(row.home) ? row.home as SaleHomeKind : "unknown",
    reason: row.reason,
    shares: row.shares.map((share) => ({ userId: share.userId, workRef: share.workRef, mills: share.mills })),
  };
}

/** The sales whose homes are computed now: the open window's, a waiting PPV's, and those no stored home has. Pure. */
export function salesToCompute(input: {
  sales: ReadonlyArray<Pick<ShiftSale, "transactionId" | "occurredAt">>;
  stored: ReadonlyMap<number, Pick<ScreenHome, "kind">>;
  openFrom: number;
  live: boolean;
}): number | null {
  let from: number | null = null;
  for (const sale of input.sales) {
    const at = sale.occurredAt.getTime();
    const stored = input.stored.get(sale.transactionId);
    if (input.live || at >= input.openFrom || stored === undefined || stored.kind === "waiting") from = from === null ? at : Math.min(from, at);
  }
  return from;
}

/** Where the open window begins: today's Moscow midnight, or the start of the earliest work going on before it. Pure. */
export function openWindowFrom(now: Date, works: Iterable<{ startedAt: number; ongoing: boolean }>): number {
  let from = Date.parse(`${moscowDayOf(now.getTime())}T00:00:00+03:00`);
  for (const work of works) if (work.ongoing) from = Math.min(from, work.startedAt);
  return from;
}

/** The homes of `sales`: stored, and computed now from where `salesToCompute` says (the whole of them on a live stand). */
export async function readScreenHomes(
  db: Database,
  input: { sales: ReadonlyArray<Pick<ShiftSale, "transactionId" | "occurredAt">>; openFrom: number; now: Date; live: boolean },
): Promise<Map<number, ScreenHome>> {
  const homes = new Map<number, ScreenHome>();
  if (input.sales.length === 0) return homes;
  const times = input.sales.map((sale) => sale.occurredAt.getTime());
  const first = Math.min(...times);
  const last = Math.max(...times);
  if (!input.live) {
    // A stored home that gives the owner a share is from before the owner's logins took none (2026-11-12): computed again.
    const owners = await listOwnerLoginIds(db);
    for (const row of await listSaleHomes(db, { from: new Date(first), to: new Date(last + 1) })) {
      if (!row.shares.some((share) => owners.has(share.userId))) homes.set(row.transactionId, storedHome(row));
    }
  }
  const from = salesToCompute({ sales: input.sales, stored: homes, openFrom: input.openFrom, live: input.live });
  if (from === null) return homes;
  const to = new Date(Math.max(input.now.getTime(), last + 1));
  const computed = await computeSaleHomes(db, { from: new Date(from), to, now: input.now, slots: registrySlots(db) });
  computed.answer.sales.forEach((sale, at) => {
    const home = computed.homes[at]!;
    homes.set(Number(sale.transactionRef), {
      transactionId: Number(sale.transactionRef),
      kind: home.kind,
      reason: home.reason,
      shares: home.shares.map((share) => ({ userId: share.userId, workRef: share.workRef, mills: share.mills })),
    });
  });
  return homes;
}

/** How far before the switch a sale can still land on a ruled shift: the PPV's wait for its sender, and a day. */
export const RULED_SALES_LEAD_MS = SALE_RULE.ppvWaitMs + DAY_MS;

/** The first instant a sale whose home may be a ruled work can have. Pure. */
export const ruledSalesFrom = (rule: ScreensRule) => Date.parse(`${rule.from}T00:00:00+03:00`) - RULED_SALES_LEAD_MS;

/** Whether the rule counts a work: a shift from its report date, a look-in from its day. Pure. */
export function ruledWork(rule: ScreensRule | null | undefined, work: { kind: "shift" | "visit"; startedAt: number; endedAt: number }): boolean {
  if (rule === null || rule === undefined) return false;
  return (work.kind === "shift" ? reportDateOfShift(work) : dayOfWork(work)) >= rule.from;
}

/** Whether a sale no shift counts is the rule's to place: one of the switch's day or later. Pure. */
export const ruledSale = (rule: ScreensRule | null | undefined, sale: Pick<ShiftSale, "occurredAt">) =>
  rule !== null && rule !== undefined && moscowDayOf(sale.occurredAt.getTime()) >= rule.from;

/** A work's reference as the rule names it (agent-team-sales.ts `workRef`). Pure. */
export const ruleWorkRef = (userId: number, work: { startedAt: number }) => `${userId}:${new Date(work.startedAt).toISOString()}`;

/**
 * The screen's piece of work a share of the rule credits: the same work (`<userId>:<startedAt>`), else the person's work
 * that holds the start the rule named (a look-in that joined it since moved its start earlier). Pure.
 */
export function creditedPiece<P extends { userId: number; work: { startedAt: number; endedAt: number } }>(
  byUser: ReadonlyMap<number, readonly P[]>,
  share: { userId: number; workRef: string | null },
): P | null {
  if (share.workRef === null) return null;
  const start = Date.parse(share.workRef.slice(share.workRef.indexOf(":") + 1));
  const pieces = byUser.get(share.userId) ?? [];
  return pieces.find((piece) => piece.work.startedAt === start)
    ?? pieces.find((piece) => piece.work.startedAt <= start && start < piece.work.endedAt)
    ?? null;
}

/** The pieces by person, for `creditedPiece`. Pure. */
export function piecesByUser<P extends { userId: number }>(pieces: readonly P[]): Map<number, P[]> {
  const out = new Map<number, P[]>();
  for (const piece of pieces) out.set(piece.userId, [...(out.get(piece.userId) ?? []), piece]);
  return out;
}

/** Where a sale the rule gives no person's shift is shown: the line of «вне смен». */
export const OUTSIDE_HOMES = ["visit", "pot", "waiting", "decide", "nobody"] as const;
export type OutsideHome = (typeof OUTSIDE_HOMES)[number];

/** The line of a home no person's shift holds; null — a person's shift. Pure. */
export function outsideHomeOf(home: Pick<ScreenHome, "kind">): OutsideHome | null {
  switch (home.kind) {
    case "shift": return null;
    case "visit":
    case "pot":
    case "waiting":
    case "decide":
      return home.kind;
    default:
      return "nobody";
  }
}
