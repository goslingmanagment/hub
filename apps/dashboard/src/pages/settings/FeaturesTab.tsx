import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { ArrowUpRight, ChevronDown, RefreshCw, Search, SlidersHorizontal } from "lucide-react";
import { useAdminConfig } from "@/api/adminConfig";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { formatDateTime } from "@/lib/format";
import { HUB_FEATURES, featureSettingsHref, type FeatureAdvice } from "./featureCatalog.js";
import { featureState, featureStatus, type FeatureStatusTone } from "./featuresView.js";

/** The short form of the catalog's advice; it leads the expanded explanation. */
const adviceShort: Record<FeatureAdvice, string> = {
  keep: "Основа работы",
  optional: "Проверить пользу",
  diagnostic: "Завершить проверку",
  off: "Убрать лишнее",
};
const toneClass: Record<FeatureStatusTone, string> = {
  success: "badge badge-success",
  warning: "badge badge-warning",
  info: "badge badge-info",
  neutral: "badge",
};
const filters = [
  { id: "review", label: "С чего начать" },
  { id: "all", label: "Все возможности" },
  { id: "keep", label: "Что оставить" },
  { id: "attention", label: "Нужно проверить" },
] as const;

export function FeaturesTab() {
  const query = useAdminConfig();
  const [params, setParams] = useSearchParams();
  const search = params.get("q") ?? "";
  const filter = filters.some((item) => item.id === params.get("view")) ? params.get("view")! : "review";
  const expanded = params.get("feature");
  const rows = useMemo(() => query.data ? HUB_FEATURES.map((feature) => ({ feature, state: featureState(feature, query.data!) })) : [], [query.data]);
  const needsDecision = rows.filter(({ feature, state }) => feature.advice !== "keep" && state.kind !== "off" && state.kind !== "unavailable");
  const needsAttention = rows.filter(({ state }) => state.kind === "pending" || state.kind === "unknown");
  const visible = rows.filter(({ feature, state }) => {
    const matches = `${feature.title} ${feature.summary} ${feature.group} ${feature.reason} ${feature.check} ${feature.limitation ?? ""} ${feature.keys.join(" ")}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
    return matches && (search.trim() || filter === "all" || (filter === "attention" ? state.kind === "pending" || state.kind === "unknown" : filter === "keep" ? feature.advice === "keep" : feature.advice !== "keep" && state.kind !== "off" && state.kind !== "unavailable"));
  });
  function change(values: Record<string, string | null>, replace = false) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next, { replace });
  }
  if (!query.data) return <div className="card empty" role={query.isError ? "alert" : "status"}>
    <p className="empty-title">{query.isLoading ? "Загружаем возможности Hub…" : "Не удалось получить настройки Hub."}</p>
    {query.isError && <div className="empty-actions"><button className="btn" type="button" onClick={() => void query.refetch()}>Повторить</button></div>}
  </div>;

  const observedAt = formatDateTime(query.data.generatedAt, { yearUnlessCurrent: true });
  const counts: Record<(typeof filters)[number]["id"], number> = {
    review: needsDecision.length,
    all: rows.length,
    keep: rows.filter(({ feature }) => feature.advice === "keep").length,
    attention: needsAttention.length,
  };
  return <div className="space-y-4">
    {query.isError && <div className="notice notice-warning" role="alert">Обновление не удалось. Показан сохранённый срез от {observedAt}; текущее состояние может отличаться.</div>}

    <div className="flex flex-wrap items-center gap-3">
      <FilterButtons
        filters={filters
          .filter((entry) => entry.id !== "attention" || needsAttention.length > 0 || filter === "attention")
          .map((entry) => ({ key: entry.id, label: entry.label, count: counts[entry.id] }))}
        active={search.trim() ? "" : filter}
        onChange={(key) => change({ view: key, q: null, feature: null })}
      />
      <label className="relative w-full min-w-0 sm:ml-auto sm:w-64">
        <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
        <input type="search" aria-label="Поиск возможностей" placeholder="Найти возможность" className="input pl-9" value={search} onChange={(event) => change({ q: event.target.value, feature: null }, true)} />
      </label>
    </div>

    <div className="card overflow-hidden">
      {visible.map(({ feature, state }) => {
        const isExpanded = expanded === feature.id;
        const status = featureStatus(feature, state);
        return <article className="border-t border-border-light first:border-t-0" key={feature.id}>
          <button className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-5 py-4 text-left hover:bg-hover-alt sm:grid-cols-[minmax(0,1fr)_220px_auto] ${isExpanded ? "bg-hover-alt" : ""}`} type="button" aria-expanded={isExpanded} aria-controls={`feature-detail-${feature.id}`} onClick={() => change({ feature: isExpanded ? null : feature.id })}>
            <span className="min-w-0">
              <span className="block font-medium text-text-primary">{feature.title}</span>
              <span className="mt-0.5 block text-[13px] text-text-secondary">{feature.summary}</span>
            </span>
            <span className="col-start-1 row-start-2 flex flex-wrap items-center gap-x-2 gap-y-1 sm:col-start-2 sm:row-start-1 sm:flex-col sm:items-start">
              <span className={toneClass[status.tone]}>{status.label}</span>
              <span className="text-xs text-text-muted">{status.note}</span>
            </span>
            <ChevronDown size={18} aria-hidden="true" className={`col-start-2 row-span-2 row-start-1 text-text-muted transition-transform sm:col-start-3 sm:row-span-1 ${isExpanded ? "rotate-180" : ""}`} />
          </button>
          {isExpanded && <div id={`feature-detail-${feature.id}`} className="space-y-4 bg-hover-alt px-5 pb-5 pt-1 text-sm">
            <p className="max-w-3xl text-text-secondary"><strong className="font-semibold text-text-primary">{adviceShort[feature.advice]}.</strong> {feature.reason}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="field-label">Если отключить</p>
                <p className="text-text-secondary">{feature.consequence}</p>
              </div>
              <div>
                <p className="field-label">Как решить</p>
                <p className="text-text-secondary">{feature.check}</p>
                {feature.limitation && <p className="field-hint">{feature.limitation}</p>}
              </div>
            </div>
            <p className="text-[13px] text-text-secondary">Сейчас: <strong className="font-medium text-text-primary">{state.label}</strong> — {state.detail}</p>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <Link className="btn btn-primary btn-sm" to={featureSettingsHref(feature, params)}>Настроить<ArrowUpRight size={15} aria-hidden="true" /></Link>
              <Link className="link inline-flex items-center gap-1 text-sm" to={feature.evidenceHref}>{feature.evidenceLabel}<ArrowUpRight size={14} aria-hidden="true" /></Link>
            </div>
          </div>}
        </article>;
      })}
      {visible.length === 0 && <div className="empty">
        <p className="empty-title">{search ? "Ничего не найдено" : "В этом списке ничего нет"}</p>
        <p className="empty-text">{search ? "Попробуйте название функции или площадки." : "Остальные возможности доступны в полном списке."}</p>
        <div className="empty-actions"><button type="button" className="btn btn-sm" onClick={() => change({ view: "all", q: null, feature: null })}>Показать все</button></div>
      </div>}
    </div>

    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
      <span>Настройки на {observedAt} · выключено: {rows.filter(({ state }) => state.kind === "off").length}</span>
      <div className="flex flex-wrap items-center gap-1">
        <button type="button" className="btn btn-ghost btn-sm" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={14} aria-hidden="true" className={query.isFetching ? "animate-spin" : ""} />{query.isFetching ? "Обновляем…" : "Обновить"}</button>
        <Link className="btn btn-ghost btn-sm" to="/settings?tab=configuration"><SlidersHorizontal size={14} aria-hidden="true" />Все параметры</Link>
      </div>
    </div>

    <details className="help">
      <summary>Как это работает</summary>
      <div className="help-body">
        <p>Рекомендации по назначению и связям функций; бизнес-эффект ещё не измерен. «Включено» означает разрешение в настройках, а не то, что функция используется.</p>
        <p>У каждой строки один статус: текущее состояние или, если оно расходится с рекомендацией, что стоит сделать. Под ним — рекомендация или текущее состояние.</p>
        <p>Расписания и платные запросы OnlyFans дополнительно регулируются в разделе <Link className="link" to="/settings?tab=collection">«Сбор OnlyFans»</Link>. Настройки персон, команды и страниц остаются в своих разделах.</p>
      </div>
    </details>
  </div>;
}
