import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Search, RefreshCw, X } from "lucide-react";
import { Link, useInRouterContext, useLocation } from "react-router";
import type { ConfigItem, ConfigViewResponse } from "@agency_hub_core/contracts";
import { useAdminConfig } from "@/api/adminConfig";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { formatDateTime } from "@/lib/format";
import { buildSettingsSectionRoute } from "@/lib/navigation";
import { CONFIG_COPY_RU, SUBSYSTEM_COPY_RU } from "@/pages/settings/configCopyRu";
import { findHubFeature, featureReturnHref, type HubFeature } from "./featureCatalog.js";
import { CONFIG_MODE_CHOICES, humanConfigValue } from "./configurationChoices.js";

import { ConfigEditor, BooleanConfigEditor, liveEditorKind } from "./ConfigurationEditors.js";
import { CONFIG_FILTERS, CONFIG_SUBSYSTEM_LABELS, configSubsystemOrder, matchesConfigFilter, matchesConfigSearch, runningDiffersFromDefault, type ConfigFilter } from "./configurationView.js";
export { booleanPatchBody, liveEditorKind, resolveBooleanToggle } from "./ConfigurationEditors.js";

function formatScalar(value: string | number | boolean | null): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "вкл." : "выкл.";
  return value === "" ? "Пустая строка" : String(value);
}

function formatSeen(iso: string): string {
  return formatDateTime(iso, { yearUnlessCurrent: true });
}

function settingTitle(item: ConfigItem): string {
  return CONFIG_COPY_RU[item.key]?.title ?? item.label;
}

const ROLE_LABELS: Record<string, string> = { api: "Интерфейс", worker: "Обработка данных", scheduler: "Расписание", sync: "Сбор данных" };

/** `tone` is a ui.css badge modifier ("badge-warning", …) or "" for neutral. */
function Badge({
  tone,
  title,
  children,
}: {
  tone: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span title={title} className={`badge ${tone}`}>
      {children}
    </span>
  );
}

const ROLE_STATUS_RU: Record<string, string> = {
  active: "активен",
  stale: "устарел",
  down: "недоступен",
  offline: "недоступен",
  missing: "нет данных",
};

// Sort within a subsystem so the actionable (editable) rows surface to the top, then
// plain read-only, then secrets — without losing subsystem grouping.
function rowRank(item: ConfigItem): number {
  if (item.editability === "editable" && item.runtimeApply !== "none") return 0;
  if (item.secret) return 2;
  return 1;
}

function RunningCell({ item, friendly = false }: { item: ConfigItem; friendly?: boolean }) {
  // Mode keys read as words everywhere; page lists only in a feature's view
  // (the full list keeps the raw CSV the expert editor writes).
  const human = friendly || Boolean(CONFIG_MODE_CHOICES[item.key]);
  if (item.running.length === 0) {
    return <span className="text-text-muted">Нет сигнала от процессов</span>;
  }

  if (item.secret || item.running[0]?.masked) {
    const stateTone = (state: string | null) =>
      state === "set" ? "badge-success" : state === "unknown" ? "badge-warning" : "";
    // When live processes disagree on set/unset, show each one — a key set in api
    // but unset in worker is an operationally important drift.
    if (item.drift || item.running.some((running) => running.state === "unknown")) {
      return (
        <div className="flex flex-col gap-0.5">
          {item.running.map((r) => (
            <span key={`${r.role}:${r.instanceId}`} className="text-xs">
              <span className="text-text-muted">{ROLE_LABELS[r.role] ?? r.role}:</span>{" "}
              <Badge tone={stateTone(r.state)}>{r.state === "set" ? "задан" : r.state === "unknown" ? "нет данных" : "не задан"}</Badge>
            </span>
          ))}
        </div>
      );
    }
    const state = item.running[0]?.state ?? "unset";
    return <Badge tone={stateTone(state)}>{state === "set" ? "задан" : state === "unknown" ? "нет данных" : "не задан"}</Badge>;
  }

  // An instance reporting under an older/mismatched snapshot shape shows as "unknown
  // (stale snapshot)" per row instead of a misleading value, and any unknown row forces
  // the per-instance breakdown so it can't hide behind a single trusted value.
  const hasUnknown = item.running.some((r) => r.state === "unknown");
  if (item.drift || hasUnknown) {
    return (
      <div className="flex flex-col gap-0.5">
        {item.running.map((r) => (
          <span key={`${r.role}:${r.instanceId}`} className="text-xs">
            <span className="text-text-muted">{ROLE_LABELS[r.role] ?? r.role}:</span>{" "}
            {r.state === "unknown" ? (
              <span className="text-warning-dark">Нет актуального значения</span>
            ) : (
              <span className="font-mono">{formatScalar(r.value)}</span>
            )}
          </span>
        ))}
      </div>
    );
  }

  const value = item.running[0]!.value;
  return human
    ? <span className="font-medium text-text-primary" title={formatScalar(value)}>{humanConfigValue(item.key, value)}</span>
    : <span className="font-mono text-text-primary">{formatScalar(value)}</span>;
}

function SettingLabel({ item }: { item: ConfigItem }) {
  const copy = CONFIG_COPY_RU[item.key];
  return (
    <>
      <div className="break-words text-sm font-semibold leading-6 text-text-primary">{settingTitle(item)}</div>
      {copy?.short && <p id={`config-description-${item.key}`} className="mt-1 text-[13px] leading-relaxed text-text-secondary">{copy.short}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 empty:hidden">
        {item.drift && (
          <Badge tone="badge-danger" title="Запущенные процессы сообщают разные значения">
            значения различаются
          </Badge>
        )}
        {item.costWarning && (
          <Badge tone="badge-warning" title={CONFIG_COPY_RU[item.key]?.warning ?? item.costWarning}>
            влияет на расходы
          </Badge>
        )}
        {item.destructive && (
          <Badge tone="badge-danger" title="Снижение или очистка безвозвратно удаляет данные">
            может удалить данные
          </Badge>
        )}
      </div>
      <details className="help mt-2">
        <summary aria-label={`Подробнее: ${settingTitle(item)}`}>Подробнее</summary>
        <div className="help-body">
          {copy?.long && <p>{copy.long}</p>}
          {item.costWarning && <p className="text-warning-dark">{copy?.warning ?? item.costWarning}</p>}
          <details className="help">
            <summary>Технические детали</summary>
            <div className="help-body text-xs">
              <p>{item.label}</p>
              {item.note && <p>{item.note}</p>}
              <div className="break-all font-mono">{item.envName}</div>
              {runningDiffersFromDefault(item) && <p>Исходное значение программы: <span className="font-mono">{item.default}</span>. Настройка сервера может отличаться.</p>}
            </div>
          </details>
        </div>
      </details>
    </>
  );
}

function SettingRow({ item, friendly = false }: { item: ConfigItem; friendly?: boolean }) {
  // Number/string live keys get the scalar editor; boolean live keys get the
  // on/off switch. Other kinds stay read-only — see liveEditorKind.
  const editorKind = liveEditorKind(item);

  return (
    <div
      id={`config-${item.key}`}
      tabIndex={-1}
      className="config-setting"
    >
      <div className="config-setting-main">
        <SettingLabel item={item} />
      </div>
      <div className="config-setting-control">
        <div className="config-setting-current">
          <span>Сейчас:</span><RunningCell item={item} friendly={friendly} />
          {CONFIG_COPY_RU[item.key]?.unit && <span>{CONFIG_COPY_RU[item.key]?.unit}</span>}
        </div>

        {editorKind === "number" && (
          <ConfigEditor item={item} friendly={friendly} />
        )}
        {editorKind === "string" && (
          <ConfigEditor item={item} friendly={friendly} />
        )}
        {editorKind === "boolean" && (
          <BooleanConfigEditor item={item} />
        )}
        {!editorKind && <p className="text-xs leading-relaxed text-text-muted">Меняется в настройках сервера.</p>}
        {editorKind && item.runtimeApply === "boot" && (
          <p className="text-xs leading-relaxed text-text-muted">
            {item.pendingApply ? "Сохранено. Начнёт работать после перезапуска Hub." : "Новое значение начинает работать после перезапуска Hub."}
          </p>
        )}
      </div>
    </div>
  );
}

function RestartPendingBanner({ data, onReveal }: { data: ConfigViewResponse; onReveal: (key: string) => void }) {
  const allItems = data.subsystems.flatMap((g) => g.items);
  const pendingRestart = allItems.filter(
    (it) => it.runtimeApply === "boot" && it.pendingApply,
  );
  const skipped = data.instances.flatMap((inst) =>
    inst.skippedOverrides.map((s) => ({ role: inst.role, key: s.key, reason: s.reason })),
  );

  if (pendingRestart.length === 0 && skipped.length === 0) return null;

  return (
    <div className="space-y-2">
      {pendingRestart.length > 0 && (
        <div className="notice notice-warning">
          <div className="min-w-0">
            <div className="font-medium">Сохранено — нужен перезапуск Hub: {pendingRestart.length}</div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
              {pendingRestart.map((item) => <a key={item.key} href={`#config-${item.key}`} onClick={() => onReveal(item.key)} className="underline underline-offset-2">{settingTitle(item)}</a>)}
            </div>
          </div>
        </div>
      )}
      {skipped.length > 0 && (
        <div className="notice notice-danger">
          <div className="min-w-0">
            <div className="font-semibold">Некоторые настройки не удалось применить при запуске:</div>
            <ul className="mt-1 list-disc pl-5">
              {skipped.map((s) => {
                const skippedItem = allItems.find((it) => it.key === s.key);
                return (
                  <li key={`${s.role}:${s.key}`}>
                    {skippedItem ? settingTitle(skippedItem) : s.key} · {ROLE_LABELS[s.role] ?? s.role}
                  </li>
                );
              })}
            </ul>
            <details className="help mt-2">
              <summary>Технические детали</summary>
              <ul className="help-body break-all font-mono text-xs">
                {skipped.map((s) => <li key={`${s.role}:${s.key}`}>{s.role}: {s.key} — {s.reason}</li>)}
              </ul>
            </details>
          </div>
        </div>
      )}
    </div>
  );
}

export function ConfigurationTab() {
  const routed = useInRouterContext();
  return routed ? <RoutedConfiguration /> : <ConfigurationView hash="" />;
}

function RoutedConfiguration() {
  const { hash, search, state } = useLocation();
  const params = new URLSearchParams(search);
  const feature = findHubFeature(params.get("feature")) ?? null;
  // Scope is a filter on this form. Remounting it would discard reviewed drafts
  // and the write receipts that its editors retain until a successful readback.
  return (
    <ConfigurationView
      hash={hash}
      feature={feature}
      navigationState={state}
      allSettingsHref={buildSettingsSectionRoute(params, "configuration")}
      {...(feature ? { featureBackTo: featureReturnHref(feature, params) } : {})}
    />
  );
}

function ConfigurationView({ hash, feature = null, featureBackTo, allSettingsHref, navigationState }: {
  hash: string;
  feature?: HubFeature | null;
  featureBackTo?: string;
  allSettingsHref?: string;
  navigationState?: unknown;
}) {
  const { data, isLoading, isError, isFetching, refetch } = useAdminConfig();
  const searchRef = useRef<HTMLInputElement>(null);
  const featureBackRef = useRef<HTMLAnchorElement>(null);
  const [query, setQuery] = useState("");
  const [subsystem, setSubsystem] = useState("");
  // The full list opens on every setting; "Без перезапуска" is one filter among others.
  const [filter, setFilter] = useState<ConfigFilter>("all");
  const [scopeExpanded, setScopeExpanded] = useState(false);
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);
  const groups = useMemo(() => [...(data?.subsystems ?? [])].sort((a, b) => configSubsystemOrder(a.subsystem) - configSubsystemOrder(b.subsystem)), [data]);
  const allItems = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const searchMatches = useMemo(() => allItems.filter((item) =>
    (!feature || scopeExpanded || feature.keys.includes(item.key))
    && (!subsystem || item.subsystem === subsystem) && matchesConfigSearch(item, query)), [allItems, query, subsystem, feature, scopeExpanded]);
  const visibleKeys = useMemo(() => new Set(searchMatches.filter((item) => matchesConfigFilter(item, filter)).map((item) => item.key)), [searchMatches, filter]);

  function resetFilters() { setQuery(""); setSubsystem(""); setFilter("all"); setScopeExpanded(false); }
  function reveal(key: string) {
    setQuery(""); setSubsystem(""); setFilter("all"); setPendingAnchor(key);
    if (feature && !feature.keys.includes(key)) setScopeExpanded(true);
  }

  useEffect(() => {
    setQuery(""); setSubsystem(""); setFilter("all");
    setScopeExpanded(false); setPendingAnchor(null);
  }, [feature]);

  useEffect(() => {
    if (!hash.startsWith("#config-")) return;
    setQuery(""); setSubsystem(""); setFilter("all");
    setPendingAnchor(hash.slice("#config-".length));
    if (feature && !feature.keys.includes(hash.slice("#config-".length))) setScopeExpanded(true);
  }, [hash, feature]);

  useEffect(() => {
    if (!pendingAnchor || !visibleKeys.has(pendingAnchor)) return;
    const element = document.getElementById(`config-${pendingAnchor}`);
    if (!element) return;
    element.scrollIntoView({ block: "center" });
    element.focus({ preventScroll: true });
    setPendingAnchor(null);
  }, [pendingAnchor, visibleKeys]);

  if (!data) {
    return <div role={isError ? "alert" : "status"} className="card empty">
      <p className="empty-title">{isLoading ? "Загружаем настройки…" : "Не удалось загрузить настройки."}</p>
      {isError && <div className="empty-actions"><button type="button" onClick={() => void refetch()} className="btn">Повторить</button></div>}
    </div>;
  }

  const filterCounts = Object.fromEntries(CONFIG_FILTERS.map((entry) => [entry.key, searchMatches.filter((item) => matchesConfigFilter(item, entry.key)).length]));
  const offline = data.roleStatuses.filter((role) => role.status !== "active");

  return (
    <div className="config-screen space-y-5">
      {feature && (
        <div className="card card-body">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <Link
              ref={featureBackRef}
              className="link"
              to={featureBackTo ?? `/settings?tab=features&view=all&feature=${feature.id}`}
            >
              ← К возможностям
            </Link>
            <Link
              className="link"
              to={allSettingsHref ?? "/settings?tab=configuration"}
              state={navigationState}
            >
              Все настройки
            </Link>
          </div>
          <h3 className="section-title mt-3">{feature.title}</h3>
          <p className="mt-1 max-w-3xl text-sm text-text-secondary">
            <strong className="font-medium text-text-primary">Если отключить:</strong> {feature.consequence}
          </p>
          <p className="mt-2 text-[13px] text-text-muted">
            {scopeExpanded
              ? "Показаны также связанные настройки, необходимые для проверки зависимостей."
              : "Здесь собраны только настройки этой возможности. Сохраняйте изменения по одному."}
          </p>
        </div>
      )}
      {isError && (
        <div role="alert" className="notice notice-danger flex-wrap items-center justify-between">
          <span>Не удалось обновить настройки. Показаны значения на {formatSeen(data.generatedAt)}.</span>
          <button type="button" className="btn btn-sm" disabled={isFetching} onClick={() => void refetch()}>Повторить</button>
        </div>
      )}

      {offline.length > 0 && (
        <div role="status" className="notice notice-warning">
          {offline.map((role) => `${ROLE_LABELS[role.role] ?? role.role}: ${ROLE_STATUS_RU[role.status] ?? role.status}`).join(" · ")}
          {". Часть Hub давно не выходила на связь, её значения пока нельзя подтвердить."}
        </div>
      )}
      <div className="space-y-3" hidden={feature !== null && !scopeExpanded}>
        <div className="flex flex-wrap items-center gap-3">
          <label className="relative min-w-0 flex-1 basis-64">
            <span className="sr-only">Поиск настроек</span>
            <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                if (event.target.value) setFilter("all");
              }}
              placeholder={subsystem ? "Поиск в выбранном разделе" : "Найти настройку…"}
              className="input pl-9"
            />
          </label>
          <label className="w-full sm:w-56">
            <span className="sr-only">Раздел</span>
            <select value={subsystem} onChange={(event) => setSubsystem(event.target.value)} className="select">
              <option value="">Все разделы</option>
              {groups.map((group) => <option key={group.subsystem} value={group.subsystem}>{CONFIG_SUBSYSTEM_LABELS[group.subsystem] ?? group.subsystem}</option>)}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <FilterButtons
            filters={CONFIG_FILTERS.map((entry) => ({ key: entry.key, label: entry.label, count: filterCounts[entry.key] }))}
            active={filter}
            onChange={(key) => setFilter(key as ConfigFilter)}
          />
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-text-secondary">
            <span className="shrink-0" role="status" aria-live="polite">Показано {visibleKeys.size} из {allItems.length}</span>
            {(query || subsystem || filter !== "all") && <button type="button" onClick={resetFilters} className="btn btn-ghost btn-sm"><X size={14} aria-hidden="true" />Сбросить фильтры</button>}
            <button type="button" onClick={() => void refetch()} disabled={isFetching} className="btn btn-ghost btn-sm">
              <RefreshCw size={14} className={isFetching ? "animate-spin" : ""} aria-hidden="true" />
              {isFetching ? "Обновляем…" : "Обновить"}
            </button>
          </div>
        </div>
        {!query && filter === "live" && <p className="text-[13px] text-text-muted">Изменения в этом списке начнут работать без перезапуска — обычно в течение минуты.</p>}
      </div>

      <RestartPendingBanner data={data} onReveal={reveal} />

      {visibleKeys.size === 0 && (
        <div className="card empty">
          <p className="empty-title">{query ? "По этому запросу ничего не нашлось" : filter === "attention" ? "Всё в порядке" : "Здесь пока нет таких настроек"}</p>
          <p className="empty-text">{query ? "Попробуйте более короткое название или ключ настройки." : filter === "attention" ? "Среди выбранных настроек нет ожидающих применения или требующих проверки." : filter === "live" ? "Посмотрите настройки, для которых нужен перезапуск или доступ к серверу." : "Выберите другой раздел или откройте полный список."}</p>
          <div className="empty-actions empty:hidden">
            {query && subsystem ? <button type="button" onClick={() => { setSubsystem(""); setFilter("all"); }} className="btn btn-sm">Искать во всех разделах</button>
              : filter !== "all" && <button type="button" onClick={() => setFilter("all")} className="btn btn-sm">Показать все настройки</button>}
          </div>
        </div>
      )}

      {/* Hide rather than unmount: searching and filtering must not discard a draft. */}
      <div className="space-y-5">
        {groups.map((group) => (
          <section className="card overflow-clip" key={group.subsystem} hidden={!group.items.some((item) => visibleKeys.has(item.key))}>
            <div className="card-header bg-hover-alt">
              <div className="min-w-0">
                <h3 className="card-title">
                  {CONFIG_SUBSYSTEM_LABELS[group.subsystem] ?? group.subsystem}
                  <span className="ml-2 text-xs font-normal tabular-nums text-text-muted">
                    {group.items.filter((item) => visibleKeys.has(item.key)).length}
                  </span>
                </h3>
                {SUBSYSTEM_COPY_RU[group.subsystem] && <p className="card-description">{SUBSYSTEM_COPY_RU[group.subsystem]}</p>}
              </div>
            </div>
            <div className="config-group-items">
              {[...group.items]
                .sort((a, b) => feature && !scopeExpanded
                  ? (feature.keys.indexOf(a.key) < 0 ? 1000 : feature.keys.indexOf(a.key)) - (feature.keys.indexOf(b.key) < 0 ? 1000 : feature.keys.indexOf(b.key))
                  : rowRank(a) - rowRank(b))
                .map((item) => (
                  <div key={item.key} hidden={!visibleKeys.has(item.key)}>
                    <SettingRow item={item} friendly={feature !== null && feature.keys.includes(item.key)} />
                  </div>
                ))}
            </div>
          </section>
        ))}
      </div>
      <details className="help">
        <summary>
          Связь с сервером · {data.roleStatuses.length > 0 && data.roleStatuses.every((role) => role.status === "active") ? "все части Hub на связи" : "требует проверки"}
        </summary>
        <div className="help-body">
          {data.instances.length === 0 && <p>Процессы ещё не сообщили свои значения.</p>}
          {data.instances.length > 0 && (
            <ul className="space-y-1">
              {data.instances.map((instance) => (
                <li key={`${instance.role}:${instance.instanceId}`}>
                  <span className="font-medium text-text-primary">{ROLE_LABELS[instance.role] ?? instance.role}</span> · {ROLE_STATUS_RU[instance.status] ?? instance.status} · сигнал {formatSeen(instance.lastSeenAt)}
                </li>
              ))}
            </ul>
          )}
          {data.instances.length > 0 && (
            <details className="help">
              <summary>Технические детали</summary>
              <ul className="help-body break-all font-mono text-xs">
                {data.instances.map((instance) => (
                  <li key={`${instance.role}:${instance.instanceId}`}>{instance.role} · {instance.instanceId}{instance.imageTag ? ` · ${instance.imageTag}` : ""}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </details>
    </div>
  );
}
