// «Начало» (ecosystem plan 2026-11-12, §5 «Новый чаттер», package J): a new
// chatter's way from the invitation to the first shift, derived live from what
// Hub already holds — nothing is ticked by hand and nothing here is stored but
// the one thing the person writes, where their payouts go. The same reading
// serves the person (Workboard «Начало»), the owner's card («Ввод: 3 из 5») and
// the pass that opens the owner's matters (start-tick.ts).
//
// Where payouts go is money-adjacent: read here only for the person's own
// session and for the owner's card; nothing else of the registry carries it.
// A narrow session of the person (from the extension, no password) is told
// only whether it is written (`ownPayoutDetailsView`).

import {
  PERSON_START_STEPS,
  PERSON_START_STUCK_HOURS,
  type AccountPayoutDetailsBody,
  type AccountPayoutDetailsResponse,
  type AccountStartResponse,
  type OwnPayoutDetails,
  type PayoutDetails,
  type PersonStart,
  type PersonStartStepId,
} from "@agency_hub_core/contracts";
import {
  findPersonIdOfLogin,
  findPersonRowById,
  listPersonFirstActiveMinutes,
  listPersonInvitesUsed,
  listPersonLoginRows,
  listPersonPayoutDetails,
  listPersonRightRows,
  listPersonStartDevices,
  listPersonStartPages,
  upsertPersonPayoutDetails,
  type PersonFirstActiveMinuteRow,
  type PersonLoginRow,
  type PersonPayoutDetailsRow,
  type PersonRow,
  type PersonStartDeviceRow,
  type PersonStartPageRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { recordAudit, withAuditTransaction, type AuditContext, type HumanAuthPrincipal } from "../auth.ts";
import { ConflictError } from "../errors.ts";

type Db = AppContext["db"];

const HOUR_MS = 3_600_000;

/** What the steps close by, of one person. */
export interface StartFacts {
  /** The logins that can sign in: not disabled, not deleted. */
  logins: PersonLoginRow[];
  /** Device sign-ins of those logins, oldest first. */
  devices: PersonStartDeviceRow[];
  /** Pages opened to those logins (one row a page). */
  pages: PersonStartPageRow[];
  /** The earliest active minute of those logins. */
  firstActive: PersonFirstActiveMinuteRow | null;
  /** When an invitation of those logins was first used. */
  inviteUsedAt: Date | null;
  payout: PersonPayoutDetailsRow | null;
}

const EMPTY_FACTS: StartFacts = { logins: [], devices: [], pages: [], firstActive: null, inviteUsedAt: null, payout: null };

/** A chatter of the registry not working yet (invited or set up): «Начало» is theirs. */
export function isNewcomerRow(row: Pick<PersonRow, "kind" | "role" | "state">): boolean {
  return row.kind === "human" && row.role === "chatter" && (row.state === "invited" || row.state === "set_up");
}

/** The facts of many people, read once for all of them. */
export async function loadStartFacts(db: Db, rows: readonly PersonRow[]): Promise<Map<number, StartFacts>> {
  const facts = new Map<number, StartFacts>();
  if (rows.length === 0) return facts;
  const personIds = rows.map((row) => row.id);
  // In turn, not Promise.all: inside a transaction they share one connection.
  const logins = (await listPersonLoginRows(db, personIds)).filter((login) => login.disabledAt === null && login.deletedAt === null);
  const personOf = new Map(logins.map((login) => [login.userId, login.personId]));
  const userIds = [...personOf.keys()];
  const devices = await listPersonStartDevices(db, userIds);
  const pages = await listPersonStartPages(db, userIds);
  const minutes = await listPersonFirstActiveMinutes(db, userIds);
  const invites = await listPersonInvitesUsed(db, userIds);
  const payouts = await listPersonPayoutDetails(db, personIds);
  for (const row of rows) facts.set(row.id, { ...EMPTY_FACTS, logins: [], devices: [], pages: [] });
  const of = (userId: number) => facts.get(personOf.get(userId) ?? -1);
  for (const login of logins) facts.get(login.personId)?.logins.push(login);
  for (const device of devices) of(device.userId)?.devices.push(device);
  for (const page of pages) {
    const mine = of(page.userId);
    if (mine && !mine.pages.some((one) => one.pageId === page.pageId)) mine.pages.push(page);
  }
  for (const minute of minutes) {
    const mine = of(minute.userId);
    if (mine && (mine.firstActive === null || minute.minute < mine.firstActive.minute)) mine.firstActive = minute;
  }
  for (const invite of invites) {
    const mine = of(invite.userId);
    if (mine && (mine.inviteUsedAt === null || invite.usedAt < mine.inviteUsedAt)) mine.inviteUsedAt = invite.usedAt;
  }
  for (const payout of payouts) {
    const mine = facts.get(payout.personId);
    if (mine) mine.payout = payout;
  }
  return facts;
}

function earliest(dates: readonly Date[]): Date | null {
  let best: Date | null = null;
  for (const one of dates) if (best === null || one < best) best = one;
  return best;
}

/**
 * The way as Hub sees it now. Null — nothing to show: not a human, or no
 * login that can sign in. A step closes by its fact; `since` is when the
 * person came to where they stand — the invitation while it is not opened,
 * then its use (or the record, for a password set otherwise) and every step
 * before the current one closing, whichever is last.
 */
export function personStart(row: PersonRow, facts: StartFacts, now: Date): PersonStart | null {
  if (row.kind !== "human" || facts.logins.length === 0) return null;
  const signedUp = facts.logins.some((login) => login.hasPassword);
  const firstDevice = facts.devices[0] ?? null;
  const shownDevice = [...facts.devices].reverse().find((device) => device.active) ?? facts.devices.at(-1) ?? null;
  const doneAt: Record<PersonStartStepId, Date | null> = {
    install: firstDevice?.createdAt ?? null,
    extension: firstDevice?.createdAt ?? null,
    pages: earliest(facts.pages.map((page) => page.assignedAt)),
    activity: facts.firstActive?.minute ?? null,
    payout: facts.payout?.updatedAt ?? null,
  };
  const steps = PERSON_START_STEPS.map((step) => ({ step, done: doneAt[step] !== null, doneAt: doneAt[step]?.toISOString() ?? null }));
  const currentIndex = steps.findIndex((step) => !step.done);
  const current = currentIndex === -1 ? null : PERSON_START_STEPS[currentIndex]!;
  let since: Date | null = null;
  if (current !== null) {
    since = row.createdAt;
    if (signedUp) {
      if (facts.inviteUsedAt && facts.inviteUsedAt > since) since = facts.inviteUsedAt;
      for (const step of PERSON_START_STEPS.slice(0, currentIndex)) {
        const at = doneAt[step];
        if (at && at > since) since = at;
      }
    }
  }
  const newcomer = isNewcomerRow(row);
  // A page is the owner's to open, and that has its own matter: being without one is no person's standing still.
  const waitsForOwner = signedUp && current === "pages";
  const stuck = newcomer && since !== null && !waitsForOwner && now.getTime() - since.getTime() >= PERSON_START_STUCK_HOURS * HOUR_MS;
  return {
    newcomer,
    signedUp,
    steps,
    done: steps.filter((step) => step.done).length,
    total: steps.length,
    current,
    since: since?.toISOString() ?? null,
    stuck,
    extension: shownDevice ? { label: shownDevice.label, signedInAt: shownDevice.createdAt.toISOString(), active: shownDevice.active } : null,
    pages: facts.pages.map((page) => ({ pageLabel: page.label, platform: page.platform, modelName: page.modelName })),
    firstActivity: facts.firstActive ? { at: facts.firstActive.minute.toISOString(), pageLabel: facts.firstActive.pageLabel } : null,
  };
}

export function payoutDetailsView(row: PersonPayoutDetailsRow | null): PayoutDetails {
  return row === null ? null : { text: row.details, updatedAt: row.updatedAt.toISOString() };
}

/**
 * The same for the person's own session. A narrow session (opened from the extension, no password) never touches
 * where a person is paid: it is told that it is written and when, and the text stays here — whoever sits at the
 * person's unlocked computer does not read a card or wallet number off «Начало».
 */
export function ownPayoutDetailsView(row: PersonPayoutDetailsRow | null, principal: Pick<HumanAuthPrincipal, "narrowDeviceTokenId">): OwnPayoutDetails {
  const view = payoutDetailsView(row);
  return view === null || principal.narrowDeviceTokenId === undefined ? view : { text: null, updatedAt: view.updatedAt };
}

/** For the owner's card: the way and where payouts go, of one person. */
export async function readStartForOwner(db: Db, row: PersonRow, now: Date): Promise<{ start: PersonStart | null; payoutDetails: PayoutDetails }> {
  const facts = (await loadStartFacts(db, [row])).get(row.id) ?? EMPTY_FACTS;
  return { start: personStart(row, facts, now), payoutDetails: payoutDetailsView(facts.payout) };
}

/** `accountStart`: the session's own person — never anyone else's. */
export async function readAccountStart(app: Pick<AppContext, "db">, principal: HumanAuthPrincipal, now = new Date()): Promise<AccountStartResponse> {
  const db = app.db;
  const personId = await findPersonIdOfLogin(db, principal.user.id);
  const row = personId === null ? null : await findPersonRowById(db, personId);
  if (row === null) {
    return { person: null, username: principal.user.username, start: null, payoutDetails: null, submitsShift: false, serverNow: now.toISOString() };
  }
  const facts = (await loadStartFacts(db, [row])).get(row.id) ?? EMPTY_FACTS;
  const rights = await listPersonRightRows(db, [row.id]);
  return {
    person: { code: row.code, displayName: row.displayName },
    username: principal.user.username,
    start: personStart(row, facts, now),
    payoutDetails: ownPayoutDetailsView(facts.payout, principal),
    // «Сдаёт смену в системе» (package F): off — the text says today's way, Генгар and «Отчётность».
    submitsShift: rights.some((right) => right.right === "submits_shift"),
    serverNow: now.toISOString(),
  };
}

/** `accountPayoutDetailsSet`: the person writes their own; the audit never carries the text. */
export async function setOwnPayoutDetails(
  app: Pick<AppContext, "db">,
  principal: HumanAuthPrincipal,
  body: AccountPayoutDetailsBody,
  audit: AuditContext,
): Promise<AccountPayoutDetailsResponse> {
  return withAuditTransaction(app, async (db) => {
    const personId = await findPersonIdOfLogin(db, principal.user.id);
    if (personId === null) throw new ConflictError("This login is nobody's in the people registry", { reason: "no_person" });
    const text = body.text.trim();
    const details = text === "" ? null : text;
    const { before } = await upsertPersonPayoutDetails(db, { personId, details, byUserId: principal.user.id });
    await recordAudit({ db }, {
      ...audit,
      eventType: "person.payout_details_set",
      metadata: { personId, cleared: details === null, changed: before !== details },
    });
    const [row] = await listPersonPayoutDetails(db, [personId]);
    return { payoutDetails: payoutDetailsView(row ?? null) };
  });
}
