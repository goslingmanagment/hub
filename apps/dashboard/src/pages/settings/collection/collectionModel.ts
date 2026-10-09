import type {
  OfapiCollectionAuditRow,
  OfapiCollectionCatalogEntry,
  OfapiCollectionCategory,
  OfapiCollectionChangeBody,
  OfapiCollectionJob,
  OfapiCollectionJobBody,
  OfapiCollectionMode,
  OfapiCollectionPolicy,
  OfapiCollectionPolicySource,
  OfapiCollectionRun,
  OfapiCollectionSettings,
  OfapiCollectionSnapshot,
} from "@/api/adminOfapiCollection";
import { ruPlural } from "@/lib/plural";
import { categoryLabel, modeLabel } from "./collectionCopyRu.js";

// Type-only dependency on the api module: the root tests mock that module's
// hooks wholesale, so nothing here may need a runtime value from it.
export const OFAPI_COLLECTION_MODES: readonly OfapiCollectionMode[] = ["off", "on_demand", "scheduled"];

// Pure decision helpers for the Collection screen. Everything here is
// exported so the root tests (static render only, no DOM events) can exercise
// draft / conflict / grouping / state logic directly.

// ---------------------------------------------------------------------------
// Scope

export type CollectionScope = { kind: "all" } | { kind: "page"; pageId: number };

export function scopePageId(scope: CollectionScope): number | null {
  return scope.kind === "page" ? scope.pageId : null;
}

export function scopeEquals(a: CollectionScope, b: CollectionScope) {
  return a.kind === b.kind && scopePageId(a) === scopePageId(b);
}

// ---------------------------------------------------------------------------
// Draft

export interface DraftEntry {
  /** The full settings object the apply body will carry. */
  settings: OfapiCollectionSettings;
  /** Effective value when the draft entry was created (null when the pages in
   *  scope disagreed, so there was no single "was"). Used by the conflict
   *  compare view to tell "changed elsewhere" from "unchanged". */
  base: OfapiCollectionSettings | null;
}

export interface CollectionDraft {
  /** Snapshot revision the draft was built against — becomes expectedRevision. */
  revision: number;
  scope: CollectionScope;
  entries: Record<string, DraftEntry>;
}

export const DRAFT_STORAGE_KEY = "hub.ofapiCollection.draft.v1";

export function draftKey(pageId: number | null, category: string) {
  return `${pageId ?? "default"}:${category}`;
}

export function emptyDraft(revision: number, scope: CollectionScope): CollectionDraft {
  return { revision, scope, entries: {} };
}

export function draftSize(draft: CollectionDraft | null) {
  return draft ? Object.keys(draft.entries).length : 0;
}

export function draftEntries(draft: CollectionDraft | null): DraftEntry[] {
  return draft ? Object.keys(draft.entries).sort().map((key) => draft.entries[key]!) : [];
}

/** The server accepts at most ONE enabled (mode ≠ off) category per apply
 *  (`enable_one_category_at_a_time`) — the staged-rollout rule from the plan.
 *  Any number of "off" changes may travel together. */
export function draftBlockReason(draft: CollectionDraft | null): string | null {
  const enabled = draftEntries(draft).filter((entry) => entry.settings.mode !== "off");
  if (enabled.length > 1) {
    const names = enabled.map((entry) => categoryLabel(entry.settings.category)).join(", ");
    return `Сервер принимает только одну включённую категорию за одно применение (сейчас в черновике: ${names}). Оставьте одну и примените остальные следующим шагом.`;
  }
  return null;
}

export function buildChangeBody(
  draft: CollectionDraft,
  backgroundPaused?: boolean,
): OfapiCollectionChangeBody {
  return {
    expectedRevision: draft.revision,
    changes: draftEntries(draft).map((entry) => entry.settings),
    ...(backgroundPaused === undefined ? {} : { backgroundPaused }),
  };
}

export function serializeDraft(draft: CollectionDraft) {
  return JSON.stringify(draft);
}

function isMode(value: unknown): value is OfapiCollectionMode {
  return typeof value === "string" && (OFAPI_COLLECTION_MODES as readonly string[]).includes(value);
}

function isSettings(value: unknown): value is OfapiCollectionSettings {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (record.pageId === null || typeof record.pageId === "number")
    && typeof record.category === "string"
    && isMode(record.mode)
    && typeof record.intervalMinutes === "number"
    && typeof record.dailyCreditLimit === "number"
    && typeof record.maxCallsPerRun === "number"
    && typeof record.includeDetails === "boolean";
}

/** Restores a draft persisted in sessionStorage; anything malformed is
 *  dropped rather than trusted (a stale key from an older build must never
 *  produce a half-valid apply body). */
export function restoreDraft(raw: string | null | undefined): CollectionDraft | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.revision !== "number") return null;
  const scope = record.scope as Record<string, unknown> | undefined;
  if (!scope || (scope.kind !== "all" && scope.kind !== "page")) return null;
  if (scope.kind === "page" && typeof scope.pageId !== "number") return null;
  if (typeof record.entries !== "object" || record.entries === null) return null;
  const entries: Record<string, DraftEntry> = {};
  for (const [key, value] of Object.entries(record.entries as Record<string, unknown>)) {
    const entry = value as Record<string, unknown> | null;
    if (!entry || !isSettings(entry.settings)) return null;
    if (entry.base !== null && !isSettings(entry.base)) return null;
    entries[key] = { settings: entry.settings, base: entry.base };
  }
  return {
    revision: record.revision,
    scope: scope.kind === "all" ? { kind: "all" } : { kind: "page", pageId: scope.pageId as number },
    entries,
  };
}

export function sameSettings(a: OfapiCollectionSettings, b: OfapiCollectionSettings) {
  return a.mode === b.mode
    && a.intervalMinutes === b.intervalMinutes
    && a.dailyCreditLimit === b.dailyCreditLimit
    && a.maxCallsPerRun === b.maxCallsPerRun
    && a.includeDetails === b.includeDetails;
}

// ---------------------------------------------------------------------------
// Category views (registry + effective policies for the selected scope)

export type CategoryGroup = "running" | "available" | "one_off" | "unavailable";

export interface UsageTotals {
  callsToday: number;
  reservedCreditsToday: number;
  /** null when no policy in scope has a confirmed actual figure yet. */
  actualCreditsToday: number | null;
  credits30d: number;
  inFlight: number;
}

export interface CategoryView {
  entry: OfapiCollectionCatalogEntry;
  policies: OfapiCollectionPolicy[];
  /** Every page in scope resolves to the same settings. */
  uniform: boolean;
  /** Shared settings (pageId = scope page or null) when uniform, else null. */
  settings: OfapiCollectionSettings | null;
  mode: OfapiCollectionMode | "mixed";
  sources: OfapiCollectionPolicySource[];
  /** Pages carrying their own override — relevant when the scope is "all",
   *  because a default-scope change will NOT displace them. */
  overridePageIds: number[];
  usage: UsageTotals;
  lastCapturedAt: string | null;
  /** Any mode other than off is offered by the registry. */
  supportsToggle: boolean;
  group: CategoryGroup;
}

export function policiesInScope(snapshot: OfapiCollectionSnapshot, scope: CollectionScope) {
  return scope.kind === "all"
    ? snapshot.policies
    : snapshot.policies.filter((policy) => policy.pageId === scope.pageId);
}

export function usageTotals(policies: Array<Pick<OfapiCollectionPolicy, "usage" | "inFlight">>): UsageTotals {
  let actual: number | null = null;
  for (const policy of policies) {
    if (policy.usage.actualCreditsToday !== null) {
      actual = (actual ?? 0) + policy.usage.actualCreditsToday;
    }
  }
  return {
    callsToday: policies.reduce((sum, policy) => sum + policy.usage.callsToday, 0),
    reservedCreditsToday: policies.reduce((sum, policy) => sum + policy.usage.reservedCreditsToday, 0),
    actualCreditsToday: actual,
    credits30d: policies.reduce((sum, policy) => sum + policy.usage.credits30d, 0),
    inFlight: policies.reduce((sum, policy) => sum + policy.inFlight, 0),
  };
}

function categoryGroup(entry: OfapiCollectionCatalogEntry, mode: OfapiCollectionMode | "mixed"): CategoryGroup {
  const toggleable = entry.modes.some((candidate) => candidate !== "off");
  if (!toggleable) {
    return entry.supportsOneOff ? "one_off" : "unavailable";
  }
  return mode === "off" ? "available" : "running";
}

export function buildCategoryView(
  snapshot: OfapiCollectionSnapshot,
  scope: CollectionScope,
  entry: OfapiCollectionCatalogEntry,
): CategoryView {
  const policies = policiesInScope(snapshot, scope).filter((policy) => policy.category === entry.id);
  const first = policies[0];
  const uniform = policies.length > 0 && policies.every((policy) => first !== undefined && sameSettings(policy, first));
  const settings: OfapiCollectionSettings | null = uniform && first
    ? {
      pageId: scopePageId(scope),
      category: entry.id,
      mode: first.mode,
      intervalMinutes: first.intervalMinutes,
      dailyCreditLimit: first.dailyCreditLimit,
      maxCallsPerRun: first.maxCallsPerRun,
      includeDetails: first.includeDetails,
    }
    : null;
  const modes = new Set(policies.map((policy) => policy.mode));
  const mode: OfapiCollectionMode | "mixed" = modes.size === 0
    ? "off"
    : modes.size === 1
      ? policies[0]!.mode
      : "mixed";
  const lastCapturedAt = policies
    .map((policy) => policy.lastCapturedAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1) ?? null;
  return {
    entry,
    policies,
    uniform,
    settings,
    mode,
    sources: Array.from(new Set(policies.map((policy) => policy.source))),
    overridePageIds: policies.filter((policy) => policy.source === "page").map((policy) => policy.pageId!),
    usage: usageTotals(policies),
    lastCapturedAt,
    supportsToggle: entry.modes.some((candidate) => candidate !== "off"),
    group: categoryGroup(entry, mode),
  };
}

export function buildCategoryViews(snapshot: OfapiCollectionSnapshot, scope: CollectionScope) {
  return snapshot.catalog.map((entry) => buildCategoryView(snapshot, scope, entry));
}

export const CATEGORY_GROUP_ORDER: CategoryGroup[] = ["running", "available", "one_off", "unavailable"];

/** Groups in the owner's order (working now → available → one-off only →
 *  not implemented); inside a group the most expensive 30-day row first,
 *  ties keep the registry order. */
export function groupCategoryViews(views: CategoryView[]): Record<CategoryGroup, CategoryView[]> {
  const groups: Record<CategoryGroup, CategoryView[]> = {
    running: [],
    available: [],
    one_off: [],
    unavailable: [],
  };
  for (const view of views) {
    groups[view.group].push(view);
  }
  for (const group of CATEGORY_GROUP_ORDER) {
    groups[group] = groups[group]
      .map((view, index) => ({ view, index }))
      .sort((a, b) => b.view.usage.credits30d - a.view.usage.credits30d || a.index - b.index)
      .map(({ view }) => view);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Row state — one value, one wording; colour never carries meaning alone.

export type RowTone = "ok" | "warning" | "danger" | "accent" | "muted" | "off";

export interface RowState {
  tone: RowTone;
  label: string;
  detail: string | null;
}

export function rowState(view: CategoryView, backgroundPaused: boolean): RowState {
  if (!view.supportsToggle && !view.entry.supportsOneOff) {
    return { tone: "off", label: "ещё не реализовано", detail: "категория из плана без работающего кода" };
  }
  if (view.mode === "off") {
    return { tone: "off", label: "выключено", detail: null };
  }
  if (backgroundPaused) {
    return { tone: "danger", label: "остановлено", detail: "глобальная пауза · режим сохранён" };
  }
  const stale = view.policies.filter((policy) => policy.scheduleHealth.stale);
  if (stale.length > 0) {
    const causes = new Set(stale.map((policy) => staleCauseText(policy.scheduleHealth.lastRun)));
    const cause = causes.size === 1 ? [...causes][0]! : "причины различаются";
    // In the all-pages scope, say how many of the pages it is; the banner names them.
    const share = stale.length < view.policies.length
      ? `${stale.length} из ${view.policies.length} ${ruPlural(view.policies.length, "страницы", "страниц", "страниц")} · `
      : causes.size > 1 ? `${stale.length} ${ruPlural(stale.length, "страница", "страницы", "страниц")} · ` : "";
    return { tone: "warning", label: "устарело", detail: `${share}${cause}` };
  }
  if (view.usage.inFlight > 0) {
    return {
      tone: "accent",
      label: "в работе",
      detail: `${view.usage.inFlight} ${ruPlural(view.usage.inFlight, "запрос", "запроса", "запросов")} в полёте`,
    };
  }
  const budgeted = view.policies.filter((policy) => policy.source !== "legacy_baseline");
  const exhausted = budgeted.filter(
    (policy) => policy.usage.reservedCreditsToday >= policy.dailyCreditLimit,
  );
  if (exhausted.length > 0) {
    const worst = exhausted[0]!;
    return {
      tone: "warning",
      label: "лимит дня достигнут",
      detail: `${fmtCredits(worst.usage.reservedCreditsToday)} из ${fmtCredits(worst.dailyCreditLimit)} кр · продолжит 00:00 UTC`,
    };
  }
  if (view.mode === "mixed") {
    return { tone: "ok", label: "сбор разрешён", detail: "настройки различаются по страницам" };
  }
  if (view.sources.includes("legacy_baseline")) {
    return { tone: "muted", label: "прежняя конфигурация", detail: "Активность и лимиты задаёт прежний сборщик" };
  }
  return { tone: "ok", label: "сбор разрешён", detail: null };
}

// ---------------------------------------------------------------------------
// Formatting

export function fmtCredits(value: number) {
  return value.toLocaleString("ru-RU");
}

export { ruPlural };

/** All timestamps on the screen are UTC (budgets reset at UTC midnight). */
export function utcDateTime(iso: string) {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function relativeAge(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return "не собиралось";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const minutes = Math.max(0, Math.round((now.getTime() - then) / 60_000));
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ч назад`;
  const days = Math.round(hours / 24);
  return `${days} ${ruPlural(days, "день", "дня", "дней")} назад`;
}

export const INTERVAL_OPTIONS_MINUTES = [15, 30, 60, 180, 360, 720, 1440, 4320, 10080] as const;

export function intervalLabel(minutes: number) {
  if (minutes % 10080 === 0) {
    const weeks = minutes / 10080;
    return `${weeks} ${ruPlural(weeks, "неделя", "недели", "недель")}`;
  }
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? "24 ч" : `${days} ${ruPlural(days, "сутки", "суток", "суток")}`;
  }
  if (minutes % 60 === 0) return `${minutes / 60} ч`;
  return `${minutes} мин`;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} Б`;
  const units = ["КБ", "МБ", "ГБ"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toLocaleString("ru-RU", { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`;
}

/** One sentence per settings object — used by the mode column, the draft
 *  chips, the preview "was → will" line and the audit journal. */
export function describeSettings(settings: OfapiCollectionSettings) {
  const parts = [modeLabel(settings.mode)];
  if (settings.mode === "scheduled") {
    parts.push(`каждые ${intervalLabel(settings.intervalMinutes)}`);
    parts.push(`до ${settings.maxCallsPerRun} ${ruPlural(settings.maxCallsPerRun, "вызова", "вызовов", "вызовов")} за запуск`);
  }
  if (settings.mode !== "off") {
    parts.push(`лимит ${fmtCredits(settings.dailyCreditLimit)} кр/сутки`);
    if (settings.includeDetails) parts.push("с detail-запросами");
  }
  return parts.join(" · ");
}

export function scopeLabel(pageId: number | null, pages: Array<{ id: number; label: string }>) {
  if (pageId === null) return "все OF-страницы (общая настройка)";
  return pages.find((page) => page.id === pageId)?.label ?? `страница #${pageId}`;
}

// ---------------------------------------------------------------------------
// Audit journal

export interface ParsedAuditChanges {
  changes: OfapiCollectionSettings[];
  backgroundPaused: boolean | undefined;
}

export function parseAuditChanges(changes: unknown): ParsedAuditChanges | null {
  if (typeof changes !== "object" || changes === null) return null;
  const record = changes as Record<string, unknown>;
  const list = Array.isArray(record.changes) ? record.changes.filter(isSettings) : [];
  const paused = typeof record.backgroundPaused === "boolean" ? record.backgroundPaused : undefined;
  return { changes: list, backgroundPaused: paused };
}

export function summarizeAudit(
  row: OfapiCollectionAuditRow,
  pages: Array<{ id: number; label: string }>,
): string {
  const parsed = parseAuditChanges(row.changes);
  if (!parsed) return "запись без разбираемых изменений";
  const parts = parsed.changes.map(
    (change) => `${categoryLabel(change.category)} (${scopeLabel(change.pageId, pages)}): ${describeSettings(change)}`,
  );
  if (parsed.backgroundPaused !== undefined) {
    parts.push(`фоновый сбор: ${parsed.backgroundPaused ? "остановлен" : "возобновлён"}`);
  }
  return parts.length > 0 ? parts.join("; ") : "без изменений категорий";
}

// ---------------------------------------------------------------------------
// Conflict compare (another window applied a newer revision)

export interface DraftDiffRow {
  key: string;
  category: OfapiCollectionCategory;
  pageId: number | null;
  draft: OfapiCollectionSettings;
  base: OfapiCollectionSettings | null;
  /** Current effective value for the same scope, null when pages disagree. */
  current: OfapiCollectionSettings | null;
  changedElsewhere: boolean;
}

export function diffDraftAgainstSnapshot(
  draft: CollectionDraft,
  snapshot: OfapiCollectionSnapshot,
): DraftDiffRow[] {
  return Object.entries(draft.entries).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => {
    const scope: CollectionScope = entry.settings.pageId === null
      ? { kind: "all" }
      : { kind: "page", pageId: entry.settings.pageId };
    const catalogEntry = snapshot.catalog.find((candidate) => candidate.id === entry.settings.category);
    const current = catalogEntry ? buildCategoryView(snapshot, scope, catalogEntry).settings : null;
    const changedElsewhere = entry.base !== null && current !== null
      ? !sameSettings(entry.base, current)
      : entry.base !== current;
    return {
      key,
      category: entry.settings.category,
      pageId: entry.settings.pageId,
      draft: entry.settings,
      base: entry.base,
      current,
      changedElsewhere,
    };
  });
}

// ---------------------------------------------------------------------------
// Global stop summary (what the pause will actually stop)

export interface StopSummary {
  scheduled: Array<{ category: OfapiCollectionCategory; pages: number }>;
  onDemand: Array<{ category: OfapiCollectionCategory; pages: number }>;
  inFlight: number;
}

export function stopSummary(snapshot: OfapiCollectionSnapshot): StopSummary {
  const byMode = (mode: OfapiCollectionMode) => {
    const counts = new Map<OfapiCollectionCategory, number>();
    for (const policy of snapshot.policies) {
      if (policy.mode !== mode) continue;
      counts.set(policy.category, (counts.get(policy.category) ?? 0) + 1);
    }
    return snapshot.catalog
      .filter((entry) => counts.has(entry.id))
      .map((entry) => ({ category: entry.id, pages: counts.get(entry.id)! }));
  };
  return {
    scheduled: byMode("scheduled"),
    onDemand: byMode("on_demand"),
    inFlight: snapshot.policies.reduce((sum, policy) => sum + policy.inFlight, 0),
  };
}

// ---------------------------------------------------------------------------
// One-off jobs

export const DEFAULT_JOB_MAX_BYTES = 100 * 1024 * 1024;

export function defaultJobBody(
  pageId: number,
  category: OfapiCollectionCategory,
  expectedRevision: number,
): OfapiCollectionJobBody {
  return {
    pageId,
    category,
    expectedRevision,
    maxCredits: 50,
    maxCalls: 50,
    maxBytes: DEFAULT_JOB_MAX_BYTES,
    from: null,
    to: null,
    selection: [],
  };
}

/** `<input type="datetime-local">` value → RFC 3339 instant, or null when empty
 *  or unparseable (the contract takes an ISO datetime or null, never ""). */
export function localDateTimeToIso(value: string): string | null {
  if (!value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseSelection(raw: string): string[] {
  return raw
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 100);
}

// ---------------------------------------------------------------------------
// Scheduled runs that do not complete (traffic plan §2.8 п. 3)

type RunFacts = Pick<OfapiCollectionRun, "reason" | "exhaustedCap" | "usedCalls" | "maxCalls" | "usedCredits" | "maxCredits" | "usedBytes" | "maxBytes" | "stepsDone" | "stepsTotal">;

const SCHEDULED_RUN_EXHAUSTED_PREFIX = "scheduled_run_exhausted:";

/** The policy field that raises a spent run ceiling: a scheduled run's call
 *  ceiling is «Запросов за запуск», its credit ceiling the category's daily
 *  limit. Its byte ceiling is fixed, so it has none. */
export type CapLever = "calls" | "credits";
export const CAP_LEVER_FIELD_RU: Record<CapLever, string> = {
  calls: "«Запросов за запуск, не более»",
  credits: "«Дневной лимит категории, кр»",
};

/** The runner's reason in the owner's words when a cap ended a scheduled run;
 *  null for any other reason (shown as the server wrote it). Admission says
 *  only `job_limit`; the server names the spent ceiling from the run's own
 *  counters, and when they single none out the text names no ceiling. */
export function exhaustedRunText(run: RunFacts): string | null {
  if (!run.reason?.startsWith(SCHEDULED_RUN_EXHAUSTED_PREFIX)) return null;
  const limit = run.reason.slice(SCHEDULED_RUN_EXHAUSTED_PREFIX.length);
  if (limit === "job_limit") {
    const step = run.stepsDone !== null && run.stepsTotal !== null && run.stepsDone < run.stepsTotal
      ? ` · остановился на шаге ${run.stepsDone + 1} из ${run.stepsTotal}`
      : "";
    switch (run.exhaustedCap) {
      case "calls": return `проход не успевает за лимит вызовов: ${run.usedCalls} из ${run.maxCalls}${step}`;
      case "credits": return `проход не успевает за лимит кредитов: ${fmtCredits(run.usedCredits)} из ${fmtCredits(run.maxCredits)} кр${step}`;
      case "bytes": return `проход не успевает за лимит объёма: ${formatBytes(run.usedBytes)} из ${formatBytes(run.maxBytes)}${step}`;
      default: return `проход упирается в лимит задачи: вызовы ${run.usedCalls} из ${run.maxCalls} · ${fmtCredits(run.usedCredits)} из ${fmtCredits(run.maxCredits)} кр · ${formatBytes(run.usedBytes)} из ${formatBytes(run.maxBytes)}${step}`;
    }
  }
  if (limit === "daily_limit") return "проход упирается в дневной лимит кредитов";
  if (limit === "interval_limit") return "проход упирается в лимит интервала";
  return `проход упирается в лимит: ${limit}`;
}

export function jobReasonText(job: RunFacts): string | null {
  return exhaustedRunText(job) ?? job.reason;
}

/** Why a stale category's newest scheduled run did not complete. */
export function staleCauseText(run: OfapiCollectionRun | null): string {
  if (run === null) return "проходов по расписанию ещё не было";
  const exhausted = exhaustedRunText(run);
  if (exhausted) return exhausted;
  switch (run.state) {
    case "paused": return "проход на паузе — нужен человек";
    case "queued":
    case "running": return "проход идёт";
    case "completed": return "после последнего успешного прохода новых не было";
    default: return run.reason ? `последний проход завершился ошибкой: ${run.reason}` : "последний проход завершился ошибкой";
  }
}

export interface StaleEntry {
  pageId: number;
  pageLabel: string;
  category: OfapiCollectionCategory;
  policy: OfapiCollectionPolicy;
  cause: string;
  /** The run spent one ceiling of its own every pass. */
  outgrowsRun: boolean;
  /** The policy field that raises that ceiling; null when the ceiling is not
   *  named (counters ambiguous) or not the owner's (bytes). */
  lever: CapLever | null;
}

/** Every stale (page, category) of the snapshot, by page then registry order. */
export function staleEntries(snapshot: OfapiCollectionSnapshot): StaleEntry[] {
  const order = new Map(snapshot.catalog.map((entry, index) => [entry.id, index]));
  return snapshot.policies
    .filter((policy) => policy.pageId !== null && policy.scheduleHealth.stale)
    .map((policy) => {
      const run = policy.scheduleHealth.lastRun;
      const cap = run?.exhaustedLimit === "job_limit" ? run.exhaustedCap : null;
      return {
        pageId: policy.pageId!,
        pageLabel: scopeLabel(policy.pageId, snapshot.pages),
        category: policy.category,
        policy,
        cause: staleCauseText(run),
        outgrowsRun: run?.exhaustedLimit === "job_limit",
        lever: cap === "calls" || cap === "credits" ? cap : null,
      };
    })
    .sort((a, b) => a.pageLabel.localeCompare(b.pageLabel) || (order.get(a.category) ?? 0) - (order.get(b.category) ?? 0));
}

export function jobProgress(job: OfapiCollectionJob) {
  return `${fmtCredits(job.usedCredits)} из ${fmtCredits(job.maxCredits)} кр · ${job.usedCalls} из ${job.maxCalls} вызовов · ${formatBytes(job.usedBytes)} из ${formatBytes(job.maxBytes)}`;
}

export function jobsFor(
  snapshot: OfapiCollectionSnapshot,
  scope: CollectionScope,
  category?: OfapiCollectionCategory,
) {
  return snapshot.jobs.filter(
    (job) => (scope.kind === "all" || job.pageId === scope.pageId)
      && (category === undefined || job.category === category),
  );
}

// ---------------------------------------------------------------------------
// Policy pill (single "what is in force" indicator)

export type ApplyPhase =
  | { kind: "idle" }
  | { kind: "saved"; revision: number }
  | { kind: "error"; message: string };

export interface PolicyPill {
  tone: RowTone;
  text: string;
}

export function describePolicyPill(input: {
  snapshot: OfapiCollectionSnapshot;
  applyPhase: ApplyPhase;
  conflict: boolean;
  actorName: string | null;
}): PolicyPill {
  const { snapshot, applyPhase } = input;
  if (input.conflict) {
    return { tone: "accent", text: "изменено в другом окне" };
  }
  if (applyPhase.kind === "error") {
    return { tone: "danger", text: `v${snapshot.revision} · ошибка применения` };
  }
  if (applyPhase.kind === "saved" && snapshot.revision < applyPhase.revision) {
    return { tone: "warning", text: `v${applyPhase.revision} · применяется · ждём readback` };
  }
  if (snapshot.backgroundPaused) {
    return { tone: "danger", text: `Политика v${snapshot.revision} · глобальная пауза` };
  }
  const latest = snapshot.audit.find((row) => row.revision === snapshot.revision);
  if (snapshot.revision === 0) {
    return { tone: "muted", text: "Политика v0 · baseline, изменений не было" };
  }
  if (!latest) {
    return { tone: "ok", text: `Политика v${snapshot.revision} · применена` };
  }
  return {
    tone: "ok",
    text: `Политика v${snapshot.revision} · применена ${utcDateTime(latest.createdAt)}${input.actorName ? ` · ${input.actorName}` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// Webhook card (read-only)

export function maskWebhookId(id: string | null) {
  if (!id) return "—";
  return id.length <= 10 ? id : `${id.slice(0, 5)}…${id.slice(-3)}`;
}

const WEBHOOK_GROUP_LABELS: Record<string, string> = {
  messages: "Сообщения",
  transactions: "Оплаты",
  subscriptions: "Подписки",
  users: "Присутствие",
  posts: "Посты",
  comments: "Комментарии",
  media_uploads: "Медиа-загрузки",
  accounts: "Аккаунт",
};

export function groupWebhookEvents(events: string[]): Array<{ group: string; label: string; events: string[] }> {
  const groups = new Map<string, string[]>();
  for (const event of events) {
    const prefix = event.split(".")[0] ?? event;
    groups.set(prefix, [...(groups.get(prefix) ?? []), event]);
  }
  return Array.from(groups.entries()).map(([group, list]) => ({
    group,
    label: WEBHOOK_GROUP_LABELS[group] ?? group,
    events: list,
  }));
}
