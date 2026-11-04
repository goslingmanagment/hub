import { useMemo } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { ChevronDown } from "lucide-react";
import { useAdminConfig } from "@/api/adminConfig";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { Disclosure } from "@/components/ui/Disclosure";
import { KeyValue } from "@/components/ui/KeyValue";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useScrollToAnchor } from "@/lib/useScrollToAnchor";
import { HUB_FEATURES, featureSettingsHref } from "../featureCatalog.js";
import { FEATURE_ADVICE_SHORT, featureState, featureStatus } from "../featuresView.js";
import { StaleNotice } from "../StaleNotice.js";
import { FeatureTuningTable } from "./FeatureTuningTable.js";

const ROLE_LABELS: Record<string, string> = { api: "Интерфейс", worker: "Обработка данных", scheduler: "Расписание", sync: "Сбор данных" };

/** The parts of Hub that did not report lately: their values cannot be confirmed. */
export function OfflineRolesNotice({ roles }: { roles: readonly { role: string; status: string }[] }) {
  const offline = roles.filter((role) => role.status !== "active");
  if (offline.length === 0) return null;
  return (
    <Notice tone="warning" role="status">
      {offline.map((role) => `${ROLE_LABELS[role.role] ?? role.role}: недоступна`).join(", ")}. Часть Hub давно не выходила на связь, её значения пока нельзя подтвердить.
    </Notice>
  );
}

function FeaturesSkeleton() {
  return (
    <div className="card" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="settings-feature-row"><span className="space-y-2"><Skeleton width={200} /><Skeleton width={320} /></span><Skeleton width={90} /></div>
      ))}
    </div>
  );
}

/**
 * «Функции ИИ»: what of the AI is on, and the model, effort and window of every
 * feature. Ten rows seen at once; a row opens what switching it off would do and
 * leads to its parameters (design/screens/settings.md §4). Reads only, except the table's windows.
 */
export function AiFeaturesPage() {
  const query = useAdminConfig();
  const [params, setParams] = useSearchParams();
  const { hash } = useLocation();
  const expanded = params.get("feature");
  const rows = useMemo(() => (query.data ? HUB_FEATURES.map((feature) => ({ feature, state: featureState(feature, query.data!) })) : []), [query.data]);
  useScrollToAnchor("tuning", hash === "#tuning" && query.data !== undefined);

  function toggle(id: string) {
    const next = new URLSearchParams(params);
    if (expanded === id) next.delete("feature");
    else next.set("feature", id);
    setParams(next, { replace: true });
  }

  const header = (
    <PageHeader
      fresh={query.data ? { at: query.data.generatedAt, onRefresh: () => void query.refetch(), refreshing: query.isFetching } : undefined}
    />
  );

  if (!query.data) {
    return (
      <>
        {header}
        {query.isLoading ? <FeaturesSkeleton /> : (
          <StatusPanel
            tone="error"
            title="Hub не ответил"
            description="Настройки не пришли. Это не значит, что всё выключено."
            action={<button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>Повторить</button>}
          />
        )}
      </>
    );
  }

  const offCount = rows.filter(({ state }) => state.kind === "off").length;

  return (
    <>
      {header}
      <div className="stack">
        {(query.isError || query.data.roleStatuses.some((role) => role.status !== "active")) && (
          <div className="settings-notices">
            {query.isError && <StaleNotice at={query.data.generatedAt} retry={() => query.refetch()} />}
            <OfflineRolesNotice roles={query.data.roleStatuses} />
          </div>
        )}

        <section className="card" aria-labelledby="features-title">
          <div className="card-header">
            <h2 id="features-title" className="card-title">Что включено</h2>
            <span className="card-description tabular-nums">Выключено: {offCount} из {rows.length}</span>
          </div>
          <div className="settings-feature-list">
            {rows.map(({ feature, state }) => {
              const isOpen = expanded === feature.id;
              const status = featureStatus(feature, state);
              return (
                <article key={feature.id} className={`settings-feature ${isOpen ? "is-open" : ""}`}>
                  <button
                    type="button"
                    className="settings-feature-row"
                    aria-expanded={isOpen}
                    aria-controls={`feature-detail-${feature.id}`}
                    onClick={() => toggle(feature.id)}
                  >
                    <span className="settings-feature-text">
                      <span className="settings-feature-title">{feature.title}</span>
                      <span className="settings-second">{feature.summary}</span>
                    </span>
                    <span className="settings-feature-state">
                      <StatusBadge status={status.word} />
                      {status.note && <span className="settings-second">{status.note}</span>}
                    </span>
                    <ChevronDown size={18} aria-hidden="true" className="settings-feature-chevron" />
                  </button>
                  {isOpen && (
                    <div id={`feature-detail-${feature.id}`} className="settings-feature-detail">
                      <KeyValue rows={[
                        { label: "Если отключить", value: feature.consequence },
                        { label: "Совет", value: <><b className="font-medium">{FEATURE_ADVICE_SHORT[feature.advice]}.</b> {feature.reason}</> },
                        { label: "Как проверить пользу", value: <>{feature.check}{feature.limitation && <span className="settings-second mt-1">{feature.limitation}</span>}</> },
                        { label: "Сейчас", value: `${state.label}: ${state.detail}` },
                      ]} />
                      <div className="settings-feature-links">
                        <Link className="btn btn-sm" to={featureSettingsHref(feature)}>Настроить</Link>
                        <Link className="link" to={feature.evidenceHref}>{feature.evidenceLabel}</Link>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        <FeatureTuningTable data={query.data} stale={query.isError} />

        <div className="settings-bottom">
          <Disclosure>
            <p>Функция без своего значения берёт значение программы: сейчас Opus 5.5 и низкое усилие. Fix, Hi и Voice берут модель и усилие у Reply, если у них нет своих. Короткий Recap всегда думает меньше всего.</p>
            <p>Окно: сколько последних сообщений читает функция, сколько бы ни попросило расширение.</p>
            <p>Потолок в день: предел трат функции по всем сотрудникам за сутки по UTC, с 03:00 по Москве.</p>
            <p>Включено значит разрешено настройками, а не то, что функцией пользуются. Советы написаны по назначению функций, польза в деньгах не измерена.</p>
          </Disclosure>
          <Link className="link settings-bottom-link" to="/system/dev/config">Все параметры</Link>
        </div>
      </div>
    </>
  );
}
