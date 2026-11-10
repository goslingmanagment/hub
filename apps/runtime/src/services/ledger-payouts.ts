import { z } from "zod";

import { TEAM_LEDGER_PAYOUTS_MAX_DAYS, type TeamLedgerPayoutPrepareResponse, type TeamLedgerPayoutsResponse } from "@agency_hub_core/contracts";
import { listUsers } from "@agency_hub_core/db";
import { microUsdFromDbInt, microUsdToMills, millsToNumber } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { BadRequestError, NotFoundError, ServiceUnavailableError } from "./errors.ts";

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

export const micros = z.number().int();
/** Go writes an empty slice as null. */
export const list = <T extends z.ZodTypeAny>(item: T) => z.array(item).nullable().transform((value): Array<z.output<T>> => value ?? []);

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
    // A ledger before «не занесено» in /v1/payouts answers without it: none known.
    unentered: z.object({ days: z.number().int().nonnegative(), shareMicros: micros, unknown: z.number().int().nonnegative() })
      .default({ days: 0, shareMicros: 0, unknown: 0 }),
  })),
  checks: z.object({
    stale: z.boolean(),
    lastSheetsCollectAt: z.string().nullable(),
    lastRebuildAt: z.string().nullable(),
  }),
});

/** The ledger's micro-dollars as Hub's mills: pay is kept to the cent, so nothing is lost. */
export function millsOf(value: number): number {
  return millsToNumber(microUsdToMills(microUsdFromDbInt(value)));
}

/** A window of Moscow days the ledger takes: `from` not after `to`, at most `maxDays` of them; else a 400. */
export function checkWindow(from: string, to: string, maxDays: number = TEAM_LEDGER_PAYOUTS_MAX_DAYS) {
  if (to < from) throw new BadRequestError("from is after to");
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  if (days > maxDays) throw new BadRequestError(`At most ${maxDays} days`);
}

type LedgerApp = Pick<AppContext, "db" | "config" | "logger">;

/** What the ledger's GET helper needs from the app: where the ledger is, its key, a logger. */
export type LedgerReadApp = Pick<AppContext, "config" | "logger">;

/** The payout routes' 404: the ledger knows no payout tab of the person. */
const NO_PAYOUT_TAB = "The ledger has no payout tab of this person";

/**
 * One GET of the ledger with Hub's payouts key: the answer's JSON, or a 503 when the ledger is not connected, does
 * not answer or refuses. Its 404 is a 404 here only for a caller that names what was not found (`notFound`: an
 * unknown person); for anyone else it is a 503 like every other refusal. `client` names the caller in the user agent.
 */
export async function ledgerGet(
  app: LedgerReadApp,
  path: string,
  params: Record<string, string>,
  options: { fetchImpl?: typeof fetch; notFound?: string; client?: string },
): Promise<unknown> {
  const key = app.config.ledgerPayoutsKey ?? null;
  if (key === null) throw new ServiceUnavailableError("The ledger is not connected: LEDGER_PAYOUTS_KEY is not set");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const url = new URL(path, app.config.ledgerUrl ?? "https://ledger.gosling-agency.ru");
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  try {
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json", "user-agent": `agency-hub/${options.client ?? "workboard-payouts"}` },
      signal: AbortSignal.timeout(LEDGER_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 404 && options.notFound !== undefined) throw new NotFoundError(options.notFound);
      throw new ServiceUnavailableError(`The ledger answered GET ${path} with ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof ServiceUnavailableError || error instanceof NotFoundError) throw error;
    throw new ServiceUnavailableError(`The ledger did not answer GET ${path} (${error instanceof Error ? error.name : "error"})`);
  }
}

export async function readLedgerPayouts(
  app: LedgerApp,
  query: { from: string; to: string },
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<TeamLedgerPayoutsResponse> {
  checkWindow(query.from, query.to);
  const body = await ledgerGet(app, "/v1/payouts", { from: query.from, to: query.to }, { ...options, notFound: NO_PAYOUT_TAB });
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
      unentered: { days: person.unentered.days, shareMills: millsOf(person.unentered.shareMicros), unknown: person.unentered.unknown },
    })),
    checks: ledger.checks,
    serverNow: (options.now ?? new Date()).toISOString(),
  };
}

const ledgerPrepareSchema = z.object({
  slug: z.string(),
  name: z.string(),
  generatedAt: z.string(),
  amountMicros: micros,
  nothing: z.string().optional(),
  toPayMicros: micros.nullable(),
  period: z.object({ from: z.string(), to: z.string() }).nullable(),
  lines: list(z.object({ kind: z.string(), model: z.string().optional(), text: z.string(), shownMicros: micros })),
  flags: list(z.object({ kind: z.string(), blocker: z.boolean(), text: z.string() })),
  blockers: z.number().int().nonnegative(),
  suggestion: z.object({ transferMicros: micros, aboveTableMicros: micros, note: z.string() }).nullable(),
  message: z.string().optional(),
  placeholder: z.string().optional(),
});

/**
 * One person's payout brief from the ledger (L5 `payout prepare`): what to transfer, the lines, what blocks it, and
 * the chatter's message with the transfer left as a placeholder. Read-only: nothing is recorded or sent.
 */
export async function readLedgerPayoutPrepare(
  app: LedgerApp,
  query: { person: string },
  options: { fetchImpl?: typeof fetch } = {},
): Promise<TeamLedgerPayoutPrepareResponse> {
  const body = await ledgerGet(app, "/v1/payouts/prepare", { person: query.person }, { ...options, notFound: NO_PAYOUT_TAB });
  const parsed = ledgerPrepareSchema.safeParse(body);
  if (!parsed.success) {
    app.logger.warn({ issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`) }, "ledger payout prepare: unexpected answer");
    throw new ServiceUnavailableError("The ledger's GET /v1/payouts/prepare answered in a shape Hub does not know");
  }
  const brief = parsed.data;
  return {
    slug: brief.slug,
    name: brief.name,
    generatedAt: brief.generatedAt,
    amountMills: millsOf(brief.amountMicros),
    nothing: brief.nothing ?? null,
    toPayMills: brief.toPayMicros === null ? null : millsOf(brief.toPayMicros),
    period: brief.period,
    lines: brief.lines.map((line) => ({ kind: line.kind, model: line.model ?? null, text: line.text, shownMills: millsOf(line.shownMicros) })),
    flags: brief.flags,
    blockers: brief.blockers,
    suggestion: brief.suggestion === null ? null : {
      transferMills: millsOf(brief.suggestion.transferMicros),
      aboveTableMills: millsOf(brief.suggestion.aboveTableMicros),
      note: brief.suggestion.note,
    },
    message: brief.message ?? null,
    placeholder: brief.placeholder ?? null,
  };
}
