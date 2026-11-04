import { useState } from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";
import { sumMills } from "@agency_hub_core/shared";
import { useAuthMe } from "@/api/queries";
import { useOfLinks } from "@/api/ofLinks";
import { useOfapiStatus } from "@/api/waiting";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import { NoAnswerPanel } from "@/components/shared/StatusPanel";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { formatCount, formatMills } from "@/lib/format";
import { decodeRouteSegment } from "@/lib/navigation";
import { OfLinksTable } from "@/pages/marketing/OfLinksTable";
import { filterLinks, moscowDateTime, pageWarnings, sortLinks, type LinkFilter } from "@/pages/marketing/ofLinksView";
import { useListParams } from "@/pages/fans/listParts";

const FILTERS: ReadonlyArray<{ value: LinkFilter; label: string }> = [
  { value: "all", label: "Все" },
  { value: "active", label: "Активные" },
  { value: "closed", label: "Завершённые и истёкшие" },
];

/**
 * «Продвижение» of an OnlyFans page: what each link brought, as of 1 November.
 * A local read of the link series: no request reaches OnlyFans (§9.6).
 */
export function PromoOnlyFans() {
  const { pageLabel = "" } = useParams<{ pageLabel: string }>();
  const label = decodeRouteSegment(pageLabel);
  const { findPageByLabel } = useDashboardShell();
  const page = findPageByLabel(label);
  const { data: auth } = useAuthMe();
  const ofapi = useOfapiStatus(auth?.user.role === "owner" ? "owner" : "team_lead");
  const links = useOfLinks(page?.id, { enabled: page !== null });
  const { search, update } = useListParams();
  const raw = search.get("links");
  const filter: LinkFilter = raw === "active" || raw === "closed" ? raw : "all";
  const [refreshing, setRefreshing] = useState(false);

  if (!links.data) {
    return links.isError ? <NoAnswerPanel retry={links.refetch} /> : <TableSkeleton rows={6} columns={6} />;
  }
  const data = links.data;
  const card = data.pages.find((item) => item.pageId === page?.id) ?? null;
  const pageLinks = sortLinks(data.links.filter((link) => link.pageId === page?.id));
  const shown = filterLinks(pageLinks, filter);
  const now = Date.parse(data.generatedAt);
  const lastUsable = card?.kinds.map((kind) => kind.lastUsableAt).filter((at): at is string => at !== null).sort().at(-1) ?? null;
  const warnings = ofapi === "on" && card ? pageWarnings(card, data.staleAfterHours) : [];
  // Totals of what is shown: counts as counts, money through the money helper.
  const clicks = shown.reduce((sum, link) => sum + link.clicks, 0);
  const fans = shown.reduce((sum, link) => sum + (link.fans ?? 0), 0);
  const vendor = sumMills(shown.flatMap((link) => (link.vendorMoney.netMills === null ? [] : [link.vendorMoney.netMills])));
  const unknown = shown.filter((link) => link.vendorMoney.netMills === null).length;

  return (
    <div className="pc-promo">
      <PageHeader
        fresh={{
          at: data.generatedAt,
          frozen: ofapi === "off",
          refreshing,
          onRefresh: () => {
            setRefreshing(true);
            void links.refetch().then((result) => {
              if (!result.isError) toast.success("Данные перечитаны из Hub. Запросов к OnlyFans API не было.");
            }).finally(() => setRefreshing(false));
          },
        }}
      />
      <QueryNotice error={links.isError} stale retry={links.refetch} at={links.dataUpdatedAt} />
      {/* The header already says the API is off: here only when the links were read last. */}
      {ofapi === "off" && <p className="fan-muted-line">Ссылки и суммы — по 1 ноября.{lastUsable && ` Последний сбор: ${moscowDateTime(lastUsable)}.`}</p>}
      {card && !card.ofapiMapped && ofapi !== "on" && <p className="fan-muted-line">Страница не привязана к аккаунту OnlyFans API: ссылки не собирались.</p>}
      {warnings.length > 0 && (
        <Notice tone="warning">
          {warnings.map((line) => <span key={line} className="block">{line}</span>)}
        </Notice>
      )}
      <section className="card" aria-labelledby="of-links-title">
        <div className="card-header">
          <div className="min-w-0">
            <h2 id="of-links-title" className="card-title">Ссылки OnlyFans</h2>
            {shown.length > 0 && (
              <p className="card-description">
                Показано {formatCount(shown.length)}, клики {formatCount(clicks)}, фаны {formatCount(fans)}, доход по OnlyFans {formatMills(vendor)} после комиссии{unknown > 0 ? ` (у ${unknown} сумма неизвестна)` : ""}
              </p>
            )}
          </div>
          <Segmented
            label="Какие ссылки показать"
            value={filter}
            onChange={(next) => update({ links: next === "all" ? null : next }, { keepPosition: true })}
            options={FILTERS.map((item) => ({ ...item, count: filterLinks(pageLinks, item.value).length }))}
          />
        </div>
        {pageLinks.length === 0 ? (
          <div className="empty"><p className="empty-title">{card?.kinds.some((kind) => kind.lastUsableAt !== null) ? "В последнем сборе нет ссылок этой страницы" : "Ссылки этой страницы ещё не собирались"}</p></div>
        ) : shown.length === 0 ? (
          <div className="empty"><p className="empty-title">Таких ссылок нет</p></div>
        ) : (
          <OfLinksTable links={shown} now={now} />
        )}
        <div className="card-footer">
          <span />
          <Link className="link" to="/system/onlyfans-api/collection">Правила сбора</Link>
        </div>
      </section>
      <details className="help">
        <summary>Как считаются фаны и доход</summary>
        <div className="help-body">
          <p>Фаны: у пробных ссылок — активации пробного периода, у трекинг-ссылок — подписчики.</p>
          <p>Доход по OnlyFans — расчёт OnlyFans API по подпискам с этой ссылки, его иногда пересчитывают задним числом. Доход по Hub — собственный расчёт Hub по журналу операций с даты, когда Hub начал видеть фанов ссылки.</p>
          <p>Обе суммы — после комиссии OnlyFans. Разница сравнивает их за один и тот же период: он указан в строке.</p>
        </div>
      </details>
    </div>
  );
}
