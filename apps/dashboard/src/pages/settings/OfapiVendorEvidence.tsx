import { useRef } from "react";
import { ofapiKeyScopeApplySchema, ofapiUsageWindowSchema } from "@agency_hub_core/contracts";
import { applyOfapiKeyScope, readOfapiKeyScope, readOfapiVendorUsage } from "@/api/ofapiVendor";
import { useSessionWorkspace } from "@/lib/useSessionWorkspace";

const capabilities = ["reads", "commands", "webhooks", "exports", "uploads", "links"] as const;
const capabilityLabels = { reads: "Чтение", commands: "Команды", webhooks: "Вебхуки", exports: "Экспорты", uploads: "Загрузки", links: "Ссылки и pixels" };
type Scope = Awaited<ReturnType<typeof readOfapiKeyScope>>;
type Report = Awaited<ReturnType<typeof readOfapiVendorUsage>>;
const inputClass = "min-h-10 min-w-0 max-w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary";
const buttonClass = "rounded-lg border border-border px-3 py-2 text-sm text-accent hover:bg-hover disabled:opacity-50";

/** Explicit free diagnostics: opening the console neither refreshes paid datasets nor changes a key. */
export function OfapiVendorEvidence() {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  type Workspace = { from: string; to: string; report: Report | null; scope: Scope | null; freshScope: Scope | null; dirty: boolean; selected: string[]; accounts: string; known: boolean; visibility: Scope["visibility"]; pending: boolean; error: string | null; notice: string };
  const [workspace, setWorkspace, readWorkspace] = useSessionWorkspace<Workspace>("ofapi-vendor-evidence", () => ({ from: yesterday, to: yesterday, report: null, scope: null, freshScope: null, dirty: false, selected: [], accounts: "", known: false, visibility: "unknown", pending: false, error: null, notice: "" }));
  const { from, to, report, scope, freshScope, dirty, selected, accounts, known, visibility, pending, error, notice } = workspace;
  const put = <K extends keyof Workspace>(key: K, value: Workspace[K]) => setWorkspace(current => ({ ...current, [key]: value }));
  const setFrom = (value: string) => put("from", value), setTo = (value: string) => put("to", value);
  const setReport = (value: Report | null) => put("report", value), setScope = (value: Scope | null) => put("scope", value), setFreshScope = (value: Scope | null) => put("freshScope", value);
  const setDirty = (value: boolean) => put("dirty", value), setKnown = (value: boolean) => put("known", value), setPending = (value: boolean) => put("pending", value);
  const setSelected = (value: string[]) => put("selected", value), setAccounts = (value: string) => put("accounts", value), setVisibility = (value: Scope["visibility"]) => put("visibility", value);
  const setError = (value: string | null) => put("error", value), setNotice = (value: string) => put("notice", value);
  const inFlight = useRef(false);
  const scopeChanged = scope !== null && freshScope !== null && (scope.version !== freshScope.version || scope.credentialFingerprint !== freshScope.credentialFingerprint);
  const visibilityLabels = { unknown: "Неизвестна", declared_team: "Вся команда по декларации владельца", declared_restricted: "Ограниченные аккаунты" };
  const preflightLabels = { verified: "Подтверждена", unknown: "Неизвестна", mismatch: "Команда не совпадает", denied: "Доступ отклонён" };
  function adoptScope(value: Scope) { setScope(value); setFreshScope(value); setSelected(value.capabilities ?? []); setKnown(value.capabilities !== null); setAccounts(value.accountIds?.join(", ") ?? ""); setVisibility(value.visibility); setDirty(false); }
  const run = async (action: () => Promise<void>) => {
    if (inFlight.current || readWorkspace().pending) return;
    inFlight.current = true; setPending(true); setError(null); setNotice("");
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось прочитать состояние"); }
    finally { inFlight.current = false; setPending(false); }
  };
  return <section className="mt-6 rounded-xl border border-border bg-card p-5" aria-labelledby="ofapi-vendor-evidence-title">
    <h2 id="ofapi-vendor-evidence-title" className="font-semibold text-text-primary">Сверка с провайдером и права ключа</h2>
    <p className="mt-1 text-sm text-text-secondary">Запрос отчёта бесплатный. Суммы OFAPI и Hub показаны отдельно; неизвестная область ключа не означает всю команду.</p>
    <div className="mt-4 flex flex-wrap items-end gap-3">
      <label className="grid gap-1 text-sm">С<input aria-label="Сверка с даты" className={inputClass} type="date" value={from} max={yesterday} onChange={e => setFrom(e.target.value)} /></label>
      <label className="grid gap-1 text-sm">По<input aria-label="Сверка по дату" className={inputClass} type="date" value={to} max={yesterday} onChange={e => setTo(e.target.value)} /></label>
      <button type="button" className={buttonClass} disabled={pending || !ofapiUsageWindowSchema.safeParse({ from, to }).success} onClick={() => void run(async () => {
        setReport(await readOfapiVendorUsage(ofapiUsageWindowSchema.parse({ from, to, groupBy: "day", accountId: null, includeToday: false })));
      })}>Сверить закрытые дни · 0 кредитов</button>
      <button className={buttonClass} disabled={pending} onClick={() => void run(async () => {
        const value = await readOfapiKeyScope(); setFreshScope(value);
        if (!dirty) adoptScope(value); else setNotice("Права перечитаны. Ваш черновик и его исходная версия сохранены.");
      })}>Прочитать права ключа</button>
    </div>
    {!ofapiUsageWindowSchema.safeParse({ from, to }).success && <p className="mt-2 text-xs text-warning">Выберите закрытые дни UTC: начало не позже конца, период не больше 366 дней.</p>}
    {!report && !pending && <p className="mt-3 text-sm text-text-muted">Выберите период и запросите сверку. Отсутствие отчёта не означает нулевой расход.</p>}
    {pending && <p className="mt-3 text-sm" role="status">Проверяем…</p>}
    {error && <p className="mt-3 text-sm text-red-700" role="alert">{error} Черновик сохранён. При конфликте сначала перечитайте права.</p>}
    {notice && <p role="status" className="mt-3 text-sm text-text-secondary">{notice}</p>}
    {report && <div className="mt-4 space-y-2 text-sm">
      <h3 className="font-semibold">Сверка за {report.vendor.from} — {report.vendor.to}, UTC</h3>
      {(from !== report.vendor.from || to !== report.vendor.to) && <p className="text-warning">В полях выбран другой период. Ниже остаётся отчёт за указанные в его заголовке даты.</p>}
      {error && <p className="text-warning">Сохранён предыдущий полученный отчёт; он не заменён результатом ошибки.</p>}
      <p>OFAPI: <strong>{report.vendor.totals.credits}</strong> credits · Hub: <strong>{report.local.recordedCredits}</strong> · разница: <strong>{report.difference}</strong></p>
      <p>Из Hub оценочные: {report.local.estimatedCredits}. Отдельный остаток сверки баланса: {report.local.externalResidualCredits}.</p>
      <p className="text-text-secondary">Область: {visibilityLabels[report.visibility]}. Совпадение исторической области ключа {report.equivalentScope ? "подтверждено" : "не доказано"}. Разница сама по себе не подтверждает потерю расходов. Снимок №{report.snapshotId}, {report.observedAt}.</p><p className="text-xs text-text-muted">{report.explanation}</p>
      <div className="overflow-x-auto" role="region" aria-label="Дневная сверка расходов" tabIndex={0}><table className="w-full text-left"><caption className="sr-only">Дневные расходы OFAPI</caption><thead><tr><th>Дата</th><th>Тип</th><th>Кредиты</th><th>Запросы</th></tr></thead><tbody>{report.vendor.results.map((row, index) => <tr key={`${row.day}-${row.creditType}-${index}`}><td>{row.day ?? "Без даты"}</td><td>{row.creditType ?? "Не указан"}</td><td>{row.credits}</td><td>{row.requests}</td></tr>)}</tbody></table></div>
      {!report.vendor.results.length && <p>В ответе провайдера нет дневных строк. Итоги и область отчёта показаны выше.</p>}
    </div>}
    {scope && <form className="mt-5 space-y-3 border-t border-border pt-4" onSubmit={event => {
      event.preventDefault(); void run(async () => {
        if (scopeChanged || !dirty) return;
        const accountIds = accounts.trim() ? [...new Set(accounts.split(",").map(value => value.trim()).filter(Boolean))] : null;
        const body = ofapiKeyScopeApplySchema.safeParse({ credentialFingerprint: scope.credentialFingerprint, expectedVersion: scope.version,
          capabilities: known ? capabilities.filter(value => selected.includes(value)) : null, accountIds, visibility });
        if (!body.success) throw new Error("Проверьте account IDs (acct_…), их число до 100 и область: вся команда несовместима с ограниченным списком аккаунтов.");
        const updated = await applyOfapiKeyScope(body.data);
        adoptScope(updated); setNotice("Ограничения сохранены в Hub. Права ключа у провайдера этим действием не менялись.");
      });
    }}>
      <p className="text-sm">Проверка команды: {preflightLabels[scope.preflightStatus]} · {scope.observedTeam ?? "неизвестна"} · версия {scope.version}</p>
      {scopeChanged && <p role="alert" className="text-sm text-warning">Права или ключ изменились после начала редактирования. Черновик относится к прежней версии; сохранение недоступно. <button type="button" className={buttonClass} disabled={pending} onClick={() => adoptScope(freshScope!)}>Сбросить черновик к прочитанным правам</button></p>}
      <fieldset className="space-y-3" disabled={pending} onChange={() => setDirty(true)}>
      <p className="text-sm text-text-secondary">Это локальная декларация ограничений. Выдайте права в консоли OFAPI, затем отразите их здесь. Hub не меняет vendor key и не проверяет write-права пробной отправкой.</p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={known} onChange={e => setKnown(e.target.checked)} />Набор разрешённых операций известен</label>
      <fieldset disabled={!known || pending} className="flex flex-wrap gap-3"><legend className="sr-only">Разрешённые операции</legend>{capabilities.map(value => <label key={value} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={selected.includes(value)} onChange={e => setSelected(e.target.checked ? [...selected, value] : selected.filter(item => item !== value))} />{capabilityLabels[value]}</label>)}</fieldset>
      <label className="grid gap-1 text-sm">Доступные account IDs, через запятую; пусто — ограничение не задано<input className={inputClass} value={accounts} onChange={e => setAccounts(e.target.value)} /></label>
      <label className="grid gap-1 text-sm">Область отчётов<select className={inputClass} value={visibility} onChange={e => setVisibility(e.target.value as Scope["visibility"])}><option value="unknown">Неизвестна</option><option value="declared_restricted">Ограниченные аккаунты</option><option value="declared_team">Вся команда — подтверждено владельцем</option></select></label>
      </fieldset>
      <div className="flex flex-wrap gap-2"><button className={buttonClass} disabled={pending || !dirty || scopeChanged} type="submit">Сохранить ограничения для этого ключа</button>{dirty && !scopeChanged && <button type="button" className={buttonClass} disabled={pending} onClick={() => adoptScope(scope)}>Сбросить черновик</button>}</div>
    </form>}
  </section>;
}
