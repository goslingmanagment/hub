import { formatUsdFromMills } from "@agency_hub_core/shared";
import type { OfLink, OfLinksResponse } from "@agency_hub_core/contracts";
import { formatAgo, formatDate, formatDateTime } from "@/lib/format";

// «Ссылки OnlyFans»: what the owner reads in each cell of the links table,
// and the warning lines above it. Pure: the time is a parameter.

type OfLinksPage = OfLinksResponse["pages"][number];
type OfLinksPageKind = OfLinksPage["kinds"][number];

/** «9 сент.», a year only when it is not this one: the console's date (lib/format.ts). */
export function moscowShortDate(iso: string): string {
  return new Date(iso).getFullYear() === new Date().getFullYear() ? formatDate(iso) : formatDate(iso, { includeYear: true });
}

/** «1 нояб., 03:00», by Moscow. */
export function moscowDateTime(iso: string): string {
  return formatDateTime(iso, { yearUnlessCurrent: true });
}

/** «5 мин назад», «7 ч назад», «2 дня назад». */
export function agoText(iso: string, now: number): string {
  return formatAgo(iso, now);
}

export const money = (mills: number) => formatUsdFromMills(mills);
export const count = (value: number) => value.toLocaleString("ru-RU");

export const linkKindLabels = { tracking: "Трекинг-ссылка", trial: "Пробная ссылка" } as const;
const kindTitles = { tracking: "Трекинг-ссылки", trial: "Пробные ссылки" } as const;

export type Tone = "ok" | "muted" | "warn";

/** The badge class of a tone. Everything of the links froze with the API: grey (fans-page.md §9.6). */
export const toneBadge: Record<Tone, string> = { ok: "badge badge-off", muted: "badge badge-off", warn: "badge badge-off" };

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
  /** Whether it came with, or after, a change of the page's OnlyFans API account. */
  account: string | null;
}

export function vendorMoneyView(link: Pick<OfLink, "vendorMoney">): { amount: string | null; note: string; recalculation: RecalculationView | null } {
  const vendor = link.vendorMoney;
  const last = vendor.lastRecalculation;
  const recalculation = last === null ? null : {
    when: moscowShortDate(last.observedAt),
    change: `${money(last.fromMills)} → ${money(last.toMills)}`,
    account: last.bindingChanged
      ? "вместе со сменой аккаунта OnlyFans API"
      : last.accountChangedAt ? `после смены аккаунта ${moscowShortDate(last.accountChangedAt)}` : null,
  };
  if (vendor.netMills === null) {
    return { amount: null, note: vendor.isLoading ? "OnlyFans ещё считает" : "OnlyFans не сообщил", recalculation };
  }
  return {
    amount: money(vendor.netMills),
    note: vendor.calculatedAt ? `расчёт ${moscowDateTime(vendor.calculatedAt)}` : "время расчёта неизвестно",
    recalculation,
  };
}

const hubReasons = {
  not_computed: "Hub пока не считает",
  no_completed_walk: "подсчёт Hub не завершён",
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

/** Below one cent a difference shows as "$0.00", without a sign. */
const CENT_MILLS = 10;

export interface DifferenceView {
  /** "+$12.30", "−…", "$0.00"; null when the two figures cannot be compared. */
  amount: string | null;
  /** Over which stretch: the difference is of the money in it, never of the
   *  totals shown beside it. "за период с 08.10.26" */
  period: string;
  /** What is compared: "OnlyFans $52.50 · Hub $52.50" (the OnlyFans figure's
   *  increase over the period, Hub's figure over the same period). */
  figures: string;
  /** The comparison's state, in the owner's words. */
  note: string;
}

export function differenceView(link: Pick<OfLink, "comparison">): DifferenceView {
  const comparison = link.comparison;
  if (comparison.state === null) {
    return { amount: null, period: "", figures: "", note: "" };
  }
  const since = comparison.fromAt ? moscowShortDate(comparison.fromAt) : null;
  const figures = comparison.vendorDeltaMills === null || comparison.hubNetMills === null
    ? ""
    : `OnlyFans ${money(comparison.vendorDeltaMills)}, Hub ${money(comparison.hubNetMills)}`;
  if (comparison.state === "incomplete") {
    return { amount: null, period: "", figures: "", note: `${comparisonLabels.incomplete}: сравнивать рано` };
  }
  if (comparison.state === "different_history") {
    return {
      amount: null,
      period: since ? `OnlyFans за всё время, Hub с ${since}` : "",
      figures,
      note: `${comparisonLabels.different_history}: не сравнимы`,
    };
  }
  const difference = comparison.differenceMills;
  if (difference === null) {
    return { amount: null, period: "", figures, note: comparisonLabels[comparison.state] };
  }
  const amount = Math.abs(difference) < CENT_MILLS
    ? money(0)
    : `${difference > 0 ? "+" : ""}${money(difference)}`;
  return {
    amount,
    period: since ? `за период с ${since}` : "",
    figures: figures.replace(" · ", ", "),
    note: comparisonLabels[comparison.state],
  };
}

export function bindingView(link: Pick<OfLink, "binding">): { channel: string; contractor: string; dates: string; assumed: boolean } | null {
  const binding = link.binding;
  if (binding === null) return null;
  const dates = binding.validTo === null
    ? `с ${moscowShortDate(binding.validFrom)}`
    : `${moscowShortDate(binding.validFrom)} – ${moscowShortDate(binding.validTo)}`;
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
  page_unmapped: "у страницы нет аккаунта OnlyFans API",
  page_auth_dead: "сессия страницы в OnlyFans API не действует",
  ofapi_mapping_changed: "аккаунт OnlyFans API сменился",
  ofapi_client_not_configured: "OnlyFans API не настроен",
  window_missed: "окно прошло без попытки",
  empty_unverified: "пустой ответ ещё не подтверждён",
  inventory_vanished: "ссылки пропали из ответа, ждём подтверждения",
  binding_changed: "первое чтение под новым аккаунтом OnlyFans API",
  walk_truncated: "обход прерван",
};

export function attemptText(attempt: NonNullable<OfLinksPageKind["lastAttempt"]>): string {
  const reason = attempt.reason === null ? "" : attempt.reason.split(",").map((code) => reasonLabels[code] ?? code).join(", ");
  return `${moscowDateTime(attempt.observedAt)}: ${runStatusLabels[attempt.status]}${reason ? `, ${reason}` : ""}`;
}

/** The warning lines above the table: a page nobody can read, a list not
 * written for two windows and more, a last read that gave nothing. */
export function pageWarnings(page: OfLinksPage, staleAfterHours: number): string[] {
  const lines: string[] = [];
  if (!page.ofapiMapped) {
    lines.push("Страница не привязана к аккаунту OnlyFans API: ссылки не собираются.");
  }
  for (const kind of page.kinds) {
    const title = kindTitles[kind.linkKind];
    const last = kind.lastAttempt === null ? "" : ` Последняя попытка ${attemptText(kind.lastAttempt)}.`;
    if (kind.stale) {
      const since = kind.lastUsableAt === null
        ? "ещё ни разу не собирались"
        : `не обновлялись с ${moscowDateTime(kind.lastUsableAt)}, дольше ${staleAfterHours} ч`;
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

