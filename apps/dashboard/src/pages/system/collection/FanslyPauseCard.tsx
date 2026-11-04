import { FANSLY_PAUSE_MIN_MS } from "@agency_hub_core/shared";
import { Link } from "react-router";
import { useAdminConfig } from "@/api/adminConfig";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatCount } from "@/lib/format";
import { ConfigEditor } from "@/pages/settings/ConfigurationEditors";
import { RunningCell } from "@/pages/settings/ConfigurationTab";

const KEY = "fanslyDefaultDelayMs";

/**
 * «Пауза между запросами Fansly»: the one business setting of the screen. The value
 * and the editor are the ones of «Все параметры», unchanged: the same key, version,
 * draft, conflict and the second press with «2 500 → 3 000» and its risk.
 */
export function FanslyPauseCard({ filteredPage }: { filteredPage: string | null }) {
  const config = useAdminConfig();
  const item = config.data?.subsystems.flatMap((subsystem) => subsystem.items).find((entry) => entry.key === KEY);
  return (
    <section id={`config-${KEY}`} tabIndex={-1} className="card" aria-labelledby="fansly-pause-title">
      <div className="card-header">
        <div className="min-w-0">
          <h2 id="fansly-pause-title" className="card-title">Пауза между запросами Fansly</h2>
          <p className="card-description">
            Одна настройка для всех страниц Fansly: наименьшая пауза между двумя запросами одной страницы.
            {filteredPage && <> Фильтр {filteredPage} на неё не влияет.</>}
          </p>
        </div>
      </div>
      <div className="card-body sys-pause">
        {config.isLoading && !config.data ? (
          <Skeleton width={320} />
        ) : !item ? (
          <div className="sys-pause-missing">
            <span>Hub не ответил.</span>
            <button type="button" className="btn btn-sm" onClick={() => void config.refetch()}>Повторить</button>
          </div>
        ) : (
          <div className="sys-pause-grid">
            <div className="sys-pause-now">
              <span className="text-text-secondary">Сейчас</span>
              <span className="sys-pause-value">
                {!item.drift && item.running.length > 0 && item.running.every((entry) => entry.state !== "unknown") && typeof item.running[0]?.value === "number"
                  ? `${formatCount(item.running[0].value)} мс`
                  : <><RunningCell item={item} /> мс</>}
              </span>
              <p className="cell-second">
                Не меньше {formatCount(FANSLY_PAUSE_MIN_MS)} мс: это правило владельца, меньше сервер не примет.
                К каждой паузе добавляется случайная надбавка от 0 до 20 %.
              </p>
            </div>
            <div className="sys-pause-editor">
              <ConfigEditor item={item} />
            </div>
          </div>
        )}
        <Link to={`/system/dev/config#config-${KEY}`} className="link sys-pause-all">Все параметры</Link>
      </div>
    </section>
  );
}
