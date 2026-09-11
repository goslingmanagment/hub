import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { ArrowUpRight, ChevronDown, RefreshCw, Search, SlidersHorizontal } from "lucide-react";
import { useAdminConfig } from "@/api/adminConfig";
import { HUB_FEATURES, featureSettingsHref, type FeatureAdvice } from "./featureCatalog.js";
import { featureState } from "./featuresView.js";
import "./features.css";

const adviceCopy: Record<FeatureAdvice, { label: string; short: string }> = {
  keep: { label: "Оставить", short: "Основа работы" },
  optional: { label: "По потребности", short: "Проверить пользу" },
  diagnostic: { label: "На время проверки", short: "Завершить проверку" },
  off: { label: "Держать выключенным", short: "Убрать лишнее" },
};
const filters = [
  { id: "review", label: "С чего начать" },
  { id: "all", label: "Все возможности" },
  { id: "keep", label: "Что оставить" },
] as const;

export function FeaturesTab() {
  const query = useAdminConfig();
  const [params, setParams] = useSearchParams();
  const search = params.get("q") ?? "";
  const filter = filters.some((item) => item.id === params.get("view")) ? params.get("view")! : "review";
  const expanded = params.get("feature");
  const rows = useMemo(() => query.data ? HUB_FEATURES.map((feature) => ({ feature, state: featureState(feature, query.data!) })) : [], [query.data]);
  const needsDecision = rows.filter(({ feature, state }) => feature.advice !== "keep" && state.kind !== "off" && state.kind !== "unavailable");
  const visible = rows.filter(({ feature, state }) => {
    const matches = `${feature.title} ${feature.summary} ${feature.group}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
    return matches && (search || filter === "all" || (filter === "keep" ? feature.advice === "keep" : feature.advice !== "keep" && state.kind !== "off" && state.kind !== "unavailable"));
  });
  function change(values: Record<string, string | null>, replace = false) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) value ? next.set(key, value) : next.delete(key);
    setParams(next, { replace });
  }
  if (!query.data) return <div className="feature-empty" role={query.isError ? "alert" : "status"}>
    <p>{query.isLoading ? "Загружаем возможности Hub…" : "Не удалось получить настройки Hub."}</p>
    {query.isError && <button className="settings-button" type="button" onClick={() => void query.refetch()}>Повторить</button>}
  </div>;

  const observedAt = new Date(query.data.generatedAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });
  return <div className="features-workspace">
    <div className="feature-intro">
      <div>
        <h3>Что оставить в Hub</h3>
        <p>Начните с дополнений. У каждой возможности — польза, последствия отключения и её настройки.</p>
      </div>
      <Link className="settings-button" to="/settings?tab=configuration"><SlidersHorizontal size={16} aria-hidden="true" />Все параметры</Link>
    </div>

    {query.isError && <div className="feature-alert" role="alert">Обновление не удалось. Показан сохранённый срез от {observedAt} МСК; текущее состояние может отличаться.</div>}

    <p className="feature-basis">Рекомендации по назначению и связям функций; бизнес-эффект ещё не измерен. «Включено» означает разрешение в настройках.</p>

    <div className="feature-toolbar">
      <div className="feature-filters" role="group" aria-label="Показать возможности">
        {filters.map((entry) => <button key={entry.id} type="button" aria-pressed={filter === entry.id && !search} onClick={() => change({ view: entry.id, q: null, feature: null })}>{entry.label}<span className="ml-2 tabular-nums opacity-65">{entry.id === "review" ? needsDecision.length : entry.id === "keep" ? rows.filter(({ feature }) => feature.advice === "keep").length : rows.length}</span></button>)}
      </div>
      <label className="feature-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label="Поиск возможностей" placeholder="Найти возможность" value={search} onChange={(event) => change({ q: event.target.value, feature: null }, true)} /></label>
    </div>

    <div className="feature-list">
      {visible.map(({ feature, state }) => {
        const isExpanded = expanded === feature.id;
        return <article className={`feature-row${isExpanded ? " feature-row-open" : ""}`} key={feature.id}>
          <button className="feature-summary" type="button" aria-expanded={isExpanded} aria-controls={`feature-detail-${feature.id}`} onClick={() => change({ feature: isExpanded ? null : feature.id })}>
            <span className="feature-name"><span className="feature-group">{feature.group}</span><strong>{feature.title}</strong><span>{feature.summary}</span></span>
            <span className="feature-decision"><span className={`feature-advice feature-advice-${feature.advice}`}>{adviceCopy[feature.advice].label}</span><span className={`feature-state feature-state-${state.kind}`}>{state.label}</span></span>
            <ChevronDown size={18} aria-hidden="true" className="feature-chevron" />
          </button>
          {isExpanded && <div id={`feature-detail-${feature.id}`} className="feature-detail">
            <div className="feature-reason"><h4>{adviceCopy[feature.advice].short}</h4><p>{feature.reason}</p></div>
            <div className="feature-detail-grid">
              <div><h4>Если отключить</h4><p>{feature.consequence}</p></div>
              <div><h4>Как принять решение</h4><p>{feature.check}</p></div>
            </div>
            <div className="feature-current"><strong>{state.label}</strong><span>{state.detail}</span></div>
            {feature.limitation && <p className="mb-4 text-sm">{feature.limitation}</p>}
            <div className="feature-actions">
              <Link className="settings-button settings-button-primary" to={featureSettingsHref(feature)}>Настроить<ArrowUpRight size={16} aria-hidden="true" /></Link>
              <Link className="feature-evidence-link" to={feature.evidenceHref}>{feature.evidenceLabel}<ArrowUpRight size={14} aria-hidden="true" /></Link>
            </div>
          </div>}
        </article>;
      })}
      {visible.length === 0 && <div className="feature-empty"><strong>{search ? "Ничего не найдено" : "В этом списке ничего нет"}</strong><p>{search ? "Попробуйте название функции или площадки." : "Остальные возможности доступны в полном списке."}</p><button type="button" className="settings-button" onClick={() => change({ view: "all", q: null, feature: null })}>Показать все</button></div>}
    </div>

    <div className="feature-footer"><span>Срез настроек: {observedAt} МСК · Выключено: {rows.filter(({ state }) => state.kind === "off").length}</span><button type="button" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={14} aria-hidden="true" className={query.isFetching ? "animate-spin" : ""} />{query.isFetching ? "Обновляем…" : "Обновить"}</button></div>
    <p className="feature-basis">Расписания и платные запросы OnlyFans дополнительно регулируются в разделе <Link to="/settings?tab=collection">«Сбор OnlyFans»</Link>. Настройки персон, команды и страниц остаются в своих разделах.</p>
  </div>;
}
