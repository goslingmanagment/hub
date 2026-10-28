import { Fragment, useState } from "react";
import type {
  AdminAiReconciliationImportResponse,
  AdminAiReconciliationResponse,
  AdminAiReconciliationRow,
} from "@agency_hub_core/contracts";

import {
  useAdminAiReconciliation,
  useAdminAiReconciliationImport,
  useAdminAiReconciliationKey,
} from "@/api/adminAiAccounts";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";

const PERIODS = [7, 14, 31] as const;

function usd(microUsd: number): string {
  const value = Math.abs(microUsd) / 1_000_000;
  const sign = microUsd < 0 ? "−" : "";
  if (microUsd !== 0 && value < 0.01) {
    return `${sign}< $0.01`;
  }
  return `${sign}$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedUsd(microUsd: number): string {
  return microUsd > 0 ? `+${usd(microUsd)}` : usd(microUsd);
}

function percent(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${String(Math.abs(value)).replace(".", ",")}%`;
}

function tokens(value: number): string {
  return value.toLocaleString("ru-RU");
}

function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "short", weekday: "short", timeZone: "UTC" });
}

function dateTime(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Не удалось";
}

type Org = AdminAiReconciliationResponse["orgs"][number];
type Account = AdminAiReconciliationResponse["accounts"][number];

const STATUS: Record<AdminAiReconciliationRow["status"], { label: string; className: string; title: string }> = {
  ok: { label: "сходится", className: "badge badge-success", title: "Разница в пределах 1% (или меньше цента)" },
  mismatch: { label: "расходится", className: "badge badge-danger", title: "Разница больше 1%: откройте разбор по моделям" },
  open: { label: "досчитывается", className: "badge", title: "Сегодня и вчера Anthropic ещё досчитывает: цифры могут вырасти" },
  unmapped: {
    label: "ключ не решён",
    className: "badge badge-warning",
    title: "В организации аккаунта в этот день тратил ключ, о котором не решено, чей он: отметьте его в «Ключах» ниже",
  },
  no_source: { label: "нет данных Anthropic", className: "badge", title: "Для аккаунта нет ни CSV, ни admin-ключа" },
  not_synced: { label: "нет данных за день", className: "badge", title: "Ни CSV, ни отчёт Anthropic не покрывают этот день" },
};

const OTHER_KIND: Record<AdminAiReconciliationResponse["otherKeys"][number]["kind"], string> = {
  key: "не хаб:",
  console: "консоль (без ключа)",
  unknown: "ключ не решён:",
  unsplit: "не разнесено по ключам",
};

/** «Ключ хаба» for an organization with one account; a choice among its
 * accounts otherwise. */
function KeyOwnerControl({
  orgId,
  apiKeyId,
  accountId,
  candidates,
  onChanged,
}: {
  orgId: string;
  apiKeyId: string;
  accountId: number | null;
  candidates: Account[];
  onChanged?: (accountId: number | null) => void;
}) {
  const update = useAdminAiReconciliationKey();
  const save = (next: number | null) => update.mutate({ orgId, apiKeyId, accountId: next }, { onSuccess: () => onChanged?.(next) });
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      {candidates.length === 1 ? (
        <label className="inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={accountId === candidates[0]!.id}
            disabled={update.isPending}
            onChange={(event) => save(event.target.checked ? candidates[0]!.id : null)}
          />
          ключ хаба
        </label>
      ) : (
        <select
          className="select w-auto"
          aria-label={`Чей ключ ${apiKeyId}`}
          value={accountId ?? ""}
          disabled={update.isPending}
          onChange={(event) => save(event.target.value === "" ? null : Number(event.target.value))}
        >
          <option value="">не хаб</option>
          {candidates.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}
        </select>
      )}
      {update.isError && <span className="text-xs text-danger">{errorText(update.error)}</span>}
    </span>
  );
}

/** The owner's Cost CSV: pick the account, pick the file; then each key the
 * file names, its dollars, and whose it is. */
function CsvImport({ accounts }: { accounts: Account[] }) {
  const upload = useAdminAiReconciliationImport();
  const [accountId, setAccountId] = useState<number | null>(accounts[0]?.id ?? null);
  const [result, setResult] = useState<AdminAiReconciliationImportResponse | null>(null);
  const account = accounts.find((candidate) => candidate.id === accountId) ?? null;

  return (
    <div className="mx-4 mt-3 rounded-lg border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span>CSV со страницы Cost консоли Anthropic для аккаунта</span>
        <select
          className="select w-auto"
          aria-label="Аккаунт, чей это CSV"
          value={accountId ?? ""}
          onChange={(event) => {
            setAccountId(Number(event.target.value));
            setResult(null);
          }}
        >
          {accounts.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
        </select>
        <label className={`btn btn-sm ${upload.isPending || !account ? "pointer-events-none opacity-45" : "cursor-pointer"}`}>
          {upload.isPending ? "Загружаю…" : "Выбрать файл"}
          <input
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            disabled={upload.isPending || !account}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file || !account) return;
              setResult(null);
              void file.text().then((csv) => upload.mutate(
                { accountId: account.id, fileName: file.name, csv },
                { onSuccess: setResult },
              ));
            }}
          />
        </label>
      </div>
      <p className="mt-1 text-xs text-text-muted">
        Дни файла заменяют прежние данные этой организации. Ключ с именем «hub» считается ключом хаба, остальные — нет, пока вы не отметите иначе.
      </p>
      {upload.isError && <div role="alert" className="notice notice-warning mt-2">{errorText(upload.error)}</div>}
      {result && (
        <div className="mt-2">
          <p className="text-xs">
            Загружен «{result.fileName ?? "CSV"}» для <span className="font-medium">{result.label}</span>: {shortDay(result.periodFrom)} – {shortDay(result.periodTo)}
            {" "}({result.days} дн.), всего {usd(result.microUsd)}. Организация {result.orgId}.
          </p>
          <table className="mt-1 w-full text-xs">
            <thead>
              <tr className="text-text-muted">
                <th className="py-1 text-left font-normal">Ключ</th>
                <th className="py-1 text-left font-normal">id</th>
                <th className="num font-normal">$ в файле</th>
                <th className="py-1 text-left font-normal" />
              </tr>
            </thead>
            <tbody>
              {result.keys.map((key) => (
                <tr key={key.apiKeyId ?? "console"}>
                  <td className="py-1 font-medium">{key.name ?? "—"}</td>
                  <td className="text-text-muted">{key.apiKeyId ?? "консоль"}</td>
                  <td className="num">{usd(key.microUsd)}</td>
                  <td className="pl-3">
                    {key.apiKeyId === null ? <span className="text-text-muted">не хаб</span> : (
                      <KeyOwnerControl
                        orgId={result.orgId}
                        apiKeyId={key.apiKeyId}
                        accountId={key.accountId}
                        candidates={[{ id: result.accountId, label: result.label }]}
                        onChanged={(next) => setResult({
                          ...result,
                          keys: result.keys.map((entry) => entry.apiKeyId === key.apiKeyId ? { ...entry, accountId: next, source: "owner" } : entry),
                        })}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Where each organization's Anthropic data came from, and its keys. */
function OrgSources({ data }: { data: AdminAiReconciliationResponse }) {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const labelsOf = (org: Org) => org.accountIds
    .map((id) => data.accounts.find((account) => account.id === id)?.label)
    .filter(Boolean)
    .join(", ") || "без аккаунта";
  return (
    <ul className="space-y-1 px-4 pt-3 text-xs text-text-muted">
      {data.orgs.map((org) => {
        const candidates = org.accountIds.length > 0
          ? data.accounts.filter((account) => org.accountIds.includes(account.id))
          : data.accounts;
        const undecided = org.keys.filter((key) => !key.decided).length;
        const stale = org.source?.periodTo && org.source.periodTo < yesterday;
        return (
          <li key={org.orgId}>
            <span className="font-medium text-text-primary">{labelsOf(org)}</span>
            {org.orgName && ` · ${org.orgName}`}
            {" · "}
            {!org.source && "данных Anthropic нет"}
            {org.source?.kind === "csv" && (
              <span className={stale ? "text-warning-dark" : undefined}>
                CSV «{org.source.fileName ?? "файл"}» за {shortDay(org.source.periodFrom!)} – {shortDay(org.source.periodTo!)}
                {stale && org.source.periodTo !== today && ` (после ${shortDay(org.source.periodTo!)} данных нет)`}
                , загружен {dateTime(org.source.at)}
              </span>
            )}
            {org.source?.kind === "admin_api" && `отчёт Admin API прочитан ${dateTime(org.source.at)}`}
            {org.keys.length > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer">
                  Ключи ({org.keys.length}){undecided > 0 && <span className="text-warning-dark"> · не решено: {undecided}</span>}
                </summary>
                <table className="mt-1 text-xs">
                  <tbody>
                    {org.keys.map((key) => (
                      <tr key={key.apiKeyId}>
                        <td className="py-0.5 pr-3 font-medium text-text-primary">{key.name ?? "—"}</td>
                        <td className="pr-3">{key.apiKeyId}{key.hint && ` · ${key.hint}`}</td>
                        <td className="num pr-3">{usd(key.providerMicroUsd)}</td>
                        <td className="pr-3">
                          <KeyOwnerControl orgId={org.orgId} apiKeyId={key.apiKeyId} accountId={key.decided ? key.accountId : null} candidates={candidates} />
                        </td>
                        <td>
                          {!key.decided && <span className="badge badge-warning">не решено{key.source === "guess" && key.label ? `, похоже на ${key.label}` : ""}</span>}
                          {key.decided && key.source !== "owner" && <span>{key.source === "name" ? "по имени" : "по подсказке ключа"}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
          </li>
        );
      })}
      {data.syncs.filter((sync) => sync.lastError && sync.lastErrorAt).map((sync) => (
        <li key={sync.labels.join(",")} className="text-danger">
          {sync.labels.join(", ")}: ошибка Admin API {dateTime(sync.lastErrorAt!)}: {sync.lastError}
        </li>
      ))}
    </ul>
  );
}

/** The 1-hour share of the cache writes: billed at 2× input, the 5-minute at 1.25×. */
function CacheWrite1h({ tokens: side }: { tokens: { cacheWrite1hTokens: number | null } | null }) {
  if (!side) return null;
  if (side.cacheWrite1hTokens === null) {
    return <div className="text-text-muted" title="Строки хаба до 28.10 не делят запись кэша на 5 мин и 1 ч">без деления на 5 мин / 1 ч</div>;
  }
  return side.cacheWrite1hTokens > 0 ? <div className="text-text-muted">из них на 1 ч: {tokens(side.cacheWrite1hTokens)}</div> : null;
}

function ModelBreakdown({ row }: { row: AdminAiReconciliationRow }) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-text-muted">
          <th className="py-1 text-left font-normal">Модель</th>
          <th className="py-1 text-left font-normal" />
          <th className="num font-normal">Запросы</th>
          <th className="num font-normal">Вход</th>
          <th className="num font-normal">Кэш, чтение</th>
          <th className="num font-normal">Кэш, запись</th>
          <th className="num font-normal">Выход</th>
          <th className="num font-normal">$</th>
        </tr>
      </thead>
      <tbody>
        {row.models.map((model) => (
          <Fragment key={model.model}>
            <tr>
              <td rowSpan={2} className="py-1 align-top font-medium">{model.model || "прочее (поиск, код)"}</td>
              <td className="text-text-muted">хаб</td>
              <td className="num">{model.hub ? tokens(model.hub.requests) : "—"}</td>
              <td className="num">{model.hub ? tokens(model.hub.inputTokens) : "—"}</td>
              <td className="num">{model.hub ? tokens(model.hub.cacheReadTokens) : "—"}</td>
              <td className="num">
                {model.hub ? tokens(model.hub.cacheWriteTokens) : "—"}
                <CacheWrite1h tokens={model.hub} />
              </td>
              <td className="num">{model.hub ? tokens(model.hub.outputTokens) : "—"}</td>
              <td className="num">{model.hub ? usd(model.hub.costMicroUsd) : "—"}</td>
            </tr>
            <tr>
              <td className="text-text-muted" title={row.providerTokensEstimated ? "Токены оценены по долларам из CSV и ценам хаба: в файле их нет" : undefined}>
                {row.providerTokensEstimated ? "Anthropic ≈" : "Anthropic"}
              </td>
              <td className="num">{model.provider?.webSearchRequests ? `поиск ${tokens(model.provider.webSearchRequests)}` : ""}</td>
              <td className="num">{model.provider ? tokens(model.provider.inputTokens) : "—"}</td>
              <td className="num">{model.provider ? tokens(model.provider.cacheReadTokens) : "—"}</td>
              <td className="num">
                {model.provider ? tokens(model.provider.cacheWriteTokens) : "—"}
                <CacheWrite1h tokens={model.provider} />
              </td>
              <td className="num">{model.provider ? tokens(model.provider.outputTokens) : "—"}</td>
              <td className="num">{model.provider ? usd(model.provider.costMicroUsd) : "—"}</td>
            </tr>
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

/** Hub's own spend against what Anthropic billed, account by account, day by day. */
export function AiReconciliationSection() {
  const [days, setDays] = useState<(typeof PERIODS)[number]>(14);
  const { data, isLoading, isError, refetch, isFetching } = useAdminAiReconciliation(days);
  const [open, setOpen] = useState<string | null>(null);

  let content;
  if (isLoading) {
    content = <TableSkeleton rows={4} columns={7} />;
  } else if (isError && !data) {
    content = (
      <StatusPanel
        title="Не удалось загрузить сверку"
        description="Сервер не ответил."
        tone="error"
        action={<button type="button" className="btn btn-sm" onClick={() => void refetch()} disabled={isFetching}>Повторить</button>}
      />
    );
  } else if (!data || !data.configured) {
    content = (
      <>
        {data && data.accounts.length > 0 && <CsvImport accounts={data.accounts} />}
        <p className="muted px-4 py-6 text-sm">
          Данных Anthropic пока нет: загрузите CSV со страницы Cost консоли Anthropic (выгрузка за нужные дни) или задайте на
          сервере ANTHROPIC_ADMIN_KEYS.
        </p>
      </>
    );
  } else {
    const shownDays = [...new Set([
      ...data.rows.map((row) => row.day),
      ...data.otherKeys.map((line) => line.day),
      ...data.hubUnattributed.map((line) => line.day),
    ])].sort().reverse();
    content = (
      <>
        <CsvImport accounts={data.accounts} />
        <OrgSources data={data} />
        {shownDays.length === 0 ? (
          <p className="muted px-4 py-6 text-sm">За {days} дней ни хаб, ни Anthropic трат не видели.</p>
        ) : (
          <div className="overflow-x-auto" tabIndex={0}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>День (UTC)</th>
                  <th>Аккаунт</th>
                  <th className="num">Хаб</th>
                  <th className="num">Anthropic</th>
                  <th className="num">Разница</th>
                  <th className="num">%</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {shownDays.map((day) => {
                  const rows = data.rows.filter((row) => row.day === day);
                  const others = data.otherKeys.filter((line) => line.day === day);
                  const unattributed = data.hubUnattributed.find((line) => line.day === day);
                  return (
                    <Fragment key={day}>
                      {rows.map((row, index) => {
                        const key = `${row.day}|${row.accountId}`;
                        const status = STATUS[row.status];
                        return (
                          <Fragment key={key}>
                            <tr>
                              <td className="whitespace-nowrap">{index === 0 ? dayLabel(day) : ""}</td>
                              <td>
                                <span className="font-medium">{row.label}</span>
                                {row.split && (
                                  <span
                                    className="ml-1 text-xs text-text-muted"
                                    title="В организации в этот день тратили несколько ключей: счёт Anthropic поделён между ними по токенам, оценённым ценами хаба"
                                  >
                                    доля счёта
                                  </span>
                                )}
                              </td>
                              <td className="num">{usd(row.hubMicroUsd)}</td>
                              <td className="num" title={row.source === "csv" ? "из CSV консоли" : row.source === "admin_api" ? "из отчёта Admin API" : undefined}>
                                {row.providerMicroUsd === null ? "—" : usd(row.providerMicroUsd)}
                                {row.unmappedMicroUsd !== 0 && (
                                  <div className="text-xs text-warning-dark">+ ? {usd(row.unmappedMicroUsd)} ключа без решения</div>
                                )}
                              </td>
                              <td className={`num ${row.status === "mismatch" ? "text-danger" : ""}`}>
                                {row.diffMicroUsd === null ? "—" : signedUsd(row.diffMicroUsd)}
                              </td>
                              <td className={`num ${row.status === "mismatch" ? "text-danger" : ""}`}>
                                {row.diffPct === null ? "—" : percent(row.diffPct)}
                              </td>
                              <td className="whitespace-nowrap">
                                <span className={status.className} title={status.title}>{status.label}</span>
                                {row.models.length > 0 && (
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-ghost ml-1"
                                    aria-expanded={open === key}
                                    onClick={() => setOpen(open === key ? null : key)}
                                  >
                                    {open === key ? "скрыть" : "по моделям"}
                                  </button>
                                )}
                              </td>
                            </tr>
                            {open === key && (
                              <tr>
                                <td />
                                <td colSpan={6} className="bg-hover">
                                  <ModelBreakdown row={row} />
                                  <p className="pt-1 text-xs text-text-muted">
                                    Токены сходятся, а доллары нет — хаб считает по другой цене (например, запись кэша на 1 час дороже, чем на 5 минут).
                                    Токены не сходятся — в учёте хаба не хватает запросов или есть лишние.
                                  </p>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                      {others.map((line, index) => (
                        <tr key={`${day}|${line.orgId}|${line.kind}|${line.apiKeyId ?? ""}`} className="text-text-muted">
                          <td className="whitespace-nowrap">{rows.length === 0 && index === 0 ? dayLabel(day) : ""}</td>
                          <td title={line.orgName ?? line.orgId}>
                            {OTHER_KIND[line.kind]}
                            {(line.kind === "key" || line.kind === "unknown") && ` «${line.keyName ?? line.apiKeyId}»`}
                            {line.keyHint && <span className="ml-1 text-xs">{line.keyHint}</span>}
                          </td>
                          <td className="num">—</td>
                          <td className="num">{usd(line.providerMicroUsd)}</td>
                          <td className="num" />
                          <td className="num" />
                          <td>
                            {line.kind === "unknown" ? (
                              <span className="badge badge-warning" title="Не решено, чей это ключ: отметьте его в «Ключах» выше">не решено</span>
                            ) : (
                              <span className="badge" title="Эти траты не прошли через хаб: в его учёте их нет">вне хаба</span>
                            )}
                          </td>
                        </tr>
                      ))}
                      {unattributed && (
                        <tr className="text-text-muted">
                          <td className="whitespace-nowrap">{rows.length === 0 && others.length === 0 ? dayLabel(day) : ""}</td>
                          <td title="Запросы хаба к Anthropic, где аккаунт не записан (до того, как хаб начал его отмечать)">хаб без аккаунта</td>
                          <td className="num">{usd(unattributed.hubMicroUsd)}</td>
                          <td className="num">—</td>
                          <td className="num" />
                          <td className="num" />
                          <td />
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </>
    );
  }

  return (
    <section aria-labelledby="ai-reconciliation-title" className="card">
      <div className="card-header">
        <div className="min-w-0">
          <h2 id="ai-reconciliation-title" className="card-title">Сверка с Anthropic</h2>
          <p className="card-description">
            Траты хаба по его расчёту против счёта Anthropic за каждые сутки UTC. Сходится — разница в пределах 1%.
            Данные Anthropic — из CSV страницы Cost или из отчётов Admin API; сегодня и вчера Anthropic ещё досчитывает.
          </p>
        </div>
        <select
          className="select w-auto"
          aria-label="Период сверки"
          value={days}
          onChange={(event) => setDays(Number(event.target.value) as (typeof PERIODS)[number])}
        >
          {PERIODS.map((period) => <option key={period} value={period}>{period} дней</option>)}
        </select>
      </div>
      {content}
    </section>
  );
}
