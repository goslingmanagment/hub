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
/** The ledger's own limits (payroll/payouts.go): the debts are rebuilt every hour, the sheets collected every hour. */
const DEBTS_STALE_MS = 2 * 60 * 60_000;
const SHEETS_STALE_MS = 3 * 60 * 60_000;

/** Whether a ledger moment is older than `limit` at `now`; never (null) or unreadable — old. */
export function olderThan(at: string | null, limit: number, now: Date): boolean {
  if (at === null) return true;
  const time = Date.parse(at);
  return Number.isNaN(time) || now.getTime() - time > limit;
}

export const micros = z.number().int();
/** Go writes an empty slice as null. */
export const list = <T extends z.ZodTypeAny>(item: T) => z.array(item).nullable().transform((value): Array<z.output<T>> => value ?? []);

/** A paid day whose report changed since: the ledger's camelCase or the reports' snake_case. */
const pendingChange = z.object({
  id: z.number().int().positive(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  model: z.string().nullish(),
  postedMicros: micros.optional(),
  posted_micros: micros.optional(),
  newMicros: micros.optional(),
  new_micros: micros.optional(),
  reason: z.string().nullish(),
}).transform((change, context) => {
  const posted = change.postedMicros ?? change.posted_micros;
  const fresh = change.newMicros ?? change.new_micros;
  if (posted === undefined || fresh === undefined) {
    context.addIssue({ code: "custom", message: "a pending change without its amounts" });
    return z.NEVER;
  }
  return { id: change.id, day: change.day, model: change.model ?? "", postedMicros: posted, newMicros: fresh, reason: change.reason ?? "" };
});

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
    // The Hub user the ledger knows the person as, when it says (it beats the name match below).
    hubUserId: z.number().int().positive().nullish(),
    hub_user_id: z.number().int().positive().nullish(),
    // A ledger before the reports' pay base answers without them: none known. Present, they are read in full.
    pendingChanges: list(pendingChange).optional(),
    pending_changes: list(pendingChange).optional(),
  })),
  // The switches of the accruals (`sheet` before both), in either spelling; absent — not switched or not said.
  factsFrom: z.string().nullish(),
  facts_from: z.string().nullish(),
  reportsFrom: z.string().nullish(),
  reports_from: z.string().nullish(),
  // Which switches price the days (ledger: payroll_terms_hub_from, payroll_basis_hub_from); null or absent — off.
  termsHubFrom: z.string().nullish(),
  basisHubFrom: z.string().nullish(),
  checks: z.object({
    stale: z.boolean(),
    lastSheetsCollectAt: z.string().nullable(),
    lastRebuildAt: z.string().nullable(),
  }),
});

/**
 * The ledger's micro-dollars of SALES (a report's pages and lines, a post's sums, a sale's net) as Hub's mills, the
 * thousandths kept as a sale has them. Never pay: a debt, an accrual or a payout is `payMillsOf`, the one conversion
 * of people's pay.
 */
export function millsOf(value: number): number {
  return millsToNumber(microUsdToMills(microUsdFromDbInt(value)));
}

/**
 * The ledger's micro-dollars of PAY as mills of the ledger's own whole cents (its money.RoundCents: half to even):
 * a debt, an accrual or a payout reads on the screen exactly as `ledger payables` and `ledger payout prepare` print
 * it, never a cent off by Hub's truncation of the thousandths. Pay only: the reports' drafts keep their thousandths.
 */
export function payMillsOf(value: number): number {
  let cents = Math.trunc(value / 10_000);
  let rest = value % 10_000;
  if (rest < 0) {
    cents -= 1;
    rest += 10_000;
  }
  if (rest > 5_000 || (rest === 5_000 && cents % 2 !== 0)) cents += 1;
  return cents * 10;
}

/** A window of Moscow days the ledger takes: `from` not after `to`, at most `maxDays` of them; else a 400. */
export function checkWindow(from: string, to: string, maxDays: number = TEAM_LEDGER_PAYOUTS_MAX_DAYS) {
  if (to < from) throw new BadRequestError("from is after to");
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  if (days > maxDays) throw new BadRequestError(`At most ${maxDays} days`);
}

type LedgerApp = Pick<AppContext, "db" | "config" | "logger">;

const BUSINESS_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Which Hub user a ledger person is: the Hub user id the ledger gives, when that user exists; else the user whose
 * username is one of their names (code, name, an alias; case aside). Built once per answer from the live users.
 */
export function hubUsersOf(users: ReadonlyArray<{ id: number; username: string }>) {
  const byId = new Map<number, { userId: number; username: string }>();
  const byName = new Map<string, { userId: number; username: string }>();
  for (const user of users) {
    const hub = { userId: user.id, username: user.username };
    byId.set(user.id, hub);
    byName.set(user.username.toLowerCase(), hub);
  }
  return (hubUserId: number | null, names: readonly string[]): { userId: number; username: string } | null => {
    if (hubUserId !== null) {
      const user = byId.get(hubUserId);
      if (user) return user;
    }
    for (const name of names) {
      const user = byName.get(name.trim().toLowerCase());
      if (user) return user;
    }
    return null;
  };
}

/** What the ledger's GET helper needs from the app: where the ledger is, its key, a logger. */
export type LedgerReadApp = Pick<AppContext, "config" | "logger">;

/** The payout routes' 404: the ledger knows no payout tab of the person. */
const NO_PAYOUT_TAB = "The ledger has no payout tab of this person";

/**
 * One GET of the ledger with Hub's payouts key: the answer's JSON, or a 503 when the ledger is not connected, does
 * not answer or refuses. Its 404 is a 404 here only for a caller that names what was not found (`notFound`: an
 * unknown person); for anyone else it is a 503 like every other refusal — except the statuses a caller lists in
 * `absentOn`, which answer `undefined` (a read the ledger does not open to Hub yet). `client` names the caller in
 * the user agent.
 */
export async function ledgerGet(
  app: LedgerReadApp,
  path: string,
  params: Record<string, string>,
  options: { fetchImpl?: typeof fetch; notFound?: string; client?: string; absentOn?: readonly number[] },
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
      // A read the ledger does not open to Hub's key yet (`absentOn`): no answer, for the caller to say so.
      if (options.absentOn?.includes(response.status)) return undefined;
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
  const now = options.now ?? new Date();

  const hubUserOf = hubUsersOf(await listUsers(app.db));
  const dayOrNull = (value: string | null | undefined) => (value !== null && value !== undefined && BUSINESS_DAY.test(value) ? value : null);

  return {
    from: ledger.from,
    to: ledger.to,
    accrualFrom: ledger.accrualFrom,
    factsFrom: dayOrNull(ledger.factsFrom ?? ledger.facts_from),
    reportsFrom: dayOrNull(ledger.reportsFrom ?? ledger.reports_from),
    termsHubFrom: dayOrNull(ledger.termsHubFrom),
    basisHubFrom: dayOrNull(ledger.basisHubFrom),
    generatedAt: ledger.generatedAt,
    people: ledger.people.map((person) => ({
      slug: person.slug,
      name: person.name,
      aliases: person.aliases,
      status: person.status,
      hubUser: hubUserOf(person.hubUserId ?? person.hub_user_id ?? null, [person.slug, person.name, ...person.aliases]),
      days: person.days.map((day) => ({ date: day.date, model: day.model, amountMills: payMillsOf(day.amountMicros), worked: day.worked, source: day.source })),
      accruedMills: payMillsOf(person.accruedMicros),
      paidMills: payMillsOf(person.paidMicros),
      balanceMills: payMillsOf(person.balanceMicros),
      toPayMills: person.toPayMicros === null ? null : payMillsOf(person.toPayMicros),
      oldestUnpaidDate: person.oldestUnpaidDate,
      unpaidDays: person.unpaidDays.map((day) => ({ date: day.date, kind: day.kind, model: day.model ?? null, unpaidMills: payMillsOf(day.unpaidMicros) })),
      unentered: { days: person.unentered.days, shareMills: payMillsOf(person.unentered.shareMicros), unknown: person.unentered.unknown },
      pendingChanges: (person.pendingChanges ?? person.pending_changes ?? []).map((change) => ({ id: change.id, day: change.day, model: change.model, postedMills: payMillsOf(change.postedMicros), newMills: payMillsOf(change.newMicros), reason: change.reason })),
    })),
    checks: {
      ...ledger.checks,
      // Each number names its own source: the debts are the ledger's rebuild, «в таблице» alone is the sheets'.
      debtsStale: olderThan(ledger.checks.lastRebuildAt, DEBTS_STALE_MS, now),
      sheetsStale: olderThan(ledger.checks.lastSheetsCollectAt, SHEETS_STALE_MS, now),
    },
    serverNow: now.toISOString(),
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
  lines: list(z.object({ kind: z.string(), model: z.string().optional(), text: z.string(), shownMicros: micros, from: z.string().optional(), to: z.string().optional() })),
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
    amountMills: payMillsOf(brief.amountMicros),
    nothing: brief.nothing ?? null,
    toPayMills: brief.toPayMicros === null ? null : payMillsOf(brief.toPayMicros),
    period: brief.period,
    lines: brief.lines.map((line) => ({
      kind: line.kind,
      model: line.model ?? null,
      text: line.text,
      shownMills: payMillsOf(line.shownMicros),
      from: line.from !== undefined && BUSINESS_DAY.test(line.from) ? line.from : null,
      to: line.to !== undefined && BUSINESS_DAY.test(line.to) ? line.to : null,
    })),
    flags: brief.flags,
    blockers: brief.blockers,
    suggestion: brief.suggestion === null ? null : {
      transferMills: payMillsOf(brief.suggestion.transferMicros),
      aboveTableMills: payMillsOf(brief.suggestion.aboveTableMicros),
      note: brief.suggestion.note,
    },
    message: brief.message ?? null,
    placeholder: brief.placeholder ?? null,
  };
}
