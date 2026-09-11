import { useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";

import { AGENT_CAPABILITIES, agentKeyCreateBodySchema, type AgentCapability, type AgentKeyItem } from "@agency_hub_core/contracts";
import { useAdminPages, useAgentKeys, useCreateAgentKey, useIssuedAgentKeys, useRevokeAgentKey } from "@/api/queries";
import { Field } from "@/components/shared/Field";
import { ModalShell } from "@/components/shared/ModalShell";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { SearchInput } from "@/components/shared/SearchInput";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

const CAPABILITY_HELP: Readonly<Record<AgentCapability, string>> = {
  "read:messages": "Текст переписки и найденных сообщений",
  "read:money": "Транзакции, суммы трат и цены подписок",
  "read:observations_envelope": "Метаданные захвата: когда и что получено, без исходного содержимого",
  "read:datasets": "Запросы к зарегистрированным наборам данных",
  "request:hydration": "Запросить загрузку недостающих данных; запуск подтверждает владелец",
};

export function AgentKeysTab() {
  const { data: keys, isError, refetch } = useAgentKeys({ suppressGlobalError: true });
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<AgentKeyItem | null>(null);
  const [revokeError, setRevokeError] = useState("");
  const revokeFlight = useRef(false);
  const revoke = useRevokeAgentKey();
  const create = useCreateAgentKey();
  const { issued, acknowledge } = useIssuedAgentKeys();
  const receipt = issued[0];
  const [search, setSearch] = useSearchParams();
  const query = search.get("keyQuery") ?? "";
  const requestedStatus = search.get("keyStatus");
  const status = requestedStatus === "active" || requestedStatus === "revoked" || requestedStatus === "expired" ? requestedStatus : "all";
  const items = keys ?? [];
  const visible = items.filter((key) => {
    const matchesStatus = status === "all" || (status === "active" ? key.isActive : status === "revoked" ? key.revokedAt !== null : !key.isActive && key.revokedAt === null);
    return matchesStatus && `${key.name} ${key.keyPrefix} ${key.pageLabels.join(" ")} ${key.capabilities.join(" ")}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  });
  function updateSearch(changes: Record<string, string | null>) {
    setSearch((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value); else next.delete(key);
      }
      return next;
    });
  }
  function closeRevoke() {
    if (!revokeFlight.current) setRevoking(null);
  }
  async function handleRevoke() {
    if (!revoking || revokeFlight.current) return;
    const target = revoking;
    revokeFlight.current = true;
    setRevokeError("");
    try {
      const result = await revoke.mutateAsync(target.id);
      toast.success(result.revoked ? `Ключ «${target.name}» отозван` : `Ключ «${target.name}» уже был отозван`);
      setRevoking(null);
    } catch (error) {
      setRevokeError(error instanceof Error ? error.message : "Не удалось отозвать ключ");
    } finally {
      revokeFlight.current = false;
    }
  }

  return <>
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <p className="max-w-2xl text-sm text-text-muted">Ключ даёт агенту только выбранные возможности и страницы. Доступ к новым страницам автоматически не добавляется. Срок продлевается при использовании, максимум — 365 дней с выдачи.</p>
      <button type="button" disabled={create.isPending || Boolean(receipt)} onClick={() => setCreating(true)} className="min-h-10 shrink-0 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">{create.isPending ? "Выдаём ключ…" : "Выдать ключ"}</button>
    </div>
    <QueryNotice error={isError} stale={keys !== undefined} retry={refetch} />
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <SearchInput value={query} onChange={(value) => updateSearch({ keyQuery: value })} placeholder="Найти ключ, страницу или возможность…" />
      <label className="text-xs text-text-secondary"><span className="mb-1 block">Состояние</span><select value={status} onChange={(event) => updateSearch({ keyStatus: event.target.value === "all" ? null : event.target.value })} className="min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm"><option value="all">Все ключи</option><option value="active">Активные</option><option value="revoked">Отозванные</option><option value="expired">Истёкшие</option></select></label>
      {(query || status !== "all") && <button type="button" onClick={() => updateSearch({ keyQuery: null, keyStatus: null })} className="min-h-10 text-sm text-accent">Сбросить фильтры</button>}
      {keys && <span className="py-2 text-xs text-text-muted">{visible.length} из {items.length}</span>}
    </div>
    {!keys ? !isError && <p role="status" className="py-8 text-center text-sm text-text-muted">Загружаем ключи агентов…</p> : visible.length === 0 ? <StatusPanel title={items.length === 0 ? "Ключей агентов пока нет" : "Ключи не найдены"} description={items.length === 0 ? "Выдайте ключ для конкретной задачи, выбрав нужные данные и страницы." : "Измените запрос или сбросьте фильтры."} /> : <div className="space-y-3">
      {visible.map((key) => <div key={key.id} className={`rounded-xl border border-border bg-card p-4 ${key.isActive ? "" : "opacity-75"}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2"><span className="break-all text-[15px] font-semibold text-text-primary">{key.name}</span><span className={`rounded-full border px-2 py-0.5 text-xs ${key.isActive ? "border-green/30 text-green" : "border-border text-text-muted"}`}>{key.isActive ? "Активен" : key.revokedAt ? "Отозван" : "Истёк"}</span></div>
            <div className="mt-1 break-all font-mono text-xs text-text-muted">{key.keyPrefix}…</div>
            <ul className="mt-3 flex flex-wrap gap-2" aria-label="Возможности ключа">{key.capabilities.map((capability) => <li key={capability} className="rounded border border-border bg-bg px-2 py-1 text-xs text-text-secondary"><span className="block">{CAPABILITY_HELP[capability]}</span><code className="text-[10px] text-text-muted">{capability}</code></li>)}</ul>
            <p className="mt-3 break-words text-sm text-text-secondary">Страницы: {key.pageLabels.length ? key.pageLabels.join(", ") : "Нет доступных страниц в текущем каталоге"}</p>
            <p className="mt-2 text-xs leading-relaxed text-text-muted">Лимиты в сутки: {key.dailyRequestBudget.toLocaleString()} запросов · {key.dailyRowBudget.toLocaleString()} строк<br />Действует до {formatDateTime(key.expiresAt)} · Последнее использование: {key.lastUsedAt ? formatRelativeTime(key.lastUsedAt) : "не использовался"}</p>
          </div>
          {key.revokedAt === null && <button type="button" aria-label={`Отозвать ключ ${key.name}`} disabled={create.isPending || Boolean(receipt)} onClick={() => { setRevokeError(""); setRevoking(key); }} className="min-h-9 shrink-0 rounded-lg border border-danger/25 bg-danger/5 px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/10">Отозвать</button>}
        </div>
      </div>)}
    </div>}
    {creating && !receipt && <CreateAgentKeyModal create={create} onClose={() => setCreating(false)} onIssued={() => setCreating(false)} />}
    {receipt && <TokenRevealModal key={receipt.id} token={receipt.result.token} name={receipt.result.key.name} onClose={() => { acknowledge(receipt.id); create.reset(); }} />}
    {revoking && <ModalShell title={`Отозвать ключ «${revoking.name}»?`} onClose={closeRevoke} closeDisabled={revoke.isPending} closeLabel="Закрыть">
      <p className="text-sm text-text-secondary">Ключ сразу перестанет работать. Отменить отзыв нельзя; при необходимости выдайте новый ключ.</p>
      {revokeError && <p role="alert" className="mt-3 break-words text-sm text-danger">{revokeError}</p>}
      <div className="mt-6 flex flex-wrap justify-end gap-2"><button type="button" disabled={revoke.isPending} onClick={closeRevoke} className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50">Отмена</button><button type="button" disabled={revoke.isPending} onClick={handleRevoke} className="rounded-lg bg-danger px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{revoke.isPending ? "Отзываем…" : "Отозвать ключ"}</button></div>
    </ModalShell>}
  </>;
}

export function CreateAgentKeyModal({ create, onClose, onIssued }: {
  create: ReturnType<typeof useCreateAgentKey>;
  onClose: () => void;
  onIssued: (token: string, name: string) => void;
}) {
  const pagesQuery = useAdminPages({ suppressGlobalError: true });
  const pages = pagesQuery.data;
  const [name, setName] = useState("");
  const [capabilities, setCapabilities] = useState<AgentCapability[]>([]);
  const [pageLabels, setPageLabels] = useState<string[]>([]);
  const [pageQuery, setPageQuery] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("90");
  const [dailyRequestBudget, setDailyRequestBudget] = useState("5000");
  const [dailyRowBudget, setDailyRowBudget] = useState("500000");
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const pending = submitting || create.isPending;
  const parsed = agentKeyCreateBodySchema.safeParse({ name: name.trim(), capabilities, pageLabels, expiresInDays: Number(expiresInDays), dailyRequestBudget: Number(dailyRequestBudget), dailyRowBudget: Number(dailyRowBudget) });
  const invalidLifetime = !Number.isInteger(Number(expiresInDays)) || Number(expiresInDays) < 1 || Number(expiresInDays) > 365;
  const invalidRequests = !Number.isInteger(Number(dailyRequestBudget)) || Number(dailyRequestBudget) < 1 || Number(dailyRequestBudget) > 1_000_000;
  const invalidRows = !Number.isInteger(Number(dailyRowBudget)) || Number(dailyRowBudget) < 1 || Number(dailyRowBudget) > 100_000_000;
  const missingPages = pageLabels.filter((label) => !pages?.some((page) => page.label === label));
  const canSubmit = parsed.success && !invalidLifetime && pages !== undefined && missingPages.length === 0 && !pending;
  const visiblePages = (pages ?? []).filter((page) => `${page.label} ${page.modelName} ${page.platform}`.toLocaleLowerCase().includes(pageQuery.trim().toLocaleLowerCase()));
  function toggle<T>(list: T[], value: T) { return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]; }
  function requestClose() { if (!inFlight.current && !create.isPending) onClose(); }
  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || !parsed.success || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setSubmitError("");
    try {
      const result = await create.mutateAsync(parsed.data);
      onIssued(result.token, result.key.name);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Не удалось выдать ключ");
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }
  return <ModalShell title="Выдать ключ агенту" onClose={requestClose} closeDisabled={pending} closeLabel="Закрыть">
    <form onSubmit={handleSubmit} aria-busy={pending}>
      <fieldset disabled={pending} className="space-y-4">
        <Field label="Название задачи или агента"><input required maxLength={200} value={name} onChange={(event) => setName(event.target.value)} placeholder="Например, проверка кастомов" className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm" /></Field>
        <fieldset><legend className="mb-2 text-sm font-semibold text-text-secondary">Разрешённые возможности</legend><p className="mb-2 text-xs text-text-muted">Выберите хотя бы одну возможность.</p><div className="space-y-2">{AGENT_CAPABILITIES.map((capability) => <label key={capability} className="flex items-start gap-2 rounded-lg border border-border p-2 text-sm"><input type="checkbox" checked={capabilities.includes(capability)} onChange={() => setCapabilities((current) => toggle(current, capability))} className="mt-1" /><span><span className="block">{CAPABILITY_HELP[capability]}</span><code className="text-xs text-text-muted">{capability}</code></span></label>)}</div></fieldset>
        <fieldset><legend className="mb-2 text-sm font-semibold text-text-secondary">Страницы — только выбранные ({pageLabels.length}/200)</legend>
          <QueryNotice error={pagesQuery.isError} stale={pages !== undefined} retry={pagesQuery.refetch} />
          {!pages && !pagesQuery.isError && <p role="status" className="text-sm text-text-muted">Загружаем доступные страницы…</p>}
          {pages?.length === 0 && <p className="text-sm text-text-muted">В каталоге нет страниц для выдачи доступа.</p>}
          <input type="search" aria-label="Найти страницу для ключа" value={pageQuery} onChange={(event) => setPageQuery(event.target.value)} placeholder="Найти страницу или модель" className="mb-2 min-h-10 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm" />
          <div className="max-h-48 space-y-1 overflow-y-auto">{visiblePages.map((page) => <label key={page.id} className="flex items-start gap-2 rounded py-1 text-sm"><input type="checkbox" checked={pageLabels.includes(page.label)} disabled={pageLabels.length >= 200 && !pageLabels.includes(page.label)} onChange={() => setPageLabels((current) => toggle(current, page.label))} className="mt-1" /><span className="min-w-0 break-all">{page.label}<span className="block text-xs text-text-muted">{page.modelName} · {page.platform}</span></span></label>)}</div>
          {pages && pageQuery && visiblePages.length === 0 && <p className="text-xs text-text-muted">Страницы не найдены. Измените запрос; уже выбранные страницы сохранены ниже.</p>}
          {pageLabels.length > 0 && <div className="mt-3"><p className="mb-1 text-xs text-text-muted">В выдачу войдут:</p><div className="flex flex-wrap gap-1">{pageLabels.map((label) => <button key={label} type="button" aria-label={`Убрать ${label} из ключа`} onClick={() => setPageLabels((current) => toggle(current, label))} className="min-h-8 max-w-full break-all rounded border border-border px-2 py-1 text-xs">{label} ×</button>)}</div></div>}
          {missingPages.length > 0 && <p role="alert" className="mt-2 break-words text-xs text-danger">Выбранные страницы отсутствуют в каталоге: {missingPages.join(", ")}. Обновите список или уберите их из выбора.</p>}
        </fieldset>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Срок, дней"><input type="number" required min={1} max={365} step={1} value={expiresInDays} onChange={(event) => setExpiresInDays(event.target.value)} className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm" />{invalidLifetime && <p className="mt-1 text-xs text-danger">Целое число от 1 до 365.</p>}</Field>
          <Field label="Запросов в сутки"><input type="number" required min={1} max={1_000_000} step={1} value={dailyRequestBudget} onChange={(event) => setDailyRequestBudget(event.target.value)} className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm" /><span className={`text-xs ${invalidRequests ? "text-danger" : "text-text-muted"}`}>Целое число: 1–1 000 000</span></Field>
          <Field label="Строк в сутки"><input type="number" required min={1} max={100_000_000} step={1} value={dailyRowBudget} onChange={(event) => setDailyRowBudget(event.target.value)} className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm" /><span className={`text-xs ${invalidRows ? "text-danger" : "text-text-muted"}`}>Целое число: 1–100 000 000</span></Field>
        </div>
        <p className="text-xs text-text-muted">После выдачи сохраните секретный ключ: сервер вернёт его только один раз. Выдача не добавляет агенту роль сотрудника.</p>
      </fieldset>
      {submitError && <p role="alert" className="mt-4 break-words rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">{submitError}</p>}
      <div className="mt-6 flex flex-wrap justify-end gap-2"><button type="button" onClick={requestClose} disabled={pending} className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50">Отмена</button><button type="submit" disabled={!canSubmit} className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{pending ? "Выдаём…" : "Выдать ключ"}</button></div>
    </form>
  </ModalShell>;
}

export function TokenRevealModal({ token, name, onClose }: { token: string; name: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setCopyError("");
    } catch {
      setCopyError("Буфер обмена недоступен. Выделите ключ и скопируйте его вручную.");
    }
  }
  return <ModalShell title={`Ключ «${name}»`} onClose={onClose} closeDisabled={!copied} closeLabel="Закрыть">
    <p className="mb-4 text-sm font-medium text-warning-dark">Сохраните ключ перед закрытием. Сервер хранит только его хеш; повторно показать секрет после закрытия нельзя.</p>
    <Field label="Секретный ключ"><textarea readOnly rows={3} value={token} onFocus={(event) => event.target.select()} className="w-full break-all rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm" /></Field>
    <button type="button" onClick={handleCopy} className="mt-3 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white">{copied ? "Скопировано" : "Скопировать ключ"}</button>
    {copyError && <p role="alert" className="mt-2 text-sm text-danger">{copyError}</p>}
    <p className="mt-4 break-words text-xs text-text-muted">Для Hub CLI сохраните ключ в HUB_AGENT_KEY или ~/.config/hub/credentials.</p>
    <div className="mt-6 flex justify-end"><button type="button" onClick={onClose} className="rounded-lg border border-border px-3 py-2 text-sm">Ключ сохранён — закрыть</button></div>
  </ModalShell>;
}
