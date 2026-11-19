/**
 * A product's frame (products plan §2.1, §7): Hub (the console) and Workboard
 * each draw their own frame with their own name, accent and menu from the one
 * table (screens.ts); the frame is chosen by the product, never by the role or
 * the host. What both apps need to agree on lives here, without React: the
 * product's name, the switcher's list, what a link to the other product
 * carries, the words of the frame, the one read behind the menu's number.
 *
 * Going to the other product is a page load to its own name, through the
 * one-time hand-off when the names differ (sites.ts), signed in on the way.
 */
import type { KernelClient } from "@kernel/sdk";
import type { MattersWaitingResponse, Product, WaitingProductId } from "@agency_hub_core/contracts";
import { PLACES } from "@agency_hub_core/look/words";
import { WORKBOARD_PATH, matchScreen, type MenuItem, type PeriodKey, type ScreenProduct } from "./screens.js";
import { CONTENTOPS_SIGNIN_HREF, MONITOR_ORIGIN, TASKS_ORIGIN, hubEntryHref, workboardEntryHref } from "./sites.js";

/** The brand line of a product's frame and the browser tab's last word (look/words.ts). */
export function productName(product: ScreenProduct): string {
  return PLACES[product];
}

/** A product's home on its own name: Hub's root, Workboard's base. */
export function productHome(product: ScreenProduct): string {
  return product === "hub" ? "/" : WORKBOARD_PATH;
}

// ── The switcher ─────────────────────────────────────────────────────────

/** One line of the products' switcher. */
export interface ProductLink {
  id: Product;
  label: string;
  /** Where it leads from this page: another name through the hand-off, ContentOps through its own Hub entry. */
  href: string;
  /** The product this frame is. */
  current: boolean;
  /** An outside tool, said quieter under the products (Задачи, Монитор). */
  quiet: boolean;
}

const QUIET: ReadonlySet<Product> = new Set(["tasks", "monitor"]);

/**
 * The switcher's lines for the products this person has (`auth/me`'s `products`, the server's list), from a page of
 * `here` on `origin`. One step and no second sign-in: Hub and Workboard cross names by the one-time hand-off,
 * ContentOps, Задачи and Монитор sign in through Hub on their own pages. Fewer than two products: no switcher.
 */
export function productLinks(products: readonly Product[] | undefined, here: ScreenProduct, origin: string): ProductLink[] {
  const list = products ?? [];
  if (list.length < 2) return [];
  const hrefOf = (id: Product): string => {
    switch (id) {
      case "hub": return here === "hub" ? productHome("hub") : hubEntryHref(origin, productHome("hub"));
      case "workboard": return here === "workboard" ? productHome("workboard") : workboardEntryHref(origin, productHome("workboard"));
      case "contentops": return CONTENTOPS_SIGNIN_HREF;
      case "tasks": return `${TASKS_ORIGIN}/`;
      case "monitor": return `${MONITOR_ORIGIN}/`;
    }
  };
  return list.map((id) => ({ id, label: PLACES[id], href: hrefOf(id), current: id === here, quiet: QUIET.has(id) }));
}

/** The account's role under its name. */
const ROLE_WORDS: Readonly<Record<string, string>> = { owner: "Владелец", team_lead: "Тимлид", chatter: "Чаттер", content_manager: "Контент-менеджер" };

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

/** The console's period as the carried one. */
export function consoleDays(period: PeriodKey | null): 14 | 30 | null {
  return period === "14d" ? 14 : period === "30d" ? 30 : null;
}

/**
 * The address of a menu item of the other app, with the filters the screen it
 * opens shares: Workboard takes `?page=` and `?days=` on every screen; a console
 * screen takes the page where it has the page filter, the period where its own
 * (remembered) period has that value. A path of the item's own name: a frame
 * leads there with `crossHref`.
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

/** An address of the other product's app from a page on `origin`: on its own name, through the hand-off when the names differ. */
export function crossHref(app: MenuItem["app"], path: string, origin: string): string {
  return app === "workboard" ? workboardEntryHref(origin, path) : hubEntryHref(origin, path);
}

// ── The menu's number ────────────────────────────────────────────────────

/**
 * «Ждут вас»: one read in both products, the same answer, so the number does not
 * change when the owner crosses from one product to the other. It is the sum of
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

/**
 * The number of «Ждут вас» from its read: nothing while it is read, «?» when it failed. Hub's is the whole (the
 * owner's combined list); with `product`, that product's part of the same read (the owner's Workboard: its list is
 * Workboard's cut).
 */
export function waitingCount(read: { data: MattersWaitingResponse | undefined; isError: boolean }, product?: WaitingProductId): MenuCountView | null {
  if (read.data) {
    if (product === undefined) return { value: read.data.total, unknown: read.data.failed.length > 0 };
    const part = (read.data.products ?? []).find((one) => one.id === product);
    return { value: part?.count ?? 0, unknown: part !== undefined && !part.checked };
  }
  return read.isError ? { value: 0, unknown: true } : null;
}
