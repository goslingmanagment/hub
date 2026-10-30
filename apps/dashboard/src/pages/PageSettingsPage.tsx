import { useParams } from "react-router";

import { usePageSettings } from "@/api/page-settings";
import { AnalyticsEmpty, AnalyticsError, AnalyticsLoading, AnalyticsPanel } from "@/components/analytics/AnalyticsPanel";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { formatDate, formatRelativeTime } from "@/lib/format";

/**
 * The page's settings and standing on Fansly (0338), read once a day: what the
 * creator's settings screens show — privacy switches, geo-blocks, who sees the
 * timeline and who may write in DMs, the watermark, alerts, referrals, the
 * balance in hold, tip goals and the tags discovery keeps for the page. Each
 * row says since when it is so and what it was before. Fansly only.
 */

const ROUTES: { route: string; label: string }[] = [
  { route: "settings.account", label: "Аккаунт и приватность" },
  { route: "settings.geo_blocks", label: "Гео-блок" },
  { route: "settings.timeline_permissions", label: "Кто видит ленту" },
  { route: "settings.dm_permissions", label: "Кто пишет в ЛС" },
  { route: "settings.watermark", label: "Вотермарка" },
  { route: "settings.alerts", label: "Алерты (почта, пуш)" },
  { route: "earnings.overview", label: "Баланс в холде" },
  { route: "referrals.stats", label: "Рефералы" },
  { route: "tipgoals.account", label: "Цели типов" },
  { route: "discovery.content", label: "Метки For You" },
  { route: "discovery.tags", label: "Теги для поиска и For You" },
];

function day(iso: string): string {
  return formatDate(iso, { includeYear: true });
}

export function PageSettingsPage() {
  const { pageLabel = "" } = useParams<{ pageLabel: string }>();
  const query = usePageSettings(pageLabel);
  if (query.isPending) return <AnalyticsLoading what="Загружаем настройки…" />;
  if (query.isError || !query.data) return <AnalyticsError message="Не удалось загрузить настройки." onRetry={() => void query.refetch()} />;
  const { routes, page } = query.data;
  if (page.platform !== "fansly") return <StatusPanel title="Настройки собираются только у страниц Fansly" />;
  const byRoute = new Map(routes.map((row) => [row.route, row]));
  const checked = routes.reduce<string | null>((newest, row) => (newest === null || row.current.lastSeenAt > newest ? row.current.lastSeenAt : newest), null);
  return (
    <AnalyticsPanel
      title="Настройки страницы на Fansly"
      description={checked ? `Как в настройках кабинета · проверено ${formatRelativeTime(checked)}. Читается раз в сутки.` : "Читается раз в сутки."}
    >
      {routes.length === 0 ? <AnalyticsEmpty reason="Настройки ещё не прочитаны: первый проход — в течение суток после выкладки." /> : (
        <div className="card-body overflow-x-auto">
          <table className="data-table">
            <thead><tr><th>Что</th><th>Сейчас</th><th>С какого дня</th><th>Раньше</th></tr></thead>
            <tbody>
              {ROUTES.map(({ route, label }) => {
                const row = byRoute.get(route);
                return (
                  <tr key={route}>
                    <td className="whitespace-nowrap font-medium">{label}</td>
                    <td className="max-w-xl">
                      {row ? row.current.summary : <span className="text-muted">ещё не прочитано</span>}
                      {row ? (
                        <details className="mt-1 text-xs text-muted">
                          <summary>как прислал Fansly</summary>
                          <pre className="whitespace-pre-wrap break-all">{JSON.stringify(row.current.body, null, 1)}</pre>
                        </details>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap">{row ? day(row.current.firstSeenAt) : "—"}</td>
                    <td className="text-sm">
                      {row && row.earlier.length > 0 ? (
                        <ul className="space-y-0.5">
                          {row.earlier.slice(0, 5).map((version) => (
                            <li key={`${version.firstSeenAt}:${version.summary}`}><span className="text-muted">{day(version.firstSeenAt)}:</span> {version.summary}</li>
                          ))}
                        </ul>
                      ) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </AnalyticsPanel>
  );
}
