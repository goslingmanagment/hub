import { useState } from "react";
import { applyOfapiKeyScope, readOfapiKeyScope, readOfapiVendorUsage } from "@/api/ofapiVendor";

const capabilities = ["reads", "commands", "webhooks", "exports", "uploads", "links"] as const;
const capabilityLabels = { reads: "Чтение", commands: "Команды", webhooks: "Вебхуки", exports: "Экспорты", uploads: "Загрузки", links: "Ссылки и pixels" };
type Scope = Awaited<ReturnType<typeof readOfapiKeyScope>>;
type Report = Awaited<ReturnType<typeof readOfapiVendorUsage>>;
const inputClass = "rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary";
const buttonClass = "rounded-lg border border-border px-3 py-2 text-sm text-accent hover:bg-hover disabled:opacity-50";

/** Explicit free diagnostics: opening the console neither refreshes paid datasets nor changes a key. */
export function OfapiVendorEvidence() {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(yesterday);
  const [to, setTo] = useState(yesterday);
  const [report, setReport] = useState<Report | null>(null);
  const [scope, setScope] = useState<Scope | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [accounts, setAccounts] = useState("");
  const [known, setKnown] = useState(false);
  const [visibility, setVisibility] = useState<Scope["visibility"]>("unknown");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const windowDays = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  const invalidWindow = !from || !to || !Number.isFinite(windowDays) || windowDays < 0 || windowDays >= 366 || to > yesterday;
  const run = async (action: () => Promise<void>) => {
    setPending(true); setError(null);
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось прочитать состояние"); }
    finally { setPending(false); }
  };
  return <section className="mt-6 rounded-xl border border-border bg-card p-5" aria-labelledby="ofapi-vendor-evidence-title">
    <h2 id="ofapi-vendor-evidence-title" className="font-semibold text-text-primary">Сверка с провайдером и права ключа</h2>
    <p className="mt-1 text-sm text-text-secondary">Запрос отчёта бесплатный. Суммы OFAPI и Hub показаны отдельно; неизвестная область ключа не означает всю команду.</p>
    <div className="mt-4 flex flex-wrap items-end gap-3">
      <label className="grid gap-1 text-sm">С<input aria-label="Сверка с даты" className={inputClass} type="date" value={from} max={yesterday} onChange={e => setFrom(e.target.value)} /></label>
      <label className="grid gap-1 text-sm">По<input aria-label="Сверка по дату" className={inputClass} type="date" value={to} max={yesterday} onChange={e => setTo(e.target.value)} /></label>
      <button className={buttonClass} disabled={pending || invalidWindow} onClick={() => void run(async () => {
        setReport(await readOfapiVendorUsage({ from, to, groupBy: "day", accountId: null, includeToday: false }));
      })}>Сверить закрытые дни · 0 credits</button>
      <button className={buttonClass} disabled={pending} onClick={() => void run(async () => {
        const value = await readOfapiKeyScope(); setScope(value); setSelected(value.capabilities ?? []);
        setKnown(value.capabilities !== null); setAccounts(value.accountIds?.join(", ") ?? ""); setVisibility(value.visibility);
      })}>Прочитать права ключа</button>
    </div>
    {invalidWindow && <p className="mt-2 text-sm text-red-700">Выберите от 1 до 366 закрытых дней; начало не может быть позже конца.</p>}
    {pending && <p className="mt-3 text-sm" role="status">Проверяем…</p>}
    {error && <p className="mt-3 text-sm text-red-700" role="alert">{error} Черновик сохранён. При конфликте сначала перечитайте права.</p>}
    {report && <div className="mt-4 space-y-2 text-sm">
      <p>Период полученного отчёта: {report.vendor.from} — {report.vendor.to} UTC.</p>
      <p>OFAPI: <strong>{report.vendor.totals.credits}</strong> credits · Hub: <strong>{report.local.recordedCredits}</strong> · разница: <strong>{report.difference}</strong></p>
      <p>Из Hub оценочные: {report.local.estimatedCredits}. Отдельный остаток сверки баланса: {report.local.externalResidualCredits}.</p>
      <p className="text-text-secondary">Область: {report.visibility}. Совпадение исторической области ключа не доказано. Разница сама по себе не подтверждает потерю расходов. Снимок №{report.snapshotId}, {report.observedAt}.</p>
      <div className="overflow-x-auto"><table className="w-full text-left"><caption className="sr-only">Дневные расходы OFAPI</caption><thead><tr><th>Дата</th><th>Тип</th><th>Credits</th><th>Запросы</th></tr></thead><tbody>{report.vendor.results.map((row, index) => <tr key={`${row.day}-${row.creditType}-${index}`}><td>{row.day ?? "Без даты"}</td><td>{row.creditType ?? "Не указан"}</td><td>{row.credits}</td><td>{row.requests}</td></tr>)}</tbody></table></div>
    </div>}
    {scope && <form className="mt-5 space-y-3 border-t border-border pt-4" onSubmit={event => {
      event.preventDefault(); void run(async () => {
        const accountIds = accounts.trim() ? accounts.split(",").map(value => value.trim()) : null;
        const updated = await applyOfapiKeyScope({ credentialFingerprint: scope.credentialFingerprint, expectedVersion: scope.version,
          capabilities: known ? capabilities.filter(value => selected.includes(value)) : null, accountIds, visibility });
        setScope(updated);
      });
    }}>
      <p className="text-sm">Проверка команды: {scope.preflightStatus} · {scope.observedTeam ?? "неизвестна"} · версия {scope.version}</p>
      <p className="text-sm text-text-secondary">Это локальная декларация ограничений. Выдайте права в консоли OFAPI, затем отразите их здесь. Hub не меняет vendor key и не проверяет write-права пробной отправкой.</p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={known} onChange={e => setKnown(e.target.checked)} />Набор разрешённых операций известен</label>
      <fieldset disabled={!known || pending} className="flex flex-wrap gap-3"><legend className="sr-only">Разрешённые операции</legend>{capabilities.map(value => <label key={value} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={selected.includes(value)} onChange={e => setSelected(e.target.checked ? [...selected, value] : selected.filter(item => item !== value))} />{capabilityLabels[value]}</label>)}</fieldset>
      <label className="grid gap-1 text-sm">Доступные account IDs, через запятую; пусто — ограничение не задано<input className={inputClass} value={accounts} onChange={e => setAccounts(e.target.value)} /></label>
      <label className="grid gap-1 text-sm">Область отчётов<select className={inputClass} value={visibility} onChange={e => setVisibility(e.target.value as Scope["visibility"])}><option value="unknown">Неизвестна</option><option value="declared_restricted">Ограниченные аккаунты</option><option value="declared_team">Вся команда — подтверждено владельцем</option></select></label>
      <button className={buttonClass} disabled={pending} type="submit">Сохранить ограничения для этого ключа</button>
    </form>}
  </section>;
}
