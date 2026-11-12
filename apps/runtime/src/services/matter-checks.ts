import { z } from "zod";

import {
  AGENT_KEY_EXPIRING_DAYS,
  LEDGER_CHECK_RED_HOURS,
  LEDGER_OFF_PLATFORM_DAYS,
  MATTER_CHECK_KIND_PERIODS,
  PEOPLE_ACCESS_IDLE_DAYS,
  type MatterCheckKind,
} from "@agency_hub_core/contracts";
import {
  listMatterChecks,
  listMatterPageLabels,
  listOpenMattersOfKinds,
  matterChanges,
  readPeopleCheckSnapshot,
  recordMatterCheckAnswered,
  recordMatterCheckFailed,
  type MatterCheckRow,
  type MatterOwner,
  type MatterSource,
  type PeopleCheckSnapshot,
} from "@agency_hub_core/db";
import { MOSCOW_TIME_ZONE, toBusinessDate } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { ServiceUnavailableError } from "./errors.ts";
import { ledgerGet, list, micros, millsOf, type LedgerReadApp } from "./ledger-payouts.ts";
import { reconcileMatters, type MirrorItem } from "./matters-mirror.ts";

/**
 * Проверки (ecosystem plan §6, package K): the checks Hub's server keeps as
 * matters for the owner besides the mirrors of package D.
 *
 *  - People and access, from the people registry, the logins, their device
 *    tokens, the agent keys, the pages each login may open and the
 *    extension's activity: a person who left with something still alive, a
 *    login no person holds, a working chatter without pay terms or working
 *    pages, a page worked without access, an agent key about to expire, and
 *    once a week one line of access nobody uses. Service and test logins are
 *    people of kind `service` and never appear. A pay term is only asked
 *    whether it exists: no rate or sum reaches a matter.
 *  - The ledger's, read with Hub's payouts key (GET only): its checks red
 *    longer than a threshold (`failingSince`, one matter per check key, the
 *    ledger's own sentence: money, the owner's alone), its notice of payout
 *    tabs with no column for tomorrow (one matter listing them), and
 *    off-platform sales still not in a report after N days.
 *
 * Every matter closes itself when its cause goes away (`cause_gone`). A source
 * that does not answer leaves its kinds' matters as they are and the kinds
 * «не проверено» (matter_checks). `dryRun` reads everything and writes
 * nothing: it says what each kind would open, update and close.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Every kind here waits for the owner: the people's access and the ledger's money are theirs alone. */
const OWNER: MatterOwner = { role: "owner" };
const SOURCE: Record<MatterCheckKind, MatterSource> = {
  "people.left_with_access": "server",
  "people.login_unlinked": "server",
  "people.no_pay_terms": "server",
  "people.no_working_page": "server",
  "people.page_without_access": "server",
  "people.access_idle": "server",
  "people.agent_key_expiring": "server",
  "ledger.check": "ledger",
  "ledger.sheet_column": "ledger",
  "ledger.off_platform": "ledger",
};

/** How often a kind's source is asked. */
export function matterCheckPeriodMs(kind: MatterCheckKind): number {
  return MATTER_CHECK_KIND_PERIODS[kind] * MINUTE;
}

function plural(count: number, one: string, few: string, many: string): string {
  const tens = count % 100;
  const units = count % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (units === 1) return one;
  if (units >= 2 && units <= 4) return few;
  return many;
}

/** A Moscow day as people read it: «14.11». */
function shortDay(at: Date): string {
  const [, month, day] = toBusinessDate(at, MOSCOW_TIME_ZONE).split("-");
  return `${day}.${month}`;
}

// ── People and access ───────────────────────────────────────────────────────

const PAID_ROLES: ReadonlySet<string> = new Set(["chatter", "team_lead"]);

export type PeopleCheckKind = Extract<MatterCheckKind, `people.${string}`>;

/** Where a person is opened: their card in Workboard «Люди» (`/people/:code`, a tab of it). */
function personLink(code: string, tab = ""): string {
  return `/workboard/people/${encodeURIComponent(code)}${tab}`;
}

/**
 * The people checks on one snapshot: every kind's findings. Pure; the rules
 * of package K item 1. `now` decides the keys' expiry and the idle window.
 */
export function peopleCheckItems(snapshot: PeopleCheckSnapshot, now: Date): Record<PeopleCheckKind, MirrorItem[]> {
  const out: Record<PeopleCheckKind, MirrorItem[]> = {
    "people.left_with_access": [],
    "people.login_unlinked": [],
    "people.no_pay_terms": [],
    "people.no_working_page": [],
    "people.page_without_access": [],
    "people.access_idle": [],
    "people.agent_key_expiring": [],
  };
  const pageOf = new Map(snapshot.pages.map((page) => [page.id, page]));
  const personById = new Map(snapshot.people.map((person) => [person.id, person]));
  const loginsOf = (personId: number) => snapshot.logins.filter((login) => login.personId === personId);
  const liveKey = (key: { revokedAt: Date | null; expiresAt: Date }) => key.revokedAt === null && key.expiresAt.getTime() > now.getTime();

  for (const person of snapshot.people) {
    if (person.kind === "service") continue;
    const logins = loginsOf(person.id);
    const living = logins.filter((login) => login.living);

    if (person.state === "left") {
      const keys = snapshot.agentKeys.filter((key) => key.personId === person.id && liveKey(key));
      const tokens = logins.reduce((sum, login) => sum + login.liveDeviceTokens, 0);
      if (living.length > 0 || tokens > 0 || keys.length > 0) {
        out["people.left_with_access"].push({
          key: `people.left_with_access:${person.code}`,
          title: `Ушёл, а доступ жив: ${person.displayName}`,
          object: { type: "person", id: person.code },
          pageLabels: [],
          money: false,
          evidence: {
            person: person.code, leftOn: person.leftOn, logins: living.map((login) => login.username), deviceTokens: tokens,
            agentKeys: keys.map((key) => key.name),
          },
          link: personLink(person.code, "/access"),
        });
      }
      continue;
    }

    if (person.kind !== "human" || person.state !== "working") continue;

    if (PAID_ROLES.has(person.role)) {
      if (!snapshot.withPayTerms.has(person.id)) {
        out["people.no_pay_terms"].push({
          key: `people.no_pay_terms:${person.code}`,
          title: `Нет условий оплаты: ${person.displayName}`,
          object: { type: "person", id: person.code },
          pageLabels: [],
          money: false,
          evidence: { person: person.code, role: person.role },
          link: personLink(person.code),
        });
      }
      if ((snapshot.workingPages.get(person.id) ?? []).length === 0) {
        out["people.no_working_page"].push({
          key: `people.no_working_page:${person.code}`,
          title: `Нет рабочих страниц: ${person.displayName}`,
          object: { type: "person", id: person.code },
          pageLabels: [],
          money: false,
          evidence: { person: person.code, role: person.role },
          link: personLink(person.code),
        });
      }
    }

    // The owner opens every page: their access is never a question.
    if (person.role === "owner") continue;
    const reachable = new Set(living.flatMap((login) => snapshot.access.get(login.userId) ?? []));
    const worked = snapshot.workingPages.get(person.id) ?? [];
    const without = worked.filter((pageId) => !reachable.has(pageId)).map((pageId) => pageOf.get(pageId)?.label).filter((label): label is string => label !== undefined);
    if (without.length > 0) {
      out["people.page_without_access"].push({
        key: `people.page_without_access:${person.code}`,
        title: `Работает без доступа: ${person.displayName}, ${without.join(", ")}`,
        object: { type: "person", id: person.code },
        pageLabels: without,
        money: false,
        evidence: { person: person.code, pages: without, logins: living.map((login) => login.username) },
        link: personLink(person.code, "/access"),
      });
    }
  }

  // A living login no person holds. A person whose code is its name is only a hint: a link is never guessed.
  for (const login of snapshot.logins) {
    if (!login.living || login.personId !== null) continue;
    const namesake = snapshot.people.find((person) => person.code === login.username.toLowerCase());
    out["people.login_unlinked"].push({
      key: `people.login_unlinked:${login.userId}`,
      title: `Вход без человека: ${login.username}`,
      object: { type: "user", id: String(login.userId) },
      pageLabels: [],
      money: false,
      evidence: {
        userId: login.userId, username: login.username, role: login.role, deviceTokens: login.liveDeviceTokens,
        namesake: namesake === undefined ? null : { person: namesake.code, name: namesake.displayName, state: namesake.state, leftOn: namesake.leftOn },
      },
      link: `/workboard/people/${login.userId}/access`,
    });
  }

  // An agent key about to end, or ended and still not revoked (a month of it, then it is history).
  for (const key of snapshot.agentKeys) {
    if (key.revokedAt !== null) continue;
    const left = key.expiresAt.getTime() - now.getTime();
    if (left > AGENT_KEY_EXPIRING_DAYS * DAY || left < -30 * DAY) continue;
    const person = key.personId === null ? undefined : personById.get(key.personId);
    out["people.agent_key_expiring"].push({
      key: `people.agent_key_expiring:${key.id}`,
      title: left > 0 ? `Ключ агента истекает ${shortDay(key.expiresAt)}: ${key.name}` : `Ключ агента истёк ${shortDay(key.expiresAt)}: ${key.name}`,
      object: { type: "agent_key", id: String(key.id) },
      pageLabels: [],
      money: false,
      evidence: { keyId: key.id, name: key.name, expiresAt: key.expiresAt.toISOString(), person: person?.code ?? null },
      link: "/system/agent-keys",
    });
  }

  // Information, once a week: pages a working person may open, does not work and did not touch for 30 days. A page
  // of Telegram is left out: the extension never beats on it, so «not touched» would always be true.
  const idle: Array<{ person: string; name: string; pages: string[] }> = [];
  for (const person of snapshot.people) {
    if (person.kind !== "human" || person.state !== "working" || person.role === "owner") continue;
    const worked = new Set(snapshot.workingPages.get(person.id) ?? []);
    const pages = new Set<string>();
    for (const login of loginsOf(person.id).filter((one) => one.living)) {
      for (const pageId of snapshot.access.get(login.userId) ?? []) {
        const page = pageOf.get(pageId);
        if (page === undefined || page.platform === "telegram" || worked.has(pageId)) continue;
        const touched = loginsOf(person.id).some((one) => snapshot.lastInput.has(`${one.userId}:${pageId}`));
        if (!touched) pages.add(page.label);
      }
    }
    if (pages.size > 0) idle.push({ person: person.code, name: person.displayName, pages: [...pages].sort() });
  }
  if (idle.length > 0) {
    const pageCount = idle.reduce((sum, one) => sum + one.pages.length, 0);
    const since = snapshot.activitySince !== null && snapshot.activitySince.getTime() > now.getTime() - PEOPLE_ACCESS_IDLE_DAYS * DAY
      ? toBusinessDate(snapshot.activitySince, MOSCOW_TIME_ZONE)
      : null;
    out["people.access_idle"].push({
      key: "people.access_idle:all",
      title: `Доступ без работы ${PEOPLE_ACCESS_IDLE_DAYS} дней: ${pageCount} ${plural(pageCount, "страница", "страницы", "страниц")} у ${idle.length} ${plural(idle.length, "человека", "человек", "человек")}`,
      object: null,
      pageLabels: [],
      money: false,
      // `activitySince`: the extension's activity is known only from this day, when it is younger than the window.
      evidence: { days: PEOPLE_ACCESS_IDLE_DAYS, activitySince: since, people: idle },
      link: "/workboard/people",
    });
  }
  return out;
}

// ── The ledger ──────────────────────────────────────────────────────────────

/** The ledger's checks as GET /v1/payouts/checks answers them (ledger #80). */
const ledgerChecksSchema = z.object({
  at: z.string(),
  checks: list(z.object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    name: z.string(),
    ok: z.boolean(),
    severity: z.string(),
    summary: z.string(),
    at: z.string().nullish(),
    failingSince: z.string().nullish(),
  })),
  weekColumns: z.object({
    tabs: list(z.object({ model: z.string(), tab: z.string(), person: z.string().nullish(), tomorrow: z.string(), lastColumn: z.string().nullish() })),
  }),
});
export type LedgerChecksAnswer = z.output<typeof ledgerChecksSchema>;

/** The checks whose findings Hub already keeps as matters of their own (package D's mirror): not a second line. */
const MIRRORED_LEDGER_CHECKS: ReadonlySet<string> = new Set(["pending_changes", "report_posts"]);

const LEDGER_CLIENT = "matters-checks";

/** GET /v1/payouts/checks; a ledger that does not open it to Hub's key yet (403, 404) is a source that did not answer. */
export async function readLedgerChecks(app: LedgerReadApp, options: { fetchImpl?: typeof fetch } = {}): Promise<LedgerChecksAnswer> {
  const body = await ledgerGet(app, "/v1/payouts/checks", {}, { client: LEDGER_CLIENT, absentOn: [403, 404], ...options });
  if (body === undefined) throw new ServiceUnavailableError("The ledger does not open GET /v1/payouts/checks to Hub's key");
  const parsed = ledgerChecksSchema.safeParse(body);
  if (!parsed.success) {
    app.logger.warn({ issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`) }, "matter checks: unexpected answer of the ledger's checks");
    throw new ServiceUnavailableError("The ledger's GET /v1/payouts/checks answered in a shape Hub does not know");
  }
  return parsed.data;
}

/** How long a red check waits before it is a matter. */
export function ledgerCheckThresholdMs(severity: string): number {
  return (severity === "urgent" ? LEDGER_CHECK_RED_HOURS.urgent : LEDGER_CHECK_RED_HOURS.other) * HOUR;
}

/**
 * The ledger's red checks as matters: one per check key, only once it has been
 * red longer than its threshold. `waiting` — the red ones still under it (a dry
 * run says them).
 */
export function ledgerCheckItems(answer: LedgerChecksAnswer, now: Date): { items: MirrorItem[]; waiting: Array<{ key: string; name: string; failingSince: string | null }> } {
  const items: MirrorItem[] = [];
  const waiting: Array<{ key: string; name: string; failingSince: string | null }> = [];
  for (const check of answer.checks) {
    if (check.ok || MIRRORED_LEDGER_CHECKS.has(check.key)) continue;
    const since = check.failingSince ? Date.parse(check.failingSince) : Number.NaN;
    // A red check without its first moment cannot be timed: it waits, as one red for less than its threshold does.
    if (Number.isNaN(since) || now.getTime() - since < ledgerCheckThresholdMs(check.severity)) {
      waiting.push({ key: check.key, name: check.name, failingSince: check.failingSince ?? null });
      continue;
    }
    items.push({
      key: `ledger.check:${check.key}`,
      title: `Проверка ledger не проходит: ${check.name}`,
      object: { type: "ledger_check", id: check.key },
      pageLabels: [],
      // The ledger's sentence may name balances and charges: the owner's alone.
      money: true,
      evidence: { check: check.key, name: check.name, severity: check.severity, summary: check.summary.slice(0, 1500), failingSince: new Date(since).toISOString() },
      link: null,
    });
  }
  return { items, waiting };
}

/** The ledger's notice: payout tabs someone works with no column for tomorrow, one matter listing them. */
export function sheetColumnItems(answer: LedgerChecksAnswer): MirrorItem[] {
  const tabs = answer.weekColumns.tabs;
  if (tabs.length === 0) return [];
  const tomorrow = tabs[0]!.tomorrow;
  const [, month, day] = tomorrow.split("-");
  const names = tabs.map((tab) => `${tab.model}/${tab.tab}`);
  return [{
    key: "ledger.sheet_column:tomorrow",
    title: `Нет колонки на ${day}.${month} во ${tabs.length === 1 ? "вкладке" : "вкладках"} выплат: ${names.join(", ")}`,
    object: null,
    pageLabels: [],
    money: false,
    evidence: { tomorrow, tabs: tabs.map((tab) => ({ model: tab.model, tab: tab.tab, person: tab.person ?? null, lastColumn: tab.lastColumn || null })) },
    link: null,
  }];
}

/** An open decision of the ledger (GET /v1/decisions?open=1), as much as the off-platform check needs. */
const ledgerDecisionsSchema = z.object({
  decisions: list(z.object({
    id: z.number().int().positive(),
    page_label: z.string(),
    kind: z.string(),
    status: z.string(),
    net_micros: micros.nullish(),
    shares: list(z.object({ person: z.string(), percent: z.number() })).optional(),
    said_by: z.string().nullish(),
    said_at: z.string().nullish(),
    source_link: z.string().nullish(),
    created_at: z.string().nullish(),
  })),
});
export type LedgerDecisions = z.output<typeof ledgerDecisionsSchema>;

export async function readLedgerOpenDecisions(app: LedgerReadApp, options: { fetchImpl?: typeof fetch } = {}): Promise<LedgerDecisions> {
  const body = await ledgerGet(app, "/v1/decisions", { open: "1" }, { client: LEDGER_CLIENT, ...options });
  const parsed = ledgerDecisionsSchema.safeParse(body);
  if (!parsed.success) {
    app.logger.warn({ issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`) }, "matter checks: unexpected answer of the ledger's decisions");
    throw new ServiceUnavailableError("The ledger's GET /v1/decisions answered in a shape Hub does not know");
  }
  return parsed.data;
}

/** A ledger moment: a day (`YYYY-MM-DD`, Moscow) or a time. */
function ledgerMoment(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00+03:00`) : Date.parse(value);
}

/**
 * Off-platform sales («мимо площадки», the ledger's decisions of kind
 * `off_platform`) still open — taken into nobody's report — N days after they
 * were said. The ledger links no receipt to such a sale yet, so «without
 * money» is «not in a report». Never the fan.
 */
export function offPlatformItems(answer: LedgerDecisions, now: Date): MirrorItem[] {
  const items: MirrorItem[] = [];
  for (const decision of answer.decisions) {
    if (decision.kind !== "off_platform" || decision.status !== "open") continue;
    const said = Number.isNaN(ledgerMoment(decision.said_at)) ? ledgerMoment(decision.created_at) : ledgerMoment(decision.said_at);
    if (Number.isNaN(said)) continue;
    const days = Math.floor((now.getTime() - said) / DAY);
    if (days < LEDGER_OFF_PLATFORM_DAYS) continue;
    const telegram = decision.source_link && /^https:\/\/t\.me\//.test(decision.source_link) ? decision.source_link : null;
    items.push({
      key: `ledger.off_platform:${decision.id}`,
      title: `Мимо площадки, ${days} ${plural(days, "день", "дня", "дней")} не в отчёте: ${decision.page_label}`,
      object: { type: "ledger_decision", id: String(decision.id) },
      pageLabels: decision.page_label === "" ? [] : [decision.page_label],
      money: true,
      evidence: {
        decisionId: decision.id, saidAt: new Date(said).toISOString(), saidBy: decision.said_by ?? null,
        netMills: decision.net_micros === null || decision.net_micros === undefined ? null : millsOf(decision.net_micros),
        shares: (decision.shares ?? []).map((share) => ({ person: share.person, percent: share.percent })),
        telegram,
      },
      link: null,
    });
  }
  return items;
}

// ── The pass ────────────────────────────────────────────────────────────────

export interface MatterChecksTally {
  answered: MatterCheckKind[];
  failed: MatterCheckKind[];
  opened: number;
  closed: number;
}

/** What a dry run says of one kind: what it would open, change and close; nothing is written. */
export interface MatterCheckDryKind {
  kind: MatterCheckKind;
  answered: boolean;
  error?: string;
  wouldOpen: Array<{ key: string; title: string }>;
  wouldUpdate: Array<{ key: string; title: string; fields: string[] }>;
  wouldClose: Array<{ key: string; title: string }>;
  unchanged: number;
  /** The ledger's red checks still under their threshold. */
  waiting?: Array<{ key: string; name: string; failingSince: string | null }>;
}

type ChecksApp = Pick<AppContext, "db" | "config" | "logger">;

const errorText = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 300);

/**
 * One pass of the checks: each due kind's source read and its matters made
 * what it says. Never throws for a source. With `dryRun` every kind is read
 * whether due or not and nothing is written: the answer says what would move.
 */
export async function runMatterChecks(
  app: ChecksApp,
  options: { now?: Date; fetchImpl?: typeof fetch; dryRun?: boolean } = {},
): Promise<{ tally: MatterChecksTally; dry: MatterCheckDryKind[] }> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;
  const checks = new Map<string, MatterCheckRow>((await listMatterChecks(app.db)).map((check) => [check.kind, check]));
  const due = (kind: MatterCheckKind) => {
    if (dryRun) return true;
    const check = checks.get(kind);
    return check === undefined || now.getTime() - check.attemptedAt.getTime() >= matterCheckPeriodMs(kind) - 5_000;
  };
  const tally: MatterChecksTally = { answered: [], failed: [], opened: 0, closed: 0 };
  const dry: MatterCheckDryKind[] = [];
  const { idOf } = await listMatterPageLabels(app.db);
  const fetchOptions = options.fetchImpl ? { fetchImpl: options.fetchImpl } : {};

  const failed = async (kinds: readonly MatterCheckKind[], error: unknown) => {
    for (const kind of kinds) {
      if (dryRun) {
        dry.push({ kind, answered: false, error: errorText(error), wouldOpen: [], wouldUpdate: [], wouldClose: [], unchanged: 0 });
        continue;
      }
      if (checks.get(kind)?.error == null) app.logger.warn({ kind, err: error }, "matter checks: the source did not answer; the kind reads «не проверено»");
      tally.failed.push(kind);
      await recordMatterCheckFailed(app.db, { kind, at: now, error: errorText(error) }).catch((recordError: unknown) => {
        app.logger.error({ kind, err: recordError }, "matter checks: the failed check could not be recorded");
      });
    }
  };

  const apply = async (kind: MatterCheckKind, items: MirrorItem[], extra: Pick<MatterCheckDryKind, "waiting"> = {}) => {
    if (dryRun) {
      dry.push({ kind, answered: true, ...dryDiff(kind, items, await listOpenMattersOfKinds(app.db, [kind]), idOf), ...extra });
      return;
    }
    try {
      const done = await reconcileMatters(app, { kind, source: SOURCE[kind], owner: OWNER, items }, idOf, now);
      tally.opened += done.opened;
      tally.closed += done.closed;
      const findings = new Set(items.map((item) => item.key)).size;
      const open = (await listOpenMattersOfKinds(app.db, [kind])).length;
      await recordMatterCheckAnswered(app.db, { kind, at: now, applicable: true, capped: false, legacyCount: findings, matterCount: open });
      if (findings !== open) app.logger.warn({ kind, findings, open }, "matter checks: not every finding is an open matter");
      if (checks.get(kind)?.error) app.logger.info({ kind }, "matter checks: the source answers again");
      tally.answered.push(kind);
    } catch (error) {
      await failed([kind], error);
    }
  };

  // People and access: one snapshot for every due kind.
  const peopleKinds = (Object.keys(MATTER_CHECK_KIND_PERIODS) as MatterCheckKind[]).filter((kind): kind is PeopleCheckKind => kind.startsWith("people."));
  const peopleDue = peopleKinds.filter(due);
  if (peopleDue.length > 0) {
    let items: Record<PeopleCheckKind, MirrorItem[]> | null = null;
    try {
      const snapshot = await readPeopleCheckSnapshot(app.db, {
        today: toBusinessDate(now, MOSCOW_TIME_ZONE), idleSince: new Date(now.getTime() - PEOPLE_ACCESS_IDLE_DAYS * DAY), now,
      });
      items = peopleCheckItems(snapshot, now);
    } catch (error) {
      await failed(peopleDue, error);
    }
    if (items !== null) for (const kind of peopleDue) await apply(kind, items[kind]);
  }

  // The ledger's checks and its notice of the payout tabs: one read.
  const checkKinds = (["ledger.check", "ledger.sheet_column"] as const).filter(due);
  if (checkKinds.length > 0) {
    try {
      const answer = await readLedgerChecks(app, fetchOptions);
      const red = ledgerCheckItems(answer, now);
      if (checkKinds.includes("ledger.check")) await apply("ledger.check", red.items, { waiting: red.waiting });
      if (checkKinds.includes("ledger.sheet_column")) await apply("ledger.sheet_column", sheetColumnItems(answer));
    } catch (error) {
      await failed(checkKinds, error);
    }
  }

  if (due("ledger.off_platform")) {
    try {
      await apply("ledger.off_platform", offPlatformItems(await readLedgerOpenDecisions(app, fetchOptions), now));
    } catch (error) {
      await failed(["ledger.off_platform"], error);
    }
  }

  return { tally, dry };
}

/** What reconciling `items` would do to the open matters of `kind` (the same rule as reconcileMatters, read only). */
function dryDiff(
  kind: MatterCheckKind,
  items: readonly MirrorItem[],
  open: Awaited<ReturnType<typeof listOpenMattersOfKinds>>,
  idOf: ReadonlyMap<string, number>,
): Pick<MatterCheckDryKind, "wouldOpen" | "wouldUpdate" | "wouldClose" | "unchanged"> {
  const byKey = new Map(open.map((matter) => [matter.key, matter]));
  const seen = new Set<string>();
  const result: Pick<MatterCheckDryKind, "wouldOpen" | "wouldUpdate" | "wouldClose" | "unchanged"> = { wouldOpen: [], wouldUpdate: [], wouldClose: [], unchanged: 0 };
  for (const item of items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    const existing = byKey.get(item.key);
    if (existing === undefined) {
      result.wouldOpen.push({ key: item.key, title: item.title });
      continue;
    }
    const fields = matterChanges(existing, {
      key: item.key, kind, source: SOURCE[kind], title: item.title.slice(0, 300), object: item.object,
      pageIds: [...new Set(item.pageLabels.map((label) => idOf.get(label)).filter((id): id is number => id !== undefined))],
      owner: OWNER, money: item.money, evidence: item.evidence, link: item.link,
    });
    if (fields.length === 0) result.unchanged += 1;
    else result.wouldUpdate.push({ key: item.key, title: item.title, fields });
  }
  for (const matter of open) if (!seen.has(matter.key)) result.wouldClose.push({ key: matter.key, title: matter.title });
  return result;
}
