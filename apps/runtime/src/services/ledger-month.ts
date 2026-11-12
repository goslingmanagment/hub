import { z } from "zod";

import type { TeamLedgerMonthCard, TeamLedgerMonthResponse } from "@agency_hub_core/contracts";
import { listAdminModels } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { ServiceUnavailableError } from "./errors.ts";
import { ledgerGet, payMillsOf } from "./ledger-payouts.ts";

/**
 * «Деньги → Месяц»: the agency's month card as the ledger keeps it (its hourly `month_cards` row), read with Hub's
 * payouts key from GET /v1/payouts/month/{month}. The ledger's card is the ledger's: Hub counts nothing in it, it only
 * turns the money into mills of the ledger's own whole cents (`payMillsOf`, as every pay of the ledger on Hub's
 * screens) so a cent never differs from what `ledger month` prints. Its money is integer micro-dollars, as
 * /v1/payouts/person's (ledger#85); a month the ledger never computed has them null (`status: unknown` with its
 * reason). No expenses, no decision figure, no owner's draws come this way (the read leaves them out). An older
 * ledger without the read (its 403 or 404) is `served: false`, not an error.
 */

const LEDGER_CLIENT = "money-month";

/** The money fields of the card and of a model's line, as the ledger names them. */
const CARD_MONEY = ["pagesNet", "offPlatform", "turnover", "earned", "arrived", "riding", "hold", "stuck", "onPage"] as const;

/** Integer micro-dollars; null — the month was never computed. */
const micros = z.number().int().nullable();

const ledgerModelSchema = z.object({
  model: z.string(),
  pagesNet: micros,
  offPlatform: micros,
  earned: micros,
  arrived: micros,
  riding: micros,
});

const ledgerMonthSchema = z.object({
  month: z.string(),
  status: z.enum(["proven", "unknown"]),
  reason: z.string().nullable().optional(),
  asOf: z.string().nullable().optional(),
  computedAt: z.string().nullable().optional(),
  pagesNet: micros,
  offPlatform: micros,
  turnover: micros,
  earned: micros,
  arrived: micros,
  riding: micros,
  hold: micros,
  stuck: micros,
  onPage: micros,
  models: z.array(ledgerModelSchema).nullable().default([]),
  notes: z.array(z.string()).nullable().default([]),
});


function isoOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

/** The month's Moscow days, both included: «2026-11» → 2026-11-01 … 2026-11-30. */
export function monthDays(month: string): { from: string; to: string } {
  const [year, number] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/** A model record of Hub: the one name every screen gives the model (Главная, Настройки, the card here). */
export interface HubModel {
  slug: string;
  name: string;
}

/** A name as a payout sheet may spell it: case aside, a doubled letter read once («Lilly» and «Lily» read alike). */
const looseName = (name: string) => name.trim().toLowerCase().replace(/(\p{L})\1+/gu, "$1");

/**
 * The name Hub's model record gives the model the ledger names `ledgerModel` (the ledger names a model by its payout
 * sheet): the record whose slug or name it is, case aside; else the one record that reads the same with doubled letters
 * read once. A name no record (or more than one) reads as stays the ledger's word, never a guess. Pure.
 */
export function hubModelNameOf(ledgerModel: string, models: readonly HubModel[]): string {
  const exact = ledgerModel.trim().toLowerCase();
  const found = models.find((model) => model.slug.trim().toLowerCase() === exact || model.name.trim().toLowerCase() === exact);
  if (found) return found.name;
  const loose = looseName(ledgerModel);
  const alike = models.filter((model) => looseName(model.slug) === loose || looseName(model.name) === loose);
  return alike.length === 1 ? alike[0]!.name : ledgerModel;
}

/**
 * The card from the ledger's answer: its money in mills, its words as they are, each model by the name of Hub's model
 * record (`models`). Throws 503 on a shape Hub does not know.
 */
export function monthCardOf(
  body: unknown,
  month: string,
  options: { logger?: Pick<AppContext["logger"], "warn">; models?: readonly HubModel[] } = {},
): TeamLedgerMonthCard {
  const { logger } = options;
  const parsed = ledgerMonthSchema.safeParse(body);
  if (!parsed.success) {
    logger?.warn({ issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`) }, "ledger month: unexpected answer");
    throw new ServiceUnavailableError("The ledger's GET /v1/payouts/month answered in a shape Hub does not know");
  }
  const card = parsed.data;
  if (card.month !== month) throw new ServiceUnavailableError("The ledger's GET /v1/payouts/month answered of another month");
  // Pay's one conversion, the ledger's whole cents; null stays null (never computed, never a zero).
  const money = Object.fromEntries(CARD_MONEY.map((name) => {
    const value = card[name];
    return [`${name}Mills`, value === null ? null : payMillsOf(value)];
  })) as Record<`${(typeof CARD_MONEY)[number]}Mills`, number | null>;
  return {
    status: card.status,
    reason: card.reason ?? null,
    asOf: isoOrNull(card.asOf),
    computedAt: isoOrNull(card.computedAt),
    ...money,
    // A line of a never-computed month has no money: no line.
    models: (card.models ?? []).flatMap((line) => (line.pagesNet === null || line.offPlatform === null || line.earned === null || line.arrived === null || line.riding === null ? [] : [{
      model: hubModelNameOf(line.model, options.models ?? []),
      pagesNetMills: payMillsOf(line.pagesNet),
      offPlatformMills: payMillsOf(line.offPlatform),
      earnedMills: payMillsOf(line.earned),
      arrivedMills: payMillsOf(line.arrived),
      ridingMills: payMillsOf(line.riding),
    }])),
    notes: card.notes ?? [],
  };
}

/** The owner's: the month card of one Moscow month, as the ledger keeps it; `models` — Hub's records (read when absent). */
export async function readTeamLedgerMonth(
  app: Pick<AppContext, "db" | "config" | "logger">,
  query: { month: string },
  options: { fetchImpl?: typeof fetch; now?: Date; models?: readonly HubModel[] } = {},
): Promise<TeamLedgerMonthResponse> {
  const body = await ledgerGet(app, `/v1/payouts/month/${query.month}`, {}, {
    client: LEDGER_CLIENT,
    absentOn: [403, 404],
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const serverNow = (options.now ?? new Date()).toISOString();
  const days = monthDays(query.month);
  if (body === undefined) return { month: query.month, ...days, served: false, card: null, serverNow };
  const models = options.models ?? (await listAdminModels(app.db)).map((model) => ({ slug: model.slug, name: model.name }));
  return { month: query.month, ...days, served: true, card: monthCardOf(body, query.month, { logger: app.logger, models }), serverNow };
}
