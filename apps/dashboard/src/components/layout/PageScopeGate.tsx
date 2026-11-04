import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { useAuthMe, useOverview } from "@/api/queries";
import { useOfapiStatus } from "@/api/waiting";
import { PLATFORM_WORD, PlatformBadge } from "@/components/shared/PlatformBadge";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { OFAPI_FROZEN_NOTE } from "@/lib/statusWords";
import { useDashboardShell } from "./DashboardShellContext.js";
import { usePageFilter } from "./usePageFilter.js";

type Metric = { value: number | null; available: boolean } | undefined;

function count(metric: Metric): string {
  return metric?.available && metric.value !== null ? metric.value.toLocaleString("ru-RU") : "—";
}

/** Free subscriptions: on Fansly the free audience is its followers, so they are
 *  what is left of the subscribers after the paid ones; elsewhere the hub says. */
function freeSubscriptions(row: { platform: string; subscriberCount: Metric; paidSubscriberCount: Metric; freeAudienceCount: Metric } | undefined): string {
  if (!row) return "—";
  if (row.platform !== "fansly") return count(row.freeAudienceCount);
  const { subscriberCount: all, paidSubscriberCount: paid } = row;
  if (!all?.available || all.value === null || !paid?.available || paid.value === null) return "—";
  return Math.max(0, all.value - paid.value).toLocaleString("ru-RU");
}

/**
 * «Все страницы» on a screen the hub answers for one page only: not somebody
 * else's list, but the pages with their numbers. A click on a row is a choice by
 * hand: the page goes into the filter and the address.
 */
function PagePicker() {
  const filter = usePageFilter();
  const { pages } = useDashboardShell();
  const overview = useOverview();
  const { data: auth } = useAuthMe();
  const ofapi = useOfapiStatus(auth?.user.role ?? "team_lead");
  const offered = pages.filter((page) => !filter.screen?.platforms || filter.screen.platforms.includes(page.platform));

  if (offered.length === 0) return <StatusPanel title="Нет подходящих страниц" description={filter.screen?.platformsNote} />;
  if (overview.isLoading) return <TableSkeleton rows={Math.min(offered.length, 8)} columns={5} />;

  const numbers = new Map((overview.data?.pages ?? []).map((page) => [page.label, page]));
  const frozen = (page: { platform: string }) => page.platform === "onlyfans" && ofapi === "off";
  return (
    <section className="card" aria-labelledby="page-picker-title">
      <div className="card-header">
        <div>
          <h2 id="page-picker-title" className="card-title">Выберите страницу</h2>
          <p className="card-description">Этот список Hub отдаёт по одной странице.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Страница</th>
              <th scope="col">Модель</th>
              <th scope="col">Площадка</th>
              <th scope="col" className="num">Платные</th>
              <th scope="col" className="num">Бесплатные</th>
              <th scope="col" className="num">Фолловеры</th>
            </tr>
          </thead>
          <tbody>
            {offered.map((page) => {
              const row = numbers.get(page.label);
              return (
                <tr key={page.label} className="cursor-pointer" onClick={() => filter.select(page.label)}>
                  <td>
                    <button type="button" className="font-medium" onClick={() => filter.select(page.label)}>{page.label}</button>
                  </td>
                  <td className="muted">{page.modelName}</td>
                  <td><PlatformBadge platform={page.platform} /></td>
                  <td className="num">{count(row?.paidSubscriberCount)}{frozen(page) && <span className="audience-note block">{OFAPI_FROZEN_NOTE}</span>}</td>
                  <td className="num">{freeSubscriptions(row)}{frozen(page) && <span className="audience-note block">{OFAPI_FROZEN_NOTE}</span>}</td>
                  <td className="num">{page.platform === "fansly" ? count(row?.followerCount) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The chosen page has no data of this kind: said plainly, never another page in its place. */
function OutOfScopePanel() {
  const filter = usePageFilter();
  const { pages } = useDashboardShell();
  const { item, screen } = filter;
  if (!item || !screen) return null;

  if (screen.id.startsWith("stats")) {
    const fansly = pages.filter((page) => page.platform === "fansly");
    return (
      <StatusPanel
        title="Статистику Hub собирает только для Fansly"
        description={`${item.label} — страница ${PLATFORM_WORD[item.platform]}.${fansly.length === 0 ? " Страниц Fansly нет." : ""}`}
        action={fansly.map((page) => (
          <button key={page.label} type="button" className="btn btn-sm" onClick={() => filter.select(page.label)}>{page.label}</button>
        ))}
      />
    );
  }
  // A screen may say its own thing about Telegram (Публикации); elsewhere Hub just
  // collects nothing there.
  const telegram = item.platform === "telegram";
  const title = telegram
    ? screen.telegramNote?.title ?? "Hub не собирает данные Telegram"
    : screen.platformsNote ?? `У страницы ${item.label} нет таких данных`;
  const onPageCard = screen.section === "page";
  return (
    <StatusPanel
      title={title}
      {...(telegram && screen.telegramNote ? { description: screen.telegramNote.text } : {})}
      action={onPageCard
        ? undefined
        : <button type="button" className="btn btn-sm" onClick={() => filter.select(null)}>Все страницы</button>}
    />
  );
}

/**
 * What stands between the frame and a screen that needs a certain page: the
 * screen sees only a page it can answer for.
 */
export function PageScopeGate({ children }: { children: ReactNode }) {
  const filter = usePageFilter();
  const { pages, pageCatalogState, retryPageCatalog } = useDashboardShell();
  const [search] = useSearchParams();
  if (filter.outOfScope) return <OutOfScopePanel />;
  // The remembered page is on its way to the address (the frame's sync): the old
  // screens read it from there, and must not ask for every page first.
  if ((filter.mode === "any" || filter.mode === "one") && filter.page !== null && search.get("page") !== filter.page) {
    return <TableSkeleton rows={6} columns={5} />;
  }
  if (filter.mode === "one" && filter.page === null) {
    if (pageCatalogState === "loading") return <TableSkeleton rows={6} columns={5} />;
    // No answer is not «no pages».
    if (pageCatalogState === "error") return <NoAnswerPanel retry={retryPageCatalog} />;
    if (filter.onePageWay === "picker") return <PagePicker />;
    // «Статистика» is about to get its page from the sync, unless there is none.
    const hasOne = pages.some((page) => !filter.screen?.platforms || filter.screen.platforms.includes(page.platform));
    return hasOne ? null : (
      <StatusPanel
        title="Нет страниц Fansly"
        description="Статистика собирается только для страниц Fansly."
        action={<Link className="btn btn-sm" to="/settings/pages">Модели и страницы</Link>}
      />
    );
  }
  return <>{children}</>;
}
