import { z } from "zod";

import { TEAM_LEDGER_PAYOUTS_MAX_DAYS, type TeamLedgerPayoutsResponse } from "@agency_hub_core/contracts";
import { listUsers } from "@agency_hub_core/db";
import { microUsdFromDbInt, microUsdToMills, millsToNumber } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { BadRequestError, ServiceUnavailableError } from "./errors.ts";

/**
 * Workboard «Выплаты» from the agency ledger (ledger release 2, H2): Hub's
 * server reads the ledger's GET /v1/payouts with its `payouts` key and passes
 * the answer on in mills, each person joined to the Hub user they are. Our own
 * service on the same host, not a platform: no egress proxy, no retry (the
 * owner presses «Обновить»). The ledger's answer is checked field by field: a
 * changed shape is a 503, never a wrong sum on the screen.
 */

const LEDGER_TIMEOUT_MS = 20_000;
const DAY_MS = 86_400_000;

const micros = z.number().int();
/** Go writes an empty slice as null. */
const list = <T extends z.ZodTypeAny>(item: T) => z.array(item).nullable().transform((value): Array<z.output<T>> => value ?? []);

const ledgerPayoutsSchema = z.object({
  from: z.string(),
  to: z.string(),
  accrualFrom: z.string(),
  generatedAt: z.string(),
  people: list(z.object({
    slug: z.string(),
    name: z.string(),
    aliases: list(z.string()),
    status: z.string(),
    days: list(z.object({
      date: z.string(),
      model: z.string(),
      amountMicros: micros,
      worked: z.boolean(),
      source: z.string(),
    })),
    accruedMicros: micros,
    paidMicros: micros,
    balanceMicros: micros,
    toPayMicros: micros.nullable(),
    oldestUnpaidDate: z.string().nullable(),
    unpaidDays: list(z.object({
      date: z.string(),
      kind: z.string(),
      model: z.string().nullable().optional(),
      unpaidMicros: micros,
    })),
  })),
  checks: z.object({
    stale: z.boolean(),
    lastSheetsCollectAt: z.string().nullable(),
    lastRebuildAt: z.string().nullable(),
  }),
});

/** The ledger's micro-dollars as Hub's mills: pay is kept to the cent, so nothing is lost. */
function millsOf(value: number): number {
  return millsToNumber(microUsdToMills(microUsdFromDbInt(value)));
}

function checkWindow(from: string, to: string) {
  if (to < from) throw new BadRequestError("from is after to");
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  if (days > TEAM_LEDGER_PAYOUTS_MAX_DAYS) throw new BadRequestError(`At most ${TEAM_LEDGER_PAYOUTS_MAX_DAYS} days`);
}

type LedgerApp = Pick<AppContext, "db" | "config" | "logger">;

export async function readLedgerPayouts(
  app: LedgerApp,
  query: { from: string; to: string },
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<TeamLedgerPayoutsResponse> {
  checkWindow(query.from, query.to);
  const key = app.config.ledgerPayoutsKey ?? null;
  if (key === null) throw new ServiceUnavailableError("The ledger is not connected: LEDGER_PAYOUTS_KEY is not set");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const url = new URL("/v1/payouts", app.config.ledgerUrl ?? "https://ledger.gosling-agency.ru");
  url.searchParams.set("from", query.from);
  url.searchParams.set("to", query.to);

  let body: unknown;
  try {
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json", "user-agent": "agency-hub/workboard-payouts" },
      signal: AbortSignal.timeout(LEDGER_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ServiceUnavailableError(`The ledger answered GET /v1/payouts with ${response.status}`);
    }
    body = await response.json();
  } catch (error) {
    if (error instanceof ServiceUnavailableError) throw error;
    throw new ServiceUnavailableError(`The ledger did not answer GET /v1/payouts (${error instanceof Error ? error.name : "error"})`);
  }
  const parsed = ledgerPayoutsSchema.safeParse(body);
  if (!parsed.success) {
    app.logger.warn({ issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`) }, "ledger payouts: unexpected answer");
    throw new ServiceUnavailableError("The ledger's GET /v1/payouts answered in a shape Hub does not know");
  }
  const ledger = parsed.data;

  // A person is the Hub user whose username is their code, name or an alias (case aside).
  const users = await listUsers(app.db);
  const byName = new Map<string, { userId: number; username: string }>();
  for (const user of users) byName.set(user.username.toLowerCase(), { userId: user.id, username: user.username });
  const hubUserOf = (names: readonly string[]) => {
    for (const name of names) {
      const user = byName.get(name.trim().toLowerCase());
      if (user) return user;
    }
    return null;
  };

  return {
    from: ledger.from,
    to: ledger.to,
    accrualFrom: ledger.accrualFrom,
    generatedAt: ledger.generatedAt,
    people: ledger.people.map((person) => ({
      slug: person.slug,
      name: person.name,
      aliases: person.aliases,
      status: person.status,
      hubUser: hubUserOf([person.slug, person.name, ...person.aliases]),
      days: person.days.map((day) => ({ date: day.date, model: day.model, amountMills: millsOf(day.amountMicros), worked: day.worked, source: day.source })),
      accruedMills: millsOf(person.accruedMicros),
      paidMills: millsOf(person.paidMicros),
      balanceMills: millsOf(person.balanceMicros),
      toPayMills: person.toPayMicros === null ? null : millsOf(person.toPayMicros),
      oldestUnpaidDate: person.oldestUnpaidDate,
      unpaidDays: person.unpaidDays.map((day) => ({ date: day.date, kind: day.kind, model: day.model ?? null, unpaidMills: millsOf(day.unpaidMicros) })),
    })),
    checks: ledger.checks,
    serverNow: (options.now ?? new Date()).toISOString(),
  };
}
