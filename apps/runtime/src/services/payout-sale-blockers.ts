import { personNameForms } from "@agency_hub_core/contracts";
import {
  findUnlinkedBlockerLogin,
  listHandinNames,
  listHandinSalesByIds,
  listMatterPageLabels,
  listSaleBlockerPeople,
  listSaleClaims,
  type HandinSaleRow,
  type SaleBlockerPersonRow,
  type SaleClaimKind,
  type SaleClaimRow,
  type SaleClaimState,
} from "@agency_hub_core/db";
import { moscowDayOfMs } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { NotFoundError } from "./errors.ts";

/**
 * One canonical selector of a person's open sale questions and disputes (`payoutSaleBlockers`):
 * read by BOTH Workboard's payout panel (`GET /api/v1/team/ledger-payouts/prepare`) and the agent's
 * read (`GET /api/v1/agent/sale-questions?person=…`, `hub sale questions --person …`).
 *
 * Rules:
 * - Resolves the person across ALL of their logins (active and disabled/deleted) and ALL of their
 *   working pages, strictly inside the caller's realm (`live` or `test`).
 * - Matches open claims/disputes and open sale questions where the person is:
 *     1. `party`: claimant, side, share target, or sale home holder under any of their logins;
 *     2. `named`: named in `who_text` or `question` (by code, login username, report tag, display
 *        name or Russian inflected forms, on word boundaries);
 *     3. `page`: an unattributed open question on one of the person's working pages;
 *     4. `unlinked`: an unattributed open question with no page, surfaced to the owner for review.
 * - Another person's claim/dispute or question (attributed to other user ids, or whose `who_text`
 *   names only other known people in the roster) is excluded.
 * - Realm, page access, date window and person-relevance filtering ALWAYS happen BEFORE any row
 *   limit, so unrelated claims/questions never crowd out this person's open blockers.
 * - Partial coverage (`person_not_in_hub`, `pages_outside_key`, `unlinked_questions_omitted`,
 *   `truncated`) is reported honestly alongside the results.
 */

export type PayoutSaleBlockersApp = Pick<AppContext, "db">;

export type SaleBlockerMatch = "party" | "named" | "page" | "unlinked";
export type SaleBlockerCoverageReason = "person_not_in_hub" | "pages_outside_key" | "unlinked_questions_omitted" | "truncated";

export interface SaleBlockerCoverage {
  state: "complete" | "partial";
  reasons: SaleBlockerCoverageReason[];
}

export interface BlockerPerson {
  personId: number | null;
  code: string | null;
  displayName: string;
  reportTag: string | null;
  userIds: readonly number[];
  usernames: readonly string[];
  workingPageIds: readonly number[];
}

export interface PayoutSaleBlockerCandidate {
  claim: SaleClaimRow;
  sale: HandinSaleRow | undefined;
  match: SaleBlockerMatch;
}

export interface PayoutSaleBlockerItem {
  claim: SaleClaimRow;
  sale: HandinSaleRow | null;
  id: number;
  kind: SaleClaimKind;
  transactionId: number | null;
  pageLabel: string | null;
  netMills: number | null;
  occurredAt: string | null;
  askedAt: string;
  askedOf: "owner" | "chatters";
  who: string | null;
  text: string;
  match: SaleBlockerMatch;
  link: string;
  sourceLink: string | null;
}

export interface PayoutSaleBlockersInput {
  /** Person by registry code (slug), person id, login id, or username. */
  person: string;
  /** Optional inclusive Moscow day lower bound (YYYY-MM-DD); null/undefined = unbounded. */
  from?: string | null | undefined;
  /** Optional inclusive Moscow day upper bound (YYYY-MM-DD); null/undefined = unbounded. */
  to?: string | null | undefined;
  /** Fallback display name when a ledger person has no Hub people-registry row yet. */
  fallbackName?: string | null | undefined;
  /**
   * Caller's page scope:
   * - `"owner"` (default): all pages of `realm`, plus `page_id IS NULL` rows in live realm;
   * - `readonly number[]`: agent key's granted pages only (never other pages, never null-page rows).
   */
  pageScope?: "owner" | readonly number[] | undefined;
  /** Realm wall: `"live"` (default) or `"test"`. */
  realm?: "live" | "test" | undefined;
  /** Which `sale_claims.kind` rows to include; default all four (`claim`, `double`, `question`, `imported`). */
  kinds?: readonly SaleClaimKind[] | undefined;
  /** Default `true`: open states (`owner`, `asked`) only; `false` includes `decided` as well. */
  openOnly?: boolean | undefined;
  /** Optional cap applied ONLY AFTER realm, access, window and person-relevance filtering. */
  limit?: number | undefined;
  /** When true (agent door), throw 404 if the person does not exist in the caller's realm. */
  requirePerson?: boolean | undefined;
}

export interface PayoutSaleBlockersResult {
  person: BlockerPerson | null;
  items: PayoutSaleBlockerItem[];
  coverage: SaleBlockerCoverage;
  serverNow: string;
}

const ALL_BLOCKER_KINDS: readonly SaleClaimKind[] = ["claim", "double", "question", "imported"];
const OPEN_BLOCKER_STATES: readonly SaleClaimState[] = ["owner", "asked"];
const NON_WITHDRAWN_STATES: readonly SaleClaimState[] = ["owner", "asked", "decided"];
const BUSINESS_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Strip edge punctuation while keeping internal `-`, `.` and `_` (so `alex-2` and `kate.v` stay intact). */
function tokenizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9а-яё._-]+/iu)
    .map((token) => token.replace(/^[._-]+|[._-]+$/gu, ""))
    .filter((token) => token.length > 0);
}

/** Normalized lowercase phrases/tokens that identify a person in free text (`who_text` or `question`). */
export function personMatchTokens(person: Pick<BlockerPerson, "code" | "displayName" | "reportTag" | "usernames">): {
  tokens: Set<string>;
  phrases: Set<string>;
} {
  const tokens = new Set<string>();
  const phrases = new Set<string>();
  const addToken = (raw: string | null | undefined) => {
    if (!raw) return;
    const trimmed = raw.trim().toLowerCase().replace(/^#+/u, "");
    if (trimmed.length >= 2) tokens.add(trimmed);
  };
  addToken(person.code);
  addToken(person.reportTag);
  for (const username of person.usernames) addToken(username);

  const display = person.displayName.trim();
  if (display !== "") {
    const words = tokenizeWords(display);
    if (words.length === 1) {
      const forms = personNameForms(display);
      for (const form of [forms.nom, forms.gen, forms.acc, forms.ins, forms.dat]) addToken(form);
    } else if (words.length > 1) {
      phrases.add(words.join(" "));
    }
  }
  return { tokens, phrases };
}

/** Whether normalized `text` contains any token or phrase of `person` on word boundaries. */
export function textNamesPerson(
  text: string | null,
  match: { tokens: ReadonlySet<string>; phrases: ReadonlySet<string> },
): boolean {
  if (text === null || text.trim() === "") return false;
  const words = tokenizeWords(text);
  if (words.length === 0) return false;
  for (const word of words) {
    if (match.tokens.has(word)) return true;
  }
  if (match.phrases.size > 0) {
    const joined = ` ${words.join(" ")} `;
    for (const phrase of match.phrases) {
      if (joined.includes(` ${phrase} `)) return true;
    }
  }
  return false;
}

/** Split `who_text` into individual person mentions («Аня и Боря», «anna, boris / cora»). */
function whoParts(whoText: string): string[] {
  return whoText
    .split(/\s+и\s+|\s+или\s+|\s*[,;/]\s*/iu)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Check whether a single `who_text` part uniquely prefix-matches a single-word display name (as `sale-claims-import.ts`). */
function uniquePrefixPerson(
  part: string,
  allPeople: ReadonlyArray<{ person: BlockerPerson; match: { tokens: Set<string>; phrases: Set<string> } }>,
): BlockerPerson | null {
  const normalized = part.trim().toLowerCase();
  if (normalized.length < 3 || /\s/u.test(normalized)) return null;
  const hits = allPeople.filter(({ person }) => {
    const name = person.displayName.trim().toLowerCase();
    return name.length > normalized.length && !/\s/u.test(name) && name.startsWith(normalized);
  });
  return hits.length === 1 ? hits[0]!.person : null;
}

function isNamedInWho(
  whoText: string | null,
  target: { person: BlockerPerson; match: { tokens: Set<string>; phrases: Set<string> } },
  allPeople: ReadonlyArray<{ person: BlockerPerson; match: { tokens: Set<string>; phrases: Set<string> } }>,
): boolean {
  if (whoText === null || whoText.trim() === "") return false;
  if (textNamesPerson(whoText, target.match)) return true;
  for (const part of whoParts(whoText)) {
    const prefixed = uniquePrefixPerson(part, allPeople);
    if (prefixed !== null && prefixed === target.person) return true;
  }
  return false;
}

/**
 * True when `who_text` names at least one party AND every party it names resolves to a known OTHER person in the
 * roster — meaning the question is definitely about other people, not unattributed.
 */
function isWhoAttributedSolelyToOthers(
  whoText: string | null,
  otherPeople: ReadonlyArray<{ person: BlockerPerson; match: { tokens: Set<string>; phrases: Set<string> } }>,
  allPeople: ReadonlyArray<{ person: BlockerPerson; match: { tokens: Set<string>; phrases: Set<string> } }>,
): boolean {
  if (whoText === null || whoText.trim() === "") return false;
  const parts = whoParts(whoText);
  if (parts.length === 0) return false;
  for (const part of parts) {
    const matchedOther = otherPeople.some((other) => textNamesPerson(part, other.match))
      || (() => {
        const prefixed = uniquePrefixPerson(part, allPeople);
        return prefixed !== null && otherPeople.some((other) => other.person === prefixed);
      })();
    if (!matchedOther) return false;
  }
  return true;
}

/** The Moscow day a claim or question belongs to: its sale's day, else `ledgerRef.occurredAt`, else when asked. */
export function blockerMoscowDay(claim: Pick<SaleClaimRow, "claimedAt" | "ledgerRef">, sale: Pick<HandinSaleRow, "occurredAt"> | undefined): string {
  if (sale !== undefined) return moscowDayOfMs(sale.occurredAt.getTime());
  const raw = claim.ledgerRef?.occurredAt;
  if (typeof raw === "string") {
    if (BUSINESS_DAY.test(raw)) return raw;
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) return moscowDayOfMs(ms);
  }
  return moscowDayOfMs(claim.claimedAt.getTime());
}

/** Whether a single claim/question matches `person` under `pageScope` and date window `[from, to]`. Pure. */
export function classifySaleBlocker(input: {
  claim: SaleClaimRow;
  sale: HandinSaleRow | undefined;
  person: BlockerPerson;
  otherPeople: readonly BlockerPerson[];
  pageScope: "owner" | ReadonlySet<number>;
  from: string | null;
  to: string | null;
}): SaleBlockerMatch | null {
  const { claim, sale, person, pageScope, from, to } = input;
  // 1. Access scope check FIRST (before relevance and before any limit).
  if (pageScope !== "owner") {
    if (claim.pageId === null || !pageScope.has(claim.pageId)) return null;
  }
  // 2. Date window check (inclusive Moscow days).
  if (from !== null || to !== null) {
    const day = blockerMoscowDay(claim, sale);
    if (from !== null && day < from) return null;
    if (to !== null && day > to) return null;
  }
  const userIds = new Set(person.userIds);
  // 3. Direct party match across ALL of the person's logins (claimant, side, share target, or sale home holder).
  const isParty = (claim.claimantUserId !== null && userIds.has(claim.claimantUserId))
    || (claim.sideUserId !== null && userIds.has(claim.sideUserId))
    || (claim.shareWithUserId !== null && userIds.has(claim.shareWithUserId))
    || (sale?.home?.shares.some((share) => userIds.has(share.userId)) === true);
  if (isParty) return "party";

  // Shift-report disputes (`claim`/`double`) belong strictly to their parties.
  if (claim.kind === "claim" || claim.kind === "double") return null;

  // 4. Question (`question` / `imported`): check if the person is named in `who_text` or `question`.
  const targetEntry = { person, match: personMatchTokens(person) };
  const otherEntries = input.otherPeople.map((other) => ({ person: other, match: personMatchTokens(other) }));
  const allEntries = [targetEntry, ...otherEntries];
  if (isNamedInWho(claim.whoText, targetEntry, allEntries) || textNamesPerson(claim.question, targetEntry.match)) {
    return "named";
  }

  // 5. Exclude questions already attributed to other specific people (by user id or by `who_text`).
  const hasOtherUserId = claim.claimantUserId !== null || claim.sideUserId !== null || claim.shareWithUserId !== null;
  if (hasOtherUserId) return null;
  if (isWhoAttributedSolelyToOthers(claim.whoText, otherEntries, allEntries)) return null;

  // 6. Unattributed open question on one of the person's working pages.
  const workingPages = new Set(person.workingPageIds);
  if (claim.pageId !== null && workingPages.has(claim.pageId)) return "page";

  // 7. Completely unlinked/unattributed open question (no page): surfaced to the owner for review.
  if (claim.pageId === null && pageScope === "owner") return "unlinked";

  return null;
}

/**
 * Pure core of `payoutSaleBlockers`: checks access, date window and person relevance on EVERY candidate BEFORE
 * sorting oldest-first and applying `limit`. Also checks whether any relevant `page_id === null` open questions were
 * omitted for an agent key whose grant excludes null-page rows.
 */
export function selectPayoutSaleBlockers(input: {
  claims: readonly SaleClaimRow[];
  sales: ReadonlyMap<number, HandinSaleRow>;
  person: BlockerPerson;
  otherPeople: readonly BlockerPerson[];
  pageScope: "owner" | readonly number[];
  from?: string | null | undefined;
  to?: string | null | undefined;
  limit?: number | undefined;
  personInHub?: boolean | undefined;
  /** Optional null-page open questions in the same realm, to detect honest `unlinked_questions_omitted` for agent keys. */
  nullPageCandidates?: readonly SaleClaimRow[] | undefined;
}): {
  matched: PayoutSaleBlockerCandidate[];
  coverage: SaleBlockerCoverage;
} {
  const from = input.from ?? null;
  const to = input.to ?? null;
  const scopeSet = input.pageScope === "owner" ? "owner" as const : new Set(input.pageScope);

  const allMatched: PayoutSaleBlockerCandidate[] = [];
  for (const claim of input.claims) {
    const sale = claim.transactionId === null ? undefined : input.sales.get(claim.transactionId);
    const match = classifySaleBlocker({
      claim,
      sale,
      person: input.person,
      otherPeople: input.otherPeople,
      pageScope: scopeSet,
      from,
      to,
    });
    if (match !== null) allMatched.push({ claim, sale, match });
  }

  // Oldest first, deterministic by id.
  allMatched.sort((a, b) => a.claim.claimedAt.getTime() - b.claim.claimedAt.getTime() || a.claim.id - b.claim.id);

  const reasons: SaleBlockerCoverageReason[] = [];
  if (input.personInHub === false) reasons.push("person_not_in_hub");
  if (scopeSet !== "owner") {
    const omitted = input.claims.some((claim) => claim.pageId !== null && !scopeSet.has(claim.pageId)
      && classifySaleBlocker({ claim, sale: input.sales.get(claim.transactionId ?? -1), person: input.person,
        otherPeople: input.otherPeople, pageScope: "owner", from, to }) !== null);
    if (omitted || input.person.workingPageIds.some((pageId) => !scopeSet.has(pageId))) {
      reasons.push("pages_outside_key");
    }
    const nullRows = input.nullPageCandidates ?? input.claims.filter((claim) => claim.pageId === null);
    const hasRelevantNullPage = nullRows.some((claim) => {
      if (claim.pageId !== null) return false;
      const sale = claim.transactionId === null ? undefined : input.sales.get(claim.transactionId);
      return classifySaleBlocker({
        claim,
        sale,
        person: input.person,
        otherPeople: input.otherPeople,
        pageScope: "owner",
        from,
        to,
      }) !== null;
    });
    if (hasRelevantNullPage) reasons.push("unlinked_questions_omitted");
  }

  const limit = input.limit;
  const truncated = limit !== undefined && allMatched.length > limit;
  if (truncated) reasons.push("truncated");
  const matched = truncated ? allMatched.slice(0, limit) : allMatched;

  return {
    matched,
    coverage: { state: reasons.length === 0 ? "complete" : "partial", reasons },
  };
}

/** Resolve `person` (code, person id, login id, or username) from the realm's people roster. Pure. */
export function resolveBlockerPersonFromRoster(
  ref: string,
  roster: readonly SaleBlockerPersonRow[],
): { person: BlockerPerson; others: BlockerPerson[] } | null {
  const needle = ref.trim();
  const lower = needle.toLowerCase();
  const numeric = /^\d+$/.test(needle) ? Number(needle) : null;

  let found: SaleBlockerPersonRow | undefined = roster.find((row) => row.code.toLowerCase() === lower);
  if (found === undefined && numeric !== null) {
    found = roster.find((row) => row.personId === numeric)
      ?? roster.find((row) => row.userIds.includes(numeric));
  }
  if (found === undefined) {
    found = roster.find((row) => row.usernames.some((username) => username.toLowerCase() === lower));
  }
  if (found === undefined) return null;

  const toPerson = (row: SaleBlockerPersonRow): BlockerPerson => ({
    personId: row.personId,
    code: row.code,
    displayName: row.displayName,
    reportTag: row.reportTag,
    userIds: row.userIds,
    usernames: row.usernames,
    workingPageIds: row.workingPageIds,
  });
  return {
    person: toPerson(found),
    others: roster.filter((row) => row.personId !== found.personId).map(toPerson),
  };
}

/** One-line Russian text for a sale claim/dispute or question. Pure. */
export function blockerTextOf(claim: SaleClaimRow, names: ReadonlyMap<number, string>): string {
  const question = claim.question?.trim() ?? "";
  if (question !== "") return question;
  const nameOf = (userId: number | null) => (userId === null ? null : names.get(userId) ?? `#${userId}`);
  const claimant = nameOf(claim.claimantUserId) ?? "Чаттер";
  if (claim.kind === "double") {
    const side = nameOf(claim.sideUserId);
    const base = side === null ? "Продажа посчитана в двух отчётах" : `${claimant} и ${side} посчитали продажу в отчётах`;
    return claim.claimantNote ? `${base}: ${claim.claimantNote}` : base;
  }
  const shareWith = nameOf(claim.shareWithUserId ?? claim.sideUserId);
  let text = claim.statement === "share"
    ? `${claimant} просит пополам${shareWith === null ? "" : ` с ${shareWith}`}`
    : `${claimant} заявляет «моё»`;
  if (claim.claimantNote) text += `: ${claim.claimantNote}`;
  if (claim.answer === "disagree") {
    text += claim.answerNote ? ` — «Не согласен»: ${claim.answerNote}` : " — «Не согласен»";
  }
  return text;
}

/** Who is involved, in words (`who_text` when present, else the parties' names). Pure. */
export function blockerWhoOf(claim: SaleClaimRow, names: ReadonlyMap<number, string>): string | null {
  if (claim.whoText !== null && claim.whoText.trim() !== "") return claim.whoText.trim();
  const ids = [...new Set([claim.claimantUserId, claim.sideUserId, claim.shareWithUserId].filter((id): id is number => id !== null))];
  if (ids.length === 0) return null;
  return ids.map((id) => names.get(id) ?? `#${id}`).join(" и ");
}

/** Who decides: `owner` or `chatters`. Pure. */
export function blockerAskedOf(claim: SaleClaimRow): "owner" | "chatters" {
  if (claim.kind === "question" || claim.kind === "imported") {
    return claim.askedOf ?? (typeof claim.ledgerRef?.askedOf === "string" && claim.ledgerRef.askedOf === "chatters" ? "chatters" : "owner");
  }
  return claim.state === "owner" ? "owner" : "chatters";
}

/** Workboard link to open and decide the dispute/question. Pure. */
export function blockerLinkOf(claim: Pick<SaleClaimRow, "id" | "transactionId">): string {
  return claim.transactionId === null
    ? `/workboard/waiting?claim=${claim.id}#questions`
    : `/workboard/waiting?dispute=${claim.transactionId}#questions`;
}

/**
 * Canonical selector of open sale questions and disputes relevant to one person (`payoutSaleBlockers`).
 * Shared by Workboard's payout panel (`readLedgerPayoutPrepare`) and the agent's read (`agentSaleQuestions --person`).
 */
export async function payoutSaleBlockers(
  app: PayoutSaleBlockersApp,
  input: PayoutSaleBlockersInput,
  now: Date = new Date(),
): Promise<PayoutSaleBlockersResult> {
  const { db } = app;
  const realm = input.realm ?? "live";
  const pageScope = input.pageScope ?? "owner";
  const kinds = input.kinds ?? ALL_BLOCKER_KINDS;
  const openOnly = input.openOnly ?? true;
  const states = openOnly ? OPEN_BLOCKER_STATES : NON_WITHDRAWN_STATES;

  const roster = await listSaleBlockerPeople(db, realm);
  let resolved = resolveBlockerPersonFromRoster(input.person, roster);
  let personInHub = resolved !== null;

  // Fallback for an unlinked Hub login (numeric userId or username not yet in `person_logins`).
  if (resolved === null) {
    const trimmed = input.person.trim();
    const unlinked = await findUnlinkedBlockerLogin(
      db,
      /^\d+$/.test(trimmed) ? { userId: Number(trimmed) } : { username: trimmed },
      realm,
    );
    if (unlinked !== null) {
      resolved = {
        person: {
          personId: null,
          code: null,
          displayName: unlinked.username,
          reportTag: null,
          userIds: [unlinked.userId],
          usernames: [unlinked.username],
          workingPageIds: unlinked.pageIds,
        },
        others: roster.map((row) => ({
          personId: row.personId,
          code: row.code,
          displayName: row.displayName,
          reportTag: row.reportTag,
          userIds: row.userIds,
          usernames: row.usernames,
          workingPageIds: row.workingPageIds,
        })),
      };
      personInHub = true;
    }
  }

  if (resolved === null && input.requirePerson === true) {
    throw new NotFoundError("Not found");
  }

  const person: BlockerPerson = resolved?.person ?? {
    personId: null,
    code: input.person.trim(),
    displayName: input.fallbackName?.trim() || input.person.trim(),
    reportTag: null,
    userIds: [],
    usernames: [],
    workingPageIds: [],
  };
  const otherPeople: BlockerPerson[] = resolved?.others ?? roster.map((row) => ({
    personId: row.personId,
    code: row.code,
    displayName: row.displayName,
    reportTag: row.reportTag,
    userIds: row.userIds,
    usernames: row.usernames,
    workingPageIds: row.workingPageIds,
  }));

  // Include the realm's omitted rows in the coverage check. Only granted rows can become items.
  const claims = await listSaleClaims(db, { kinds, states, realm, limit: null });
  const saleIds = [...new Set(claims.flatMap((claim) => claim.transactionId === null ? [] : [claim.transactionId]))];
  const sales = new Map((await listHandinSalesByIds(db, saleIds)).map((sale) => [sale.transactionId, sale]));

  const { matched, coverage } = selectPayoutSaleBlockers({
    claims,
    sales,
    person,
    otherPeople,
    pageScope,
    from: input.from ?? null,
    to: input.to ?? null,
    limit: input.limit,
    personInHub,
  });

  const nameIds = matched.flatMap(({ claim }) => [claim.claimantUserId, claim.sideUserId, claim.shareWithUserId].filter((id): id is number => id !== null));
  const [names, pages] = await Promise.all([
    listHandinNames(db, nameIds),
    listMatterPageLabels(db),
  ]);

  const items: PayoutSaleBlockerItem[] = matched.map(({ claim, sale, match }) => {
    const ref = claim.ledgerRef ?? {};
    const pageLabel = claim.pageId === null
      ? (typeof ref.pageLabel === "string" ? ref.pageLabel : null)
      : pages.labelOf.get(claim.pageId) ?? sale?.pageLabel ?? null;
    const occurredAt = sale?.occurredAt.toISOString()
      ?? (typeof ref.occurredAt === "string" && !Number.isNaN(Date.parse(ref.occurredAt)) ? new Date(ref.occurredAt).toISOString() : null);
    return {
      claim,
      sale: sale ?? null,
      id: claim.id,
      kind: claim.kind,
      transactionId: claim.transactionId,
      pageLabel,
      netMills: sale?.netMills ?? (typeof ref.netMills === "number" ? ref.netMills : null),
      occurredAt,
      askedAt: claim.claimedAt.toISOString(),
      askedOf: blockerAskedOf(claim),
      who: blockerWhoOf(claim, names),
      text: blockerTextOf(claim, names),
      match,
      link: blockerLinkOf(claim),
      sourceLink: claim.sourceLink,
    };
  });

  return {
    person: resolved === null ? null : person,
    items,
    coverage,
    serverNow: now.toISOString(),
  };
}
