import { z } from "zod";

import type { AdminBudgetsResponse, BudgetArticle, BudgetFigures, BudgetMonth } from "@agency_hub_core/contracts";
import {
  MOSCOW_TIME_ZONE, microUsdFromDbInt, microUsdFromDollars, microUsdToMills, millsFromDollars, millsRoundedTo, millsToNumber, sumMills,
  toBusinessDate, zonedDateTimeToUtc, type Mills,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { ServiceUnavailableError } from "./errors.ts";

/**
 * The owner's «Бюджеты» from the agency ledger: its month cards (earned by model and channel, expenses by article, the
 * decision figure), the owner's own journal lines, the plans it keeps (turnover by page, the articles' limits, the
 * CEO's rate, the reinvest caps) and who was paid for traffic and as a contractor. Read with Hub's `read` key through
 * the ledger's SQL for agents (POST /v1/sql: read-only, logged there, documented by `ledger schema`). Our own service
 * on the same host: no egress proxy, no retry (the owner presses «Обновить»). Every answer is checked field by field:
 * a changed shape is a 503, never a wrong sum on the screen; a month the ledger could not count is «неизвестно».
 */

const LEDGER_TIMEOUT_MS = 20_000;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The ledger's expense categories that are traffic (its journal mapping: traffic, sfs, youtube) and the contractors'. */
const TRAFFIC_CATEGORIES: readonly string[] = ["Трафик", "SFS", "YouTube"];
const CONTRACTOR_CATEGORY = "Подрядчик";
const OWNER_SALARY = "Owner зарплата";
const OWNER_DRAW = "Owner draw";
const OWNER_INJECTION = "Owner вливание";

const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");

/** What Hub asks the ledger: one statement per table, each small. The texts are constants: nothing of a request is in them. */
const QUERIES = {
  // A card the ledger could not count keeps its last JSON (or none): the figures are read only from a valid one.
  cards: `WITH cards AS (SELECT month, as_of, status, coalesce(reason, '') AS reason,
      CASE WHEN json_valid(card) THEN card ELSE 'null' END AS card FROM month_cards)
    SELECT month, as_of, status, reason,
      json_extract(card, '$.totals'), json_extract(card, '$.lines'), json_extract(card, '$.expenses'), json_extract(card, '$.notes'),
      (SELECT json_group_object(page, net) FROM (SELECT substr(day.key, 1, instr(day.key, ' ') - 1) AS page, sum(day.value) AS net
        FROM json_each(cards.card, '$.pages') AS day GROUP BY 1))
    FROM cards ORDER BY month`,
  periods: "SELECT month, locked_at FROM periods",
  settings: "SELECT key, value FROM settings WHERE key IN ('category_caps', 'owner_salary_rate', 'model_names')",
  plans: "SELECT month, page_label, per_day FROM month_plans",
  // What the ledger expects to pay: a reinvest cap ends in a month; a regular payment of a traffic or contractor article is that source's plan.
  commitments: "SELECT kind, name, coalesce(category, ''), amount, coalesce(period, ''), coalesce(until, next_due, '') FROM commitments",
  owner: `SELECT date, type, category, amount_micros, coalesce(tags, '{}') FROM v_documents
    WHERE status = 'paid' AND category IN (${quoted([OWNER_SALARY, OWNER_DRAW, OWNER_INJECTION])})`,
  promotion: `SELECT substr(date, 1, 7), category, counterparty, coalesce(model, ''), sum(amount_micros), count(*) FROM v_documents
    WHERE status = 'paid' AND type = 'expense' AND category IN (${quoted([...TRAFFIC_CATEGORIES, CONTRACTOR_CATEGORY])})
    GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`,
} as const;

const sqlAnswerSchema = z.object({ ok: z.literal(true), rows: z.array(z.array(z.unknown())).nullable(), truncated: z.boolean().optional() });

const dollars = z.number().finite();
const micros = z.number().int();
const text = z.string();
/** A JSON text in a column, read as `shape`; SQL NULL (no such part) is `absent`. */
function jsonColumn<T extends z.ZodTypeAny>(shape: T, absent: z.output<T> | null = null) {
  return z.string().nullable().transform((value, context): z.output<T> | null => {
    if (value === null) return absent;
    try {
      return shape.parse(JSON.parse(value)) as z.output<T>;
    } catch {
      context.addIssue({ code: "custom", message: "not the JSON Hub knows" });
      return z.NEVER;
    }
  });
}

const cardTotals = z.object({ net: dollars, earned: dollars, arrived: dollars, transit: dollars, stuck: dollars, decision: dollars });
const cardLines = z.array(z.object({ model: text, channel: text, net: dollars, earned: dollars }));
const cardExpenses = z.object({
  cats: z.record(z.string(), dollars),
  chat: z.record(z.string(), dollars),
  // Go writes an empty slice as null. A payment above the sheets: the journal line, the sum, whom.
  extra: z.array(z.tuple([z.number(), dollars, z.string()])).nullable().transform((value) => value ?? []),
  total: dollars,
});

const cardRow = z.tuple([
  text.regex(MONTH), text, text, text,
  jsonColumn(cardTotals), jsonColumn(cardLines), jsonColumn(cardExpenses),
  jsonColumn(z.array(z.string()).nullable().transform((value) => value ?? []), []),
  jsonColumn(z.record(z.string(), dollars), {}),
]);
const periodRow = z.tuple([text.regex(MONTH), text.nullable()]);
const settingRow = z.tuple([text, text.nullable()]);
const planRow = z.tuple([text.regex(MONTH), text, dollars]);
const commitmentRow = z.tuple([text, text, text, micros, text, text]);
const ownerRow = z.tuple([
  text.regex(DAY), text, text, micros,
  // {"за": [{"месяц": "2026-11", "сумма": 608.27}]}: a part of the line is for another month.
  jsonColumn(z.object({ "за": z.array(z.object({ "месяц": text.regex(MONTH), "сумма": dollars })).optional() }), {}),
]);
const promotionRow = z.tuple([text.regex(MONTH), text, text, text, micros, z.number().int().nonnegative()]);

type BudgetsApp = Pick<AppContext, "config" | "logger">;

/** One statement of the ledger's SQL for agents with Hub's read key: its rows, or a 503. */
async function ledgerRows(app: BudgetsApp, name: keyof typeof QUERIES, fetchImpl: typeof fetch): Promise<unknown[][]> {
  const key = app.config.ledgerReadKey ?? null;
  if (key === null) throw new ServiceUnavailableError("The ledger is not connected: LEDGER_READ_KEY is not set");
  const url = new URL("/v1/sql", app.config.ledgerUrl ?? "https://ledger.gosling-agency.ru");
  let body: unknown;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, accept: "application/json", "content-type": "application/json", "user-agent": "agency-hub/budgets" },
      body: JSON.stringify({ sql: QUERIES[name] }),
      signal: AbortSignal.timeout(LEDGER_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ServiceUnavailableError(`The ledger answered POST /v1/sql (${name}) with ${response.status}`);
    }
    body = await response.json();
  } catch (error) {
    if (error instanceof ServiceUnavailableError) throw error;
    throw new ServiceUnavailableError(`The ledger did not answer POST /v1/sql (${name}) (${error instanceof Error ? error.name : "error"})`);
  }
  const parsed = sqlAnswerSchema.safeParse(body);
  // A cut answer is a part of the money: never shown as the whole.
  if (!parsed.success || parsed.data.truncated === true) throw unknownShape(app, name, parsed.success ? ["truncated"] : issuesOf(parsed.error));
  return parsed.data.rows ?? [];
}

function issuesOf(error: z.ZodError): string[] {
  return error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

function unknownShape(app: BudgetsApp, name: string, issues: string[]): ServiceUnavailableError {
  app.logger.warn({ query: name, issues }, "ledger budgets: unexpected answer");
  return new ServiceUnavailableError(`The ledger's POST /v1/sql (${name}) answered in a shape Hub does not know`);
}

function rowsOf<T extends z.ZodTypeAny>(app: BudgetsApp, name: string, row: T, rows: unknown[][]): Array<z.output<T>> {
  const parsed = z.array(row).safeParse(rows);
  if (!parsed.success) throw unknownShape(app, name, issuesOf(parsed.error));
  return parsed.data;
}

/** A setting's JSON, or `fallback` when the ledger has no such setting. */
function settingOf<T extends z.ZodTypeAny>(app: BudgetsApp, settings: ReadonlyMap<string, string>, key: string, shape: T, fallback: z.output<T>): z.output<T> {
  const raw = settings.get(key);
  if (raw === undefined || raw.trim() === "") return fallback;
  try {
    return shape.parse(JSON.parse(raw)) as z.output<T>;
  } catch {
    throw unknownShape(app, `settings.${key}`, ["not the JSON Hub knows"]);
  }
}

/**
 * Every sum leaves here in whole cents, the cents the ledger itself prints (`ledger month show`, the Monday brief), so
 * the screen and the ledger's words agree to the cent. A float of a month card is rounded as the ledger prints it.
 */
const cardCents = (value: number): Mills => millsFromDollars(value.toFixed(2));
/** The journal's micro-dollars, added exactly and rounded once. */
const journalCents = (parts: readonly number[]): Mills =>
  millsRoundedTo(microUsdToMills(microUsdFromDbInt(parts.reduce((sum, part) => sum + part, 0))), "cent");
const asNumber = (value: Mills): number => millsToNumber(value);

function daysInMonth(month: string): number {
  const [year, monthNumber] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

/** How much of the Moscow month had passed at `at`: 0–1. */
function elapsedShare(month: string, at: Date): number {
  const [year, monthNumber] = month.split("-").map(Number) as [number, number];
  const start = zonedDateTimeToUtc({ year, month: monthNumber, day: 1 }, MOSCOW_TIME_ZONE).getTime();
  const next = monthNumber === 12 ? { year: year + 1, month: 1 } : { year, month: monthNumber + 1 };
  const end = zonedDateTimeToUtc({ ...next, day: 1 }, MOSCOW_TIME_ZONE).getTime();
  return Math.min(1, Math.max(0, (at.getTime() - start) / (end - start)));
}

const CHANNELS: Readonly<Record<string, { channel: "fansly" | "onlyfans" | "off_platform"; name: string }>> = {
  "Fansly": { channel: "fansly", name: "Fansly" },
  "OF": { channel: "onlyfans", name: "OnlyFans" },
  "вне платформ": { channel: "off_platform", name: "вне платформ" },
};

/** The CEO's rate on the month's first day: the latest dated rate not after it, else the undated one. */
function rateOf(rates: Readonly<Record<string, number>>, month: string): number | null {
  const first = `${month}-01`;
  const dated = Object.keys(rates).filter((from) => from !== "" && from <= first).sort().at(-1);
  return dated !== undefined ? rates[dated] ?? null : rates[""] ?? null;
}

export async function readLedgerBudgets(
  app: BudgetsApp,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<AdminBudgetsResponse> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? new Date();
  const names = Object.keys(QUERIES) as Array<keyof typeof QUERIES>;
  const answers = await Promise.all(names.map((name) => ledgerRows(app, name, fetchImpl)));
  const raw = Object.fromEntries(names.map((name, index) => [name, answers[index] ?? []])) as Record<keyof typeof QUERIES, unknown[][]>;

  const cards = rowsOf(app, "cards", cardRow, raw.cards);
  const closedAt = new Map(rowsOf(app, "periods", periodRow, raw.periods).map(([month, lockedAt]) => [month, lockedAt]));
  const settings = new Map(rowsOf(app, "settings", settingRow, raw.settings).map(([key, value]) => [key, value ?? ""]));
  const caps = settingOf(app, settings, "category_caps", z.record(z.string(), dollars), {});
  const rates = settingOf(app, settings, "owner_salary_rate", z.union([dollars.transform((rate) => ({ "": rate })), z.record(z.string(), dollars)]), {});
  const modelNames = settingOf(app, settings, "model_names", z.record(z.string(), z.string()), {});
  /** «Lora, Lily» as the ledger names the models for people; «—» is no model. */
  const modelsOf = (value: string) => value.split(",").map((one) => one.trim()).filter((one) => one !== "" && one !== "—").map((one) => modelNames[one] ?? one);

  const months = cards.map(([month]) => month);
  const currentMonth = toBusinessDate(now).slice(0, 7);

  // The owner's lines in micro-dollars, by the month they are for: a part marked {за ГГГГ-ММ} leaves the month of payment.
  const owner = new Map(months.map((month) => [month, { salary: [] as number[], draw: [] as number[], injection: [] as number[] }]));
  for (const [date, type, category, amountMicros, tags] of rowsOf(app, "owner", ownerRow, raw.owner)) {
    const paidIn = date.slice(0, 7);
    if (category === OWNER_SALARY && type === "expense") {
      let moved = 0;
      for (const part of tags?.["за"] ?? []) {
        const partMicros = microUsdFromDollars(part["сумма"]);
        moved += partMicros;
        owner.get(part["месяц"])?.salary.push(partMicros);
      }
      owner.get(paidIn)?.salary.push(amountMicros - moved);
    } else if (category === OWNER_DRAW && type === "expense") {
      owner.get(paidIn)?.draw.push(amountMicros);
    } else if (category === OWNER_INJECTION) {
      // Put in is income; given back is an expense of the same category.
      owner.get(paidIn)?.injection.push(type === "income" ? amountMicros : -amountMicros);
    }
  }

  const plans = rowsOf(app, "plans", planRow, raw.plans);
  const commitments = rowsOf(app, "commitments", commitmentRow, raw.commitments);
  const reinvest = commitments.filter(([kind]) => kind === "reinvest");
  const promotionCategories = [...TRAFFIC_CATEGORIES, CONTRACTOR_CATEGORY];
  const regular = commitments.filter(([kind, , category]) => kind !== "reinvest" && promotionCategories.includes(category));

  const budgetMonths: BudgetMonth[] = cards.map(([month, asOf, status, reason, totals, lines, expenses, notes, pages]) => {
    const days = daysInMonth(month);
    const rate = rateOf(rates, month);
    const rateMills = rate === null ? null : cardCents(rate);
    const lockedAt = closedAt.get(month) ?? null;
    const asOfDate = new Date(asOf);
    if (Number.isNaN(asOfDate.getTime())) throw unknownShape(app, "cards", [`${month}: as_of is not a time`]);

    let figures: BudgetFigures | null = null;
    if (status === "ok") {
      if (totals === null || lines === null || expenses === null) throw unknownShape(app, "cards", [`${month}: an ok card without its parts`]);
      // The chatters' pay: by model from the payout sheets, and what was paid above them. Dollars are added as the ledger adds them.
      const aboveSheets = expenses.extra.reduce((sum, [, amount]) => sum + amount, 0);
      const chatters = Object.values(expenses.chat).reduce((sum, amount) => sum + amount, 0) + aboveSheets;
      const chatterParts = [
        ...Object.entries(expenses.chat).map(([model, amount]) => ({ name: modelNames[model] ?? model, amountMills: asNumber(cardCents(amount)) })),
        { name: "Сверх таблиц", amountMills: asNumber(cardCents(aboveSheets)) },
      ].filter((part) => part.amountMills !== 0);
      const articles: BudgetArticle[] = [
        ...(chatterParts.length === 0 ? [] : [{ key: "chatters", name: "Чаттеры", amountMills: asNumber(cardCents(chatters)), capMills: null, parts: chatterParts }]),
        ...Object.entries(expenses.cats).map(([category, amount]) => ({
          key: category, name: category, amountMills: asNumber(cardCents(amount)),
          capMills: caps[category] === undefined ? null : asNumber(cardCents(caps[category])), parts: [],
        })),
      ].filter((article) => article.amountMills !== 0 || article.capMills !== null).sort((a, b) => b.amountMills - a.amountMills);
      const decision = cardCents(totals.decision);
      figures = {
        turnoverMills: asNumber(cardCents(totals.net)),
        earnedMills: asNumber(cardCents(totals.earned)),
        arrivedMills: asNumber(cardCents(totals.arrived)),
        transitMills: asNumber(cardCents(totals.transit)),
        stuckMills: asNumber(cardCents(totals.stuck)),
        sources: lines.map((line) => {
          const channel = CHANNELS[line.channel];
          return {
            model: modelNames[line.model] ?? line.model,
            channel: channel?.channel ?? "other" as const,
            channelName: channel?.name ?? line.channel,
            turnoverMills: asNumber(cardCents(line.net)),
            earnedMills: asNumber(cardCents(line.earned)),
          };
        }).filter((source) => source.turnoverMills !== 0 || source.earnedMills !== 0).sort((a, b) => b.earnedMills - a.earnedMills),
        pages: Object.entries(pages ?? {}).filter(([pageLabel]) => pageLabel !== "")
          .map(([pageLabel, net]) => ({ pageLabel, turnoverMills: asNumber(cardCents(net)) }))
          .sort((a, b) => b.turnoverMills - a.turnoverMills),
        expensesMills: asNumber(cardCents(expenses.total)),
        articles,
        decisionMills: asNumber(decision),
        leftMills: rateMills === null ? null : asNumber(decision - rateMills),
        notes: notes ?? [],
      };
    }

    const ownerLines = owner.get(month);
    const planPages = plans.filter(([planMonth]) => planMonth === month)
      .map(([, pageLabel, perDay]) => {
        const perDayMills = cardCents(perDay);
        return { pageLabel, perDayMills: asNumber(perDayMills), planMills: asNumber(perDayMills * BigInt(days)) };
      })
      .sort((a, b) => b.planMills - a.planMills);

    return {
      month,
      state: lockedAt !== null ? "closed" : month === currentMonth ? "open" : "preliminary",
      closedAt: lockedAt === null || Number.isNaN(Date.parse(lockedAt)) ? null : new Date(lockedAt).toISOString(),
      daysInMonth: days,
      elapsedShare: month < currentMonth ? 1 : elapsedShare(month, asOfDate),
      figures,
      unknownReason: status === "ok" ? null : reason === "" ? "the ledger gave no reason" : reason,
      owner: {
        salaryRateMills: rateMills === null ? null : asNumber(rateMills),
        salaryPaidMills: asNumber(journalCents(ownerLines?.salary ?? [])),
        drawMills: asNumber(journalCents(ownerLines?.draw ?? [])),
        injectionMills: asNumber(journalCents(ownerLines?.injection ?? [])),
      },
      plan: {
        turnoverMills: planPages.length === 0 ? null : asNumber(sumMills(planPages.map((page) => page.planMills))),
        // The planned pages' turnover in dollars, added before rounding: with every page planned it is the month's turnover to the cent.
        factMills: planPages.length === 0 || status !== "ok" ? null
          : asNumber(cardCents(planPages.reduce((sum, page) => sum + (pages?.[page.pageLabel] ?? 0), 0))),
        pages: planPages,
        reinvest: reinvest.filter(([, , , , , due]) => due.slice(0, 7) === month).map(([, name, , amount]) => ({ name, capMills: asNumber(journalCents([amount])) })),
      },
    };
  });

  // Who was paid for traffic and as a contractor: one row per article and counterparty, the months side by side.
  const monthIndex = new Map(months.map((month, index) => [month, index]));
  const sources = new Map<string, { kind: "traffic" | "contractor"; category: string; counterparty: string; models: string[]; byMonth: number[][]; payments: number }>();
  const sourceOf = (category: string, counterparty: string) => {
    const id = `${category}\u0000${counterparty}`;
    const source = sources.get(id) ?? {
      kind: TRAFFIC_CATEGORIES.includes(category) ? "traffic" as const : "contractor" as const,
      category, counterparty, models: [], byMonth: months.map(() => []), payments: 0,
    };
    sources.set(id, source);
    return source;
  };
  for (const [month, category, counterparty, model, amountMicros, payments] of rowsOf(app, "promotion", promotionRow, raw.promotion)) {
    const index = monthIndex.get(month);
    if (index === undefined) continue;
    const source = sourceOf(category, counterparty);
    for (const name of modelsOf(model)) if (!source.models.includes(name)) source.models.push(name);
    source.byMonth[index]?.push(amountMicros);
    source.payments += payments;
  }
  // What the ledger expects to pay a source regularly is the source's plan; it is in the table even before the first payment.
  const sameName = (one: string, other: string) => one.trim().toLowerCase() === other.trim().toLowerCase();
  const regularOf = (category: string, counterparty: string) => {
    const row = regular.find(([, name, ofCategory]) => ofCategory === category && sameName(name, counterparty));
    return row ? { amountMills: asNumber(journalCents([row[3]])), period: row[4] } : null;
  };
  for (const [, name, category] of regular) {
    if (![...sources.values()].some((source) => source.category === category && sameName(source.counterparty, name))) sourceOf(category, name);
  }
  const promotionSources = [...sources.values()].map((source) => {
    const byMonth = source.byMonth.map((parts) => journalCents(parts));
    return {
      kind: source.kind, category: source.category, counterparty: source.counterparty, model: source.models.join(", "),
      byMonth: byMonth.map(asNumber), totalMills: asNumber(sumMills(byMonth)), payments: source.payments,
      regular: regularOf(source.category, source.counterparty),
    };
  }).sort((a, b) => b.totalMills - a.totalMills || a.counterparty.localeCompare(b.counterparty, "ru"));

  return {
    months: budgetMonths,
    promotion: {
      months,
      sources: promotionSources,
      totals: months.map((month, index) => ({
        month,
        trafficMills: asNumber(sumMills(promotionSources.filter((source) => source.kind === "traffic").map((source) => source.byMonth[index] ?? 0))),
        contractorMills: asNumber(sumMills(promotionSources.filter((source) => source.kind === "contractor").map((source) => source.byMonth[index] ?? 0))),
      })),
    },
    // Every card is counted in one pass: the newest month's cut is the cut of them all.
    ledgerAsOf: cards.length === 0 ? null : new Date(cards[cards.length - 1]![1]).toISOString(),
    serverNow: now.toISOString(),
  };
}
