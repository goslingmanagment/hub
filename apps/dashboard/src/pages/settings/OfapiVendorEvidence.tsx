import { useState } from "react";
import { applyOfapiKeyScope, readOfapiKeyScope, readOfapiVendorUsage } from "@/api/ofapiVendor";
import { formatDateTime } from "@/lib/format";

const capabilities = ["reads", "commands", "webhooks", "exports", "uploads", "links"] as const;
const capabilityLabels = { reads: "Чтение", commands: "Команды", webhooks: "Вебхуки", exports: "Экспорты", uploads: "Загрузки", links: "Ссылки и пиксели" };
const visibilityLabels: Record<string, string> = {
  unknown: "неизвестна", declared_restricted: "ограниченные аккаунты", declared_team: "вся команда (подтверждено владельцем)",
};
const preflightLabels: Record<string, string> = {
  verified: "подтверждена", unknown: "не проверена", mismatch: "не совпадает", denied: "доступ запрещён",
};
type Scope = Awaited<ReturnType<typeof readOfapiKeyScope>>;
type Report = Awaited<ReturnType<typeof readOfapiVendorUsage>>;

/** Explicit free diagnostics: opening the console neither refreshes paid datasets nor changes a key.
 *  The card around it (title, description) belongs to the screen. */
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
  return <div className="space-y-5 text-sm">
    <section className="space-y-3" aria-label="Сверка расходов">
      <p className="text-text-secondary">Запрос отчёта бесплатный. Суммы провайдера и Hub показаны отдельно; неизвестная область ключа не означает всю команду.</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block"><span className="field-label">С</span><input aria-label="Сверка с даты" className="input w-auto" type="date" value={from} max={yesterday} onChange={e => setFrom(e.target.value)} /></label>
        <label className="block"><span className="field-label">По</span><input aria-label="Сверка по дату" className="input w-auto" type="date" value={to} max={yesterday} onChange={e => setTo(e.target.value)} /></label>
        <button type="button" className="btn" disabled={pending || invalidWindow} onClick={() => void run(async () => {
          setReport(await readOfapiVendorUsage({ from, to, groupBy: "day", accountId: null, includeToday: false }));
        })}>Сверить закрытые дни · бесплатно</button>
      </div>
      {invalidWindow && <p className="text-danger">Выберите от 1 до 366 закрытых дней; начало не может быть позже конца.</p>}
      {report && <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="stat"><div className="stat-label">OnlyFans API</div><div className="stat-value">{report.vendor.totals.credits} кр</div></div>
          <div className="stat"><div className="stat-label">Hub</div><div className="stat-value">{report.local.recordedCredits} кр</div><div className="stat-meta">из них оценочные: {report.local.estimatedCredits}</div></div>
          <div className="stat"><div className="stat-label">Разница</div><div className="stat-value">{report.difference} кр</div><div className="stat-meta">остаток сверки баланса: {report.local.externalResidualCredits}</div></div>
        </div>
        <p className="text-text-secondary">
          Период отчёта: {report.vendor.from} — {report.vendor.to} (UTC). Область: <span title={report.visibility}>{visibilityLabels[report.visibility] ?? report.visibility}</span>.
          Совпадение исторической области ключа не доказано; разница сама по себе не подтверждает потерю расходов.
          Отчёт получен <span title={`Снимок №${report.snapshotId} · ${report.observedAt}`}>{formatDateTime(report.observedAt)}</span>.
        </p>
        <div className="table-wrap"><table className="data-table"><caption className="sr-only">Дневные расходы OnlyFans API</caption><thead><tr><th>Дата</th><th>Тип</th><th className="num">Кредиты</th><th className="num">Запросы</th></tr></thead><tbody>{report.vendor.results.map((row, index) => <tr key={`${row.day}-${row.creditType}-${index}`}><td>{row.day ?? "Без даты"}</td><td className="muted">{row.creditType ?? "Не указан"}</td><td className="num">{row.credits}</td><td className="num">{row.requests}</td></tr>)}</tbody></table></div>
      </div>}
    </section>
    <section className="space-y-3 border-t border-border pt-5" aria-label="Права ключа">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-text-secondary">Какие операции разрешены текущему ключу — по вашей декларации.</p>
        <button type="button" className="btn" disabled={pending} onClick={() => void run(async () => {
          const value = await readOfapiKeyScope(); setScope(value); setSelected(value.capabilities ?? []);
          setKnown(value.capabilities !== null); setAccounts(value.accountIds?.join(", ") ?? ""); setVisibility(value.visibility);
        })}>Прочитать права ключа</button>
      </div>
      {scope && <form className="space-y-3" onSubmit={event => {
        event.preventDefault(); void run(async () => {
          const accountIds = accounts.trim() ? accounts.split(",").map(value => value.trim()) : null;
          const updated = await applyOfapiKeyScope({ credentialFingerprint: scope.credentialFingerprint, expectedVersion: scope.version,
            capabilities: known ? capabilities.filter(value => selected.includes(value)) : null, accountIds, visibility });
          setScope(updated);
        });
      }}>
        <p>Команда у провайдера: {scope.observedTeam ?? "неизвестна"} · проверка: <span title={scope.preflightStatus}>{preflightLabels[scope.preflightStatus] ?? scope.preflightStatus}</span></p>
        <p className="text-text-secondary">Это локальная декларация ограничений. Выдайте права в консоли OnlyFans API, затем отразите их здесь. Hub не меняет ключ у провайдера и не проверяет права на запись пробной отправкой.</p>
        <label className="flex items-center gap-2"><input type="checkbox" className="accent-accent" checked={known} onChange={e => setKnown(e.target.checked)} />Набор разрешённых операций известен</label>
        <fieldset disabled={!known || pending} className="flex flex-wrap gap-x-4 gap-y-2"><legend className="sr-only">Разрешённые операции</legend>{capabilities.map(value => <label key={value} className="flex items-center gap-1.5"><input type="checkbox" className="accent-accent" checked={selected.includes(value)} onChange={e => setSelected(e.target.checked ? [...selected, value] : selected.filter(item => item !== value))} />{capabilityLabels[value]}</label>)}</fieldset>
        <label className="block"><span className="field-label">ID доступных аккаунтов через запятую</span><input className="input" value={accounts} onChange={e => setAccounts(e.target.value)} /><span className="field-hint block">Пусто — ограничение не задано.</span></label>
        <label className="block"><span className="field-label">Область отчётов</span><select className="select" value={visibility} onChange={e => setVisibility(e.target.value as Scope["visibility"])}><option value="unknown">Неизвестна</option><option value="declared_restricted">Ограниченные аккаунты</option><option value="declared_team">Вся команда — подтверждено владельцем</option></select></label>
        <button className="btn btn-primary" disabled={pending} type="submit">Сохранить ограничения для этого ключа</button>
      </form>}
    </section>
    {pending && <p className="text-text-secondary" role="status">Проверяем…</p>}
    {error && <p className="text-danger" role="alert">{error} Черновик сохранён. При конфликте сначала перечитайте права.</p>}
  </div>;
}
