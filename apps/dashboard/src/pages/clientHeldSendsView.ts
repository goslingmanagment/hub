import type { ClientSendCustodyListItem, ClientSendCustodyListState } from "@agency_hub_core/contracts";
import {
  formatSpan,
  greetingCell as sharedGreetingCell,
  heldSince,
  outcomeLabel,
  partLabel,
  purposeLabel,
  shortId,
  type GreetingCell,
} from "@agency_hub_core/ui/heldSends";

import { keepAllPages, pageFromSearch } from "@/lib/pageParam";
import { ruPlural } from "@/lib/plural";

/**
 * The cabinet's "held sends" page as rows and a form ready to print
 * (chat-extension H-7e). Pure: the page renders what this returns, and the
 * resolve it sends is the body this builds.
 *
 * The hub answers ids, states and times, so there is no text of a message
 * here: the hub does not know which text went out. (`generationRef` names the
 * AI generation the text came from, a record only the owner reads, elsewhere.)
 * Everything this model words for a person, it words without the hub's own
 * terms: a "ticket" is "the hub waited 10 seconds for the report", custody is
 * "the fan is held". The words of a send and its resolve form are one copy with
 * Workboard's Решения (packages/ui/src/heldSends.ts, re-exported here): they
 * name the platform of the send's page, so a Fansly send no longer reads as
 * OnlyFans. What stays here is the cabinet's own: its address, its rows and its
 * clock (the viewer's local time, as in the chat).
 */

export {
  EMPTY_RESOLVE_DRAFT,
  NOT_SENT_OUTCOME_HINT,
  RESOLVE_NOTE_MAX,
  formatSpan,
  messageIdLabel,
  notSentWarning,
  partLabel,
  platformWord,
  purposeLabel,
  resolveFailure,
  resolveForm,
  resolveIntro,
  sentOutcomeHint,
  shortId,
  type GreetingCell,
  type ResolveDraft,
  type ResolveFailure,
  type ResolveForm,
  type ResolveOutcome,
} from "@agency_hub_core/ui/heldSends";

type Item = ClientSendCustodyListItem;

export const HELD_SENDS_PAGE_SIZE = 25;

export const HELD_SENDS_TABS: ReadonlyArray<{ key: ClientSendCustodyListState; label: string }> = [
  { key: "held", label: "Ждут разбора" },
  { key: "resolved", label: "Разобранные" },
];

// ── the address of a view: tab, page filter and offset in the query string ───

export interface HeldSendsView {
  state: ClientSendCustodyListState;
  /** Null: every page the viewer reaches. */
  pageLabel: string | null;
  offset: number;
}

/**
 * A link someone edited by hand lands on the page, not on an error: an unknown
 * tab is the queue, a page the viewer does not have is "every page", a bad
 * offset is the start. `pageLabels` null: the catalog is not loaded yet, and
 * the filter is kept until it can be checked.
 */
export function parseHeldSendsView(search: URLSearchParams, pageLabels: readonly string[] | null): HeldSendsView {
  const page = pageFromSearch(search);
  const offset = Number(search.get("offset"));
  return {
    state: search.get("state") === "resolved" ? "resolved" : "held",
    pageLabel: page !== null && (pageLabels === null || pageLabels.includes(page)) ? page : null,
    offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
  };
}

/** The query string of a view; the defaults are left out, so the plain address is the queue of every page. */
export function heldSendsSearch(view: HeldSendsView): URLSearchParams {
  const search = new URLSearchParams();
  if (view.state !== "held") search.set("state", view.state);
  if (view.pageLabel !== null) search.set("page", view.pageLabel);
  if (view.offset > 0) search.set("offset", String(view.offset));
  return search;
}

/**
 * The address after one change of the view, built from the address given.
 *
 * `current` must be the address the browser shows NOW (`location.search` at
 * the moment of the click), not the one the page last rendered. The router
 * publishes a new address to React in a transition, so a second change made
 * before that render commits would otherwise start from the old view and undo
 * the first: a tab click followed at once by a change of the page filter left
 * the page on the other tab.
 *
 * A new tab or page filter starts its list from the top; only a change of the
 * offset itself keeps a position in the list.
 */
export function changeHeldSendsView(
  current: URLSearchParams,
  pageLabels: readonly string[] | null,
  change: Partial<HeldSendsView>,
): URLSearchParams {
  const next = heldSendsSearch({ ...parseHeldSendsView(current, pageLabels), ...change, offset: change.offset ?? 0 });
  return change.pageLabel === undefined ? keepAllPages(current, next) : next;
}

/**
 * The platforms whose pages can hold a send at all: sending from the preview
 * exists on them and nowhere else. One table, so the page filter compares no
 * platform to decide which pages to offer.
 */
const PREVIEW_SEND_PLATFORMS: ReadonlySet<string> = new Set(["onlyfans"]);

/** The pages the filter offers, in the catalog's order. */
export function heldSendsPageLabels(pages: ReadonlyArray<{ label: string; platform: string }>): string[] {
  return pages.filter((page) => PREVIEW_SEND_PLATFORMS.has(page.platform)).map((page) => page.label);
}

// ── words ────────────────────────────────────────────────────────────────────

function parts(format: Intl.DateTimeFormat, date: Date): Record<string, string> {
  return Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value]));
}

/**
 * "5 октября, 14:02", with the year when it is not `now`'s. Put together from
 * parts, so the wording does not follow the runtime's own date pattern. The
 * page prints the viewer's local time (no `timeZone`): it is the clock of the
 * chat the resolver compares against.
 */
export function formatMoment(iso: string, now: Date, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const format = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    ...(timeZone === undefined ? {} : { timeZone }),
  });
  const at = parts(format, date);
  const year = at.year === parts(format, now).year ? "" : ` ${at.year}`;
  return `${at.day} ${at.month}${year}, ${at.hour}:${at.minute}`;
}

/** "1 отправка ждёт разбора", "3 отправки ждут разбора", "5 отправок ждут разбора". */
export function heldCountLabel(total: number): string {
  return `${total} ${ruPlural(total, "отправка ждёт", "отправки ждут", "отправок ждут")} разбора`;
}

/**
 * The fan's greeting as the resolver reads it next to a held greeting, the
 * moment in the viewer's clock. Null for any other send.
 */
export function greetingCell(item: Pick<Item, "purpose" | "greeting">, now: Date, timeZone?: string): GreetingCell | null {
  return sharedGreetingCell(item, (iso) => formatMoment(iso, now, timeZone));
}

// ── rows ─────────────────────────────────────────────────────────────────────

export interface HeldSendRow {
  key: string;
  item: Item;
  pageLabel: string;
  fanRef: string;
  purpose: string;
  part: string;
  /** Who dispatched, and the short id of the client install it came from. */
  username: string;
  install: string;
  dispatchedAt: string;
  /** How long ago the hub stopped waiting for the client's report. */
  heldFor: string;
  /** Null for a send that is not a greeting. */
  greeting: GreetingCell | null;
}

export interface ResolvedSendRow {
  key: string;
  /** The attempt id: the audit event of the resolve names the send by it. */
  attemptId: string;
  pageLabel: string;
  fanRef: string;
  purpose: string;
  part: string;
  username: string;
  dispatchedAt: string;
  outcome: string;
  /** True for "sent": the row reads as a send that happened. */
  sent: boolean;
  resolvedBy: string;
  resolvedAt: string;
  note: string;
  /** The OnlyFans message id the resolver recorded; null when they recorded none. */
  platformMessageId: string | null;
}

export function heldSendRows(items: readonly Item[], serverNow: string, timeZone?: string): HeldSendRow[] {
  const now = new Date(serverNow);
  return items.map((item) => ({
    key: item.attemptId,
    item,
    pageLabel: item.pageLabel,
    fanRef: item.fanRef,
    purpose: purposeLabel(item.purpose),
    part: partLabel(item),
    username: item.username,
    install: shortId(item.instanceId),
    dispatchedAt: formatMoment(item.createdAt, now, timeZone),
    heldFor: formatSpan(now.getTime() - heldSince(item)),
    greeting: greetingCell(item, now, timeZone),
  }));
}

/** The audit trail of the resolves: one row per send a person ended. A row the hub sent without a resolve is skipped. */
export function resolvedSendRows(items: readonly Item[], serverNow: string, timeZone?: string): ResolvedSendRow[] {
  const now = new Date(serverNow);
  return items.flatMap((item) => {
    const { resolution } = item;
    if (resolution === null) return [];
    return [{
      key: item.attemptId,
      attemptId: item.attemptId,
      pageLabel: item.pageLabel,
      fanRef: item.fanRef,
      purpose: purposeLabel(item.purpose),
      part: partLabel(item),
      username: item.username,
      dispatchedAt: formatMoment(item.createdAt, now, timeZone),
      outcome: outcomeLabel(resolution.outcome),
      sent: resolution.outcome === "sent",
      resolvedBy: resolution.username,
      resolvedAt: formatMoment(resolution.at, now, timeZone),
      note: resolution.note,
      platformMessageId: resolution.platformMessageId,
    }];
  });
}
