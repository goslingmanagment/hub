import { formatUsdFromMills } from "@agency_hub_core/shared";
import type { OfLink, OfLinksResponse } from "@agency_hub_core/contracts";

// «Ссылки OnlyFans»: what the owner reads in each cell of the links table,
// and the warning lines above it. Pure: the time is a parameter.

type OfLinksPage = OfLinksResponse["pages"][number];
type OfLinksPageKind = OfLinksPage["kinds"][number];

const TIME_ZONE = "Europe/Moscow";

/** "09.09.26": the table's short date. */
export function moscowShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", timeZone: TIME_ZONE });
}

export function moscowDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: TIME_ZONE,
  });
}

/** "5 мин назад", "7 ч назад", "2 дн. назад". */
export function agoText(iso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} ч назад`;
  return `${Math.floor(hours / 24)} дн. назад`;
}

export const money = (mills: number) => formatUsdFromMills(mills);
export const count = (value: number) => value.toLocaleString("ru-RU");

export const linkKindLabels = { tracking: "tracking", trial: "trial" } as const;
const kindTitles = { tracking: "Tracking-ссылки", trial: "Trial-ссылки" } as const;

export type Tone = "ok" | "muted" | "warn";

export function linkStateView(link: Pick<OfLink, "state" | "linkEndsAt">): { label: string; detail: string; tone: Tone } {
  if (link.state === "expired") {
    return { label: "Истекла", detail: link.linkEndsAt ? moscowShortDate(link.linkEndsAt) : "", tone: "muted" };
  }
  if (link.state === "finished") {
    return { label: "Завершена", detail: link.linkEndsAt ? `срок до ${moscowShortDate(link.linkEndsAt)}` : "", tone: "muted" };
  }
  return { label: "Активна", detail: link.linkEndsAt ? `до ${moscowShortDate(link.linkEndsAt)}` : "без срока", tone: "ok" };
}

export function fansView(link: Pick<OfLink, "fans" | "fansMetric">): { value: string; metric: string } {
  return {
    value: link.fans === null ? "—" : count(link.fans),
    metric: link.fansMetric === "claims" ? "активации" : "подписчики",
  };
}

export interface RecalculationView {
  /** "пересчёт 09.09.26" */
  when: string;
  /** "$992.00 → $728.00" */
  change: string;
  /** Whether it came with, or after, a change of the page's OFAPI account. */
  account: string | null;
}

export function vendorMoneyView(link: Pick<OfLink, "vendorMoney">): { amount: string | null; note: string; recalculation: RecalculationView | null } {
  const vendor = link.vendorMoney;
  const last = vendor.lastRecalculation;
  const recalculation = last === null ? null : {
    when: `пересчёт ${moscowShortDate(last.observedAt)}`,
    change: `${money(last.fromMills)} → ${money(last.toMills)}`,
    account: last.bindingChanged
      ? "вместе со сменой аккаунта OFAPI"
      : last.accountChangedAt ? `после смены аккаунта ${moscowShortDate(last.accountChangedAt)}` : null,
  };
  if (vendor.netMills === null) {
    return { amount: null, note: vendor.isLoading ? "OFAPI ещё считает" : "OFAPI не сообщил", recalculation };
  }
  return {
    amount: money(vendor.netMills),
    note: vendor.calculatedAt ? `расчёт ${moscowDateTime(vendor.calculatedAt)}` : "время расчёта неизвестно",
    recalculation,
  };
}

const hubReasons = {
  not_computed: "Hub пока не считает",
  no_completed_walk: "нет полного прохода",
  before_floor: "до начала счёта Hub",
} as const;

export function hubMoneyView(link: Pick<OfLink, "hubMoney">): { amount: string | null; note: string } {
  const hub = link.hubMoney;
  if (hub.state !== "available" || hub.netMills === null) {
    return { amount: null, note: hub.reason === null ? "нет данных" : hubReasons[hub.reason] };
  }
  const pending = hub.pendingMills ? ` · ещё ${money(hub.pendingMills)} в ожидании` : "";
  return { amount: money(hub.netMills), note: (hub.floorAt ? `с ${moscowShortDate(hub.floorAt)}` : "") + pending };
}

const comparisonLabels = {
  comparable: "сопоставимо",
  different_history: "разные периоды",
  provisional: "предварительно",
  incomplete: "неполные данные",
} as const;

export function differenceView(link: Pick<OfLink, "comparison">): { amount: string | null; note: string } {
  const comparison = link.comparison;
  if (comparison.state === null || comparison.differenceMills === null) {
    return { amount: null, note: "" };
  }
  const sign = comparison.differenceMills > 0 ? "+" : "";
  return { amount: `${sign}${money(comparison.differenceMills)}`, note: comparisonLabels[comparison.state] };
}

export function bindingView(link: Pick<OfLink, "binding">): { channel: string; contractor: string; dates: string; assumed: boolean } | null {
  const binding = link.binding;
  if (binding === null) return null;
  const dates = binding.validTo === null
    ? `с ${moscowShortDate(binding.validFrom)}`
    : `${moscowShortDate(binding.validFrom)} — ${moscowShortDate(binding.validTo)}`;
  return {
    channel: binding.channelTitle,
    contractor: binding.contractor === null ? "подрядчик не указан" : binding.contractor.contractorTitle,
    dates,
    assumed: binding.validFromBasis === "assumed_link_created",
  };
}

const runStatusLabels = {
  complete: "полный ответ",
  partial: "частичный ответ",
  truncated: "обход прерван",
  failed: "ошибка",
  skipped: "попытки не было",
} as const;

const reasonLabels: Record<string, string> = {
  page_unmapped: "у страницы нет аккаунта OFAPI",
  page_auth_dead: "сессия страницы в OFAPI не действует",
  ofapi_mapping_changed: "аккаунт OFAPI сменился",
  ofapi_client_not_configured: "OFAPI не настроен",
  window_missed: "окно прошло без попытки",
  empty_unverified: "пустой ответ ещё не подтверждён",
  inventory_vanished: "ссылки пропали из ответа, ждём подтверждения",
  binding_changed: "первое чтение под новым аккаунтом OFAPI",
  walk_truncated: "обход прерван",
};

export function attemptText(attempt: NonNullable<OfLinksPageKind["lastAttempt"]>): string {
  const reason = attempt.reason === null ? "" : attempt.reason.split(",").map((code) => reasonLabels[code] ?? code).join(", ");
  return `${moscowDateTime(attempt.observedAt)} — ${runStatusLabels[attempt.status]}${reason ? `: ${reason}` : ""}`;
}

/** The warning lines above the table: a page nobody can read, a list not
 * written for two windows and more, a last read that gave nothing. */
export function pageWarnings(page: OfLinksPage, staleAfterHours: number): string[] {
  const lines: string[] = [];
  if (!page.ofapiMapped) {
    lines.push("Страница не привязана к аккаунту OFAPI: ссылки не собираются.");
  }
  for (const kind of page.kinds) {
    const title = kindTitles[kind.linkKind];
    const last = kind.lastAttempt === null ? "" : ` Последняя попытка ${attemptText(kind.lastAttempt)}.`;
    if (kind.stale) {
      const since = kind.lastUsableAt === null
        ? "ещё ни разу не собирались"
        : `не обновлялись с ${moscowDateTime(kind.lastUsableAt)} — дольше ${staleAfterHours} ч`;
      lines.push(`${title}: ${since}.${last}`);
    } else if (kind.lastAttempt !== null && !kind.lastAttempt.usable) {
      const shown = kind.lastUsableAt === null ? "" : ` Показаны данные сбора ${moscowDateTime(kind.lastUsableAt)}.`;
      lines.push(`${title}: последний сбор не дал данных.${last}${shown}`);
    }
  }
  return lines;
}

const stateOrder = { active: 0, finished: 1, expired: 2 } as const;

/** Active links first; within a state, the most fans first. */
export function sortLinks(links: readonly OfLink[]): OfLink[] {
  return [...links].sort((left, right) =>
    stateOrder[left.state] - stateOrder[right.state]
    || (right.fans ?? -1) - (left.fans ?? -1)
    || left.linkRef.localeCompare(right.linkRef));
}

export type LinkFilter = "all" | "active" | "closed";

export function filterLinks(links: readonly OfLink[], filter: LinkFilter): OfLink[] {
  if (filter === "active") return links.filter((link) => link.state === "active");
  if (filter === "closed") return links.filter((link) => link.state !== "active");
  return [...links];
}

/** Totals of what is shown: fans are claims of trial links plus subscribers
 * of tracking links; money over the links that know it. */
export function linkTotals(links: readonly OfLink[]) {
  let clicks = 0;
  let fans = 0;
  let vendorMills = 0;
  let unknownMoney = 0;
  for (const link of links) {
    clicks += link.clicks;
    fans += link.fans ?? 0;
    if (link.vendorMoney.netMills === null) unknownMoney += 1;
    else vendorMills += link.vendorMoney.netMills;
  }
  return { clicks, fans, vendorMills, unknownMoney };
}
