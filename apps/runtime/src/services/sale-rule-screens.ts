import { listLoginPeople, listOwnerLoginIds, listSaleHomes, readSaleRuleSwitch, type Database, type SaleHomeRow, type ShiftSale } from "@agency_hub_core/db";

import { dayOfWork, moscowDayOf, workHoldsSale, type ComputedWork } from "./chatter-shifts.ts";
import { computeSaleHomes, registrySlots } from "./sale-homes.ts";
import { SALE_HOME_KINDS, SALE_RULE, type SaleHomeKind } from "./sale-rule.ts";
import { reportDateOfSale, reportDateOfShift } from "./shift-rows.ts";

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
 * THE CREDIT. Whom and what a home credits is `homeCredit`, for every screen alike: a share is its PERSON's (the people
 * registry), on the work of theirs that holds it by any of their logins; a share no work of theirs counts is the
 * person's own money of the sale's report day, and «вне смен» shows it with their name. Nothing of a sale is lost.
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

/** The pieces of work by login, for `homeCredit`. Pure. */
export function piecesByUser<P extends { userId: number }>(pieces: readonly P[]): Map<number, P[]> {
  const out = new Map<number, P[]>();
  for (const piece of pieces) out.set(piece.userId, [...(out.get(piece.userId) ?? []), piece]);
  return out;
}

/**
 * Where «вне смен» shows what the rule gives no person's shift: a look-in's, the person's with no work of theirs to
 * hold it (`person`: the owner gave it to someone who had no shift then), the page's pot, a PPV waiting for its sender,
 * the owner's decision, nobody's.
 */
export const OUTSIDE_HOMES = ["visit", "person", "pot", "waiting", "decide", "nobody"] as const;
export type OutsideHome = (typeof OUTSIDE_HOMES)[number];

/** The line of a home that names no person; null — a person's (its shares say where). Pure. */
function outsideLineOf(home: Pick<ScreenHome, "kind">): OutsideHome | null {
  switch (home.kind) {
    case "shift":
    case "visit":
      return null;
    case "pot":
    case "waiting":
    case "decide":
      return home.kind;
    default:
      return "nobody";
  }
}

// ─── Whom and what a home credits ────────────────────────────────────────────

/**
 * Whose each login is (the people registry, `person_logins`): a share of a sale is the PERSON's, whichever of their
 * logins worked. A login no person holds is a person of its own.
 */
export interface PeopleLogins {
  /** The login's person: `person:<id>`, or `login:<userId>` for a login no person holds. */
  personOf(userId: number): string;
  /** Every login of the login's person, itself first. */
  loginsOf(userId: number): readonly number[];
  /** The person's name: the registry's, else the login's username, else `hub:<id>`. */
  nameOf(userId: number): string;
  /** The login's own username, else `hub:<id>`. */
  usernameOf(userId: number): string;
}

/** `PeopleLogins` of the registry's rows (`listLoginPeople`). Pure. */
export function peopleLoginsOf(rows: ReadonlyArray<{ userId: number; username: string; personId: number | null; displayName: string | null }>): PeopleLogins {
  const byLogin = new Map(rows.map((row) => [row.userId, row]));
  const byPerson = new Map<number, number[]>();
  for (const row of rows) if (row.personId !== null) byPerson.set(row.personId, [...(byPerson.get(row.personId) ?? []), row.userId]);
  return {
    personOf: (userId) => {
      const personId = byLogin.get(userId)?.personId ?? null;
      return personId === null ? `login:${userId}` : `person:${personId}`;
    },
    loginsOf: (userId) => {
      const personId = byLogin.get(userId)?.personId ?? null;
      return personId === null ? [userId] : [userId, ...(byPerson.get(personId) ?? []).filter((other) => other !== userId)];
    },
    nameOf: (userId) => {
      const row = byLogin.get(userId);
      return row?.displayName ?? row?.username ?? `hub:${userId}`;
    },
    usernameOf: (userId) => byLogin.get(userId)?.username ?? `hub:${userId}`,
  };
}

/** Each login a person of its own, names unknown: for a read with no registry at hand. */
export const LOGINS_ALONE: PeopleLogins = peopleLoginsOf([]);

/** Whose each login is: one read per request. */
export async function readPeopleLogins(db: Database): Promise<PeopleLogins> {
  return peopleLoginsOf(await listLoginPeople(db));
}

/** A person's shift or look-in a share may land on, as the screen computed it. */
export interface CreditPiece {
  userId: number;
  work: Pick<ComputedWork, "kind" | "startedAt" | "endedAt" | "salesSince">;
}

/** One share of a person's home and where it lands. */
export interface ShareCredit<P> {
  /** The login the share names. */
  userId: number;
  /** Its person (`PeopleLogins.personOf`). */
  person: string;
  /**
   * The person's work that holds it: the work the rule named, else (it named none) their shift holding the sale by any
   * of their logins. null with `elsewhere` false — no work of theirs counts it (the owner gave it to someone who had no
   * shift then, or the rule named a work the screens' cut does not count): the person's own money of `day`, «вне смен»
   * with their name. null with `elsewhere` — the rule named a work this read does not have (another window's): not
   * this read's.
   */
  piece: P | null;
  elsewhere: boolean;
  /** The sale's report day (shift-rows.ts `reportDateOfSale`): where a share with no work counts. */
  day: string;
  mills: number;
}

/** Whom and what a home credits. */
export interface HomeCredit<P> {
  /** A person's home (a shift or a look-in): each share and where it lands. */
  shares: Array<ShareCredit<P>>;
  /** What no person takes: a home that names no person, whole (its line); the rest of a «моё» below the net (nobody's). */
  outside: { line: OutsideHome; mills: number } | null;
  /** The old count has the sale (an old shift counts it, the switch's first days): the rule credits nothing of it. */
  old: boolean;
}

/**
 * Whom and what a sale's home credits — the one answer every screen counts by («Смены», a person's statistics, the
 * shift review, the morning report): per share, its person, the piece of work of theirs that holds it and its mills;
 * the rest no person takes. Shares, the rest and the old count add up to the net to the mill.
 *
 * `pieces` — the read's works by login; `counts` — whether the rule counts a work (the screens' cut, `ruledWork`; a work
 * it does not count takes nothing: its share is the person's own with no work); `oldCounted` — an old shift counts the
 * sale. The morning report passes no cut: a sale waiting for the owner waits whatever a screen's old count shows. Pure.
 */
export function homeCredit<P extends CreditPiece>(input: {
  home: Pick<ScreenHome, "kind" | "shares">;
  sale: Pick<ShiftSale, "pageLabel" | "occurredAt" | "netMills">;
  pieces: ReadonlyMap<number, readonly P[]>;
  logins: PeopleLogins;
  counts?: (piece: P) => boolean;
  oldCounted?: boolean;
}): HomeCredit<P> {
  const { home, sale, logins } = input;
  if (input.oldCounted === true) return { shares: [], outside: null, old: true };
  const line = outsideLineOf(home);
  if (line !== null) return { shares: [], outside: { line, mills: sale.netMills }, old: false };
  const day = reportDateOfSale(sale.occurredAt.getTime());
  const counts = input.counts ?? (() => true);
  const shares = home.shares.map((share): ShareCredit<P> => {
    const land = landOf(share, sale, input.pieces, logins);
    const piece = land.piece !== null && counts(land.piece) ? land.piece : null;
    return { userId: share.userId, person: logins.personOf(share.userId), piece, elsewhere: land.elsewhere, day, mills: share.mills };
  });
  const rest = sale.netMills - shares.reduce((sum, share) => sum + share.mills, 0);
  return { shares, outside: rest === 0 ? null : { line: "nobody", mills: rest }, old: false };
}

/**
 * The shares of a home that are their person's own money of the sale's day: no work of theirs counts them, and the sale
 * is the rule's by its day (the switch's day or later — a day before it keeps the old count). The same on every screen:
 * a person's row in «Смены», their statistics, the review of their shift that day. Pure.
 */
export function ownMoneyShares<P>(rule: ScreensRule | null | undefined, sale: Pick<ShiftSale, "occurredAt">, credit: HomeCredit<P>): Array<ShareCredit<P>> {
  if (!ruledSale(rule, sale)) return [];
  return credit.shares.filter((share) => share.piece === null && !share.elsewhere);
}

/**
 * Where a share lands: the work the rule named (`<userId>:<startedAt>`) — the same start, else the work of that login
 * holding it (a look-in that joined a shift since moved its start earlier); a work the read does not have — elsewhere.
 * The rule named none (the owner's decision or a «делим» names a login no work of which held the sale): the person's
 * shift that holds the sale, the share's own login first, then their other logins; none — no work.
 */
function landOf<P extends CreditPiece>(
  share: { userId: number; workRef: string | null },
  sale: Pick<ShiftSale, "pageLabel" | "occurredAt">,
  pieces: ReadonlyMap<number, readonly P[]>,
  logins: PeopleLogins,
): { piece: P | null; elsewhere: boolean } {
  if (share.workRef !== null) {
    const start = Date.parse(share.workRef.slice(share.workRef.indexOf(":") + 1));
    const own = pieces.get(share.userId) ?? [];
    const named = own.find((piece) => piece.work.startedAt === start) ?? own.find((piece) => piece.work.startedAt <= start && start < piece.work.endedAt);
    return named === undefined ? { piece: null, elsewhere: true } : { piece: named, elsewhere: false };
  }
  const at = { pageLabel: sale.pageLabel, at: sale.occurredAt.getTime() };
  for (const login of logins.loginsOf(share.userId)) {
    const holding = (pieces.get(login) ?? []).find((piece) => piece.work.kind === "shift" && workHoldsSale(piece.work, at));
    if (holding !== undefined) return { piece: holding, elsewhere: false };
  }
  return { piece: null, elsewhere: false };
}
