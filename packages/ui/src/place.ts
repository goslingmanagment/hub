/**
 * The owner's place across two apps (ecosystem plan §3.1, package L1): the
 * console and Workboard draw one frame with one menu (screens.ts) for the owner
 * and team leads. What both apps need to agree on lives here, without React:
 * which face a session sees, what a link to the other app carries, the words of
 * the frame, the one read behind the menu's number.
 *
 * Going from a console screen to a Workboard screen is a page load between two
 * bundles; nothing on the frame moves: the same item stays lit, and the page
 * filter and the period both screens have go along in the address.
 */
import type { KernelClient } from "@kernel/sdk";
import type { MattersWaitingResponse } from "@agency_hub_core/contracts";
import { PLACES } from "@agency_hub_core/look/words";
import { matchScreen, type MenuItem, type PeriodKey } from "./screens.js";
import { siteOf } from "./sites.js";

/**
 * Which menu a session sees:
 * - `place` — the owner's place: the owner or a team lead on the console's name
 *   (or a local build on one name), in either app. One menu, one frame.
 * - `team` — the team's place: a chatter anywhere, a narrow session from the
 *   extension, anyone on the team's name. Workboard's own short menu, as it was.
 */
export type PlaceFace = "place" | "team";

export function placeFace(input: { role: string | null; narrow: boolean; origin: string }): PlaceFace {
  if (input.narrow || (input.role !== "owner" && input.role !== "team_lead")) return "team";
  return siteOf(input.origin) === "team" ? "team" : "place";
}

/** The brand line of the frame and the browser tab's last word, by face (look/words.ts). */
export function placeName(face: PlaceFace): string {
  return face === "place" ? PLACES.hub : PLACES.workboard;
}

/** The account's role under its name. */
const ROLE_WORDS: Readonly<Record<string, string>> = { owner: "Владелец", team_lead: "Тимлид", chatter: "Чаттер" };

export function roleWord(role: string | null | undefined): string {
  return ROLE_WORDS[role ?? ""] ?? "Сотрудник";
}

// ── What a link to the other app carries ─────────────────────────────────

/**
 * The filters of the screen being left that the next one may share: the page
 * (a label; null — every page) and the period, when it is one both apps have
 * (14 or 30 days back from today; the console's calendar-free «7 дней» and
 * Workboard's week are different things and stay behind).
 */
export interface CarriedFilters {
  page: string | null;
  days: 14 | 30 | null;
}

/** Workboard's period in its address (`?days=14|30`), as the carried one. */
export function workboardDays(search: URLSearchParams): 14 | 30 | null {
  const days = search.get("days");
  return days === "14" ? 14 : days === "30" ? 30 : null;
}

/** The console's period as the carried one. */
export function consoleDays(period: PeriodKey | null): 14 | 30 | null {
  return period === "14d" ? 14 : period === "30d" ? 30 : null;
}

/**
 * The address of a menu item of the other app, with the filters the screen it
 * opens shares: Workboard takes `?page=` and `?days=` on every screen; a console
 * screen takes the page where it has the page filter, the period where its own
 * (remembered) period has that value.
 */
export function carriedHref(item: Pick<MenuItem, "to" | "app">, filters: CarriedFilters): string {
  const query = new URLSearchParams();
  if (item.app === "workboard") {
    if (filters.page) query.set("page", filters.page);
    if (filters.days) query.set("days", String(filters.days));
  } else {
    const screen = matchScreen(item.to)?.screen;
    if (screen && filters.page && (screen.pageFilter === "any" || screen.pageFilter === "one")) query.set("page", filters.page);
    const key: PeriodKey | null = filters.days ? `${filters.days}d` : null;
    if (screen?.period?.class === "shared" && key && screen.period.options.includes(key)) query.set("period", key);
  }
  const search = query.toString();
  return search ? `${item.to}?${search}` : item.to;
}

// ── The menu's number ────────────────────────────────────────────────────

/**
 * «Ждут вас»: one read in both apps, the same answer, so the number does not
 * change when the owner crosses from one app to the other. It is the sum of
 * what waits (`total` of `mattersWaiting`: Hub mirrors its sources into
 * matters every minute, the ledger's every five). The query key is the one
 * the screens of matters read, so they share the answer.
 */
export function waitingQuery(kernel: KernelClient) {
  return {
    queryKey: ["matters", "waiting", ""] as const,
    queryFn: () => kernel.mattersWaiting({ query: {} }),
    staleTime: 30_000,
    refetchInterval: 60_000,
  };
}

export interface MenuCountView {
  /** What waits; 0 shows nothing. */
  value: number;
  /** Something could not be checked: a quiet «?», never a silent zero. */
  unknown: boolean;
}

/** The number of «Ждут вас» from its read: nothing while it is read, «?» when it failed. */
export function waitingCount(read: { data: MattersWaitingResponse | undefined; isError: boolean }): MenuCountView | null {
  if (read.data) return { value: read.data.total, unknown: read.data.failed.length > 0 };
  return read.isError ? { value: 0, unknown: true } : null;
}
