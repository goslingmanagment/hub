import { z } from "zod";

import type { TeamLedgerMonthCard, TeamLedgerMonthResponse } from "@agency_hub_core/contracts";

import type { AppContext } from "../bootstrap.ts";
import { ServiceUnavailableError } from "./errors.ts";
import { ledgerGet, payMillsOf } from "./ledger-payouts.ts";

/**
 * «Деньги → Месяц»: the agency's month card as the ledger keeps it (its hourly `month_cards` row), read with Hub's
 * payouts key from GET /v1/payouts/month/{month}. The ledger's card is the ledger's: Hub counts nothing in it, it only
 * turns the money into mills of the ledger's own whole cents (`payMillsOf`, as every pay of the ledger on Hub's
 * screens) so a cent never differs from what `ledger month` prints. No expenses, no decision figure, no owner's
 * draws come this way (the read leaves them out). An older ledger without the read (its 403 or 404) is `served:
 * false`, not an error.
 */

const LEDGER_CLIENT = "money-month";

/** The money fields of the card and of a model's line, as the ledger names them. */
const CARD_MONEY = ["pagesNet", "offPlatform", "turnover", "earned", "arrived", "riding", "hold", "stuck", "onPage"] as const;
const MODEL_MONEY = ["pagesNet", "offPlatform", "earned", "arrived", "riding"] as const;

/** A money field: dollars to the cent (`pagesNet: 1234.56`) or micro-dollars (`pagesNetMicros`), whichever it sends. */
const looseMoney = z.record(z.string(), z.unknown());

const ledgerMonthSchema = z.object({
  month: z.string(),
  status: z.enum(["proven", "unknown"]),
  reason: z.string().nullable().optional(),
  asOf: z.string().nullable().optional(),
  computedAt: z.string().nullable().optional(),
  models: z.array(looseMoney.and(z.object({ model: z.string() }))).default([]),
  notes: z.array(z.string()).default([]),
}).and(looseMoney);

/** The ledger's money as micro-dollars: its `…Micros` when it sends them, else its dollars (cents) to micros. */
function microsOf(row: Record<string, unknown>, name: string): number | null {
  const micros = row[`${name}Micros`];
  if (typeof micros === "number" && Number.isInteger(micros)) return micros;
  const dollars = row[name];
  if (typeof dollars === "number" && Number.isFinite(dollars)) return Math.round(dollars * 1_000_000);
  return null;
}

function millsOfField(row: Record<string, unknown>, name: string): number {
  const micros = microsOf(row, name);
  if (micros === null) throw new ServiceUnavailableError(`The ledger's month card has no «${name}»`);
  return payMillsOf(micros);
}

function isoOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

/** The month's Moscow days, both included: «2026-11» → 2026-11-01 … 2026-11-30. */
export function monthDays(month: string): { from: string; to: string } {
  const [year, number] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/** The card from the ledger's answer: its money in mills, its words as they are. Throws 503 on a shape Hub does not know. */
export function monthCardOf(body: unknown, month: string, logger?: Pick<AppContext["logger"], "warn">): TeamLedgerMonthCard {
  const parsed = ledgerMonthSchema.safeParse(body);
  if (!parsed.success) {
    logger?.warn({ issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`) }, "ledger month: unexpected answer");
    throw new ServiceUnavailableError("The ledger's GET /v1/payouts/month answered in a shape Hub does not know");
  }
  const card = parsed.data as Record<string, unknown> & z.infer<typeof ledgerMonthSchema>;
  if (card.month !== month) throw new ServiceUnavailableError("The ledger's GET /v1/payouts/month answered of another month");
  const money = Object.fromEntries(CARD_MONEY.map((name) => [`${name}Mills`, millsOfField(card, name)])) as Record<`${(typeof CARD_MONEY)[number]}Mills`, number>;
  return {
    status: card.status,
    reason: card.reason ?? null,
    asOf: isoOrNull(card.asOf),
    computedAt: isoOrNull(card.computedAt),
    ...money,
    models: card.models.map((line) => ({
      model: line.model,
      ...(Object.fromEntries(MODEL_MONEY.map((name) => [`${name}Mills`, millsOfField(line, name)])) as Record<`${(typeof MODEL_MONEY)[number]}Mills`, number>),
    })),
    notes: card.notes,
  };
}

/** The owner's: the month card of one Moscow month, as the ledger keeps it. */
export async function readTeamLedgerMonth(
  app: Pick<AppContext, "config" | "logger">,
  query: { month: string },
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<TeamLedgerMonthResponse> {
  const body = await ledgerGet(app, `/v1/payouts/month/${query.month}`, {}, {
    client: LEDGER_CLIENT,
    absentOn: [403, 404],
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const serverNow = (options.now ?? new Date()).toISOString();
  const days = monthDays(query.month);
  if (body === undefined) return { month: query.month, ...days, served: false, card: null, serverNow };
  return { month: query.month, ...days, served: true, card: monthCardOf(body, query.month, app.logger), serverNow };
}
