import { Fragment, useState } from "react";
import type { AdminAiReconciliationResponse, AdminAiReconciliationRow } from "@agency_hub_core/contracts";

import { useAdminAiReconciliation } from "@/api/adminAiAccounts";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";

const DAYS = 14;

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

const STATUS: Record<AdminAiReconciliationRow["status"], { label: string; className: string; title: string }> = {
  ok: { label: "сходится", className: "badge badge-success", title: "Разница в пределах 1% (или меньше цента)" },
  mismatch: { label: "расходится", className: "badge badge-danger", title: "Разница больше 1%: откройте разбор по моделям" },
  open: { label: "досчитывается", className: "badge", title: "Сегодня и вчера Anthropic ещё досчитывает: цифры могут вырасти" },
  no_admin_key: { label: "нет admin-ключа", className: "badge badge-warning", title: "У аккаунта нет ключа в ANTHROPIC_ADMIN_KEYS" },
  not_synced: { label: "нет данных", className: "badge", title: "Отчёт Anthropic за этот день ещё не прочитан" },
};

const OTHER_KIND: Record<AdminAiReconciliationResponse["otherKeys"][number]["kind"], string> = {
  key: "другой ключ",
  console: "консоль (без ключа)",
  unsplit: "не разнесено по ключам",
};

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
              <td className="text-text-muted">Anthropic</td>
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
  const { data, isLoading, isError, refetch, isFetching } = useAdminAiReconciliation(DAYS);
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
      <p className="muted px-4 py-6 text-sm">
        Нужен admin-ключ: сверять не с чем, пока на сервере не задан ANTHROPIC_ADMIN_KEYS
        (<code>label=sk-ant-admin…</code> под теми же метками, что ANTHROPIC_API_KEYS; аккаунты одной организации делят один ключ).
      </p>
    );
  } else {
    const days = [...new Set([...data.rows.map((row) => row.day), ...data.otherKeys.map((line) => line.day)])].sort().reverse();
    content = (
      <>
        <ul className="space-y-1 px-4 pt-3 text-xs text-text-muted">
          {data.syncs.map((sync) => (
            <li key={sync.labels.join(",")}>
              <span className="font-medium text-text-primary">{sync.labels.join(", ")}</span>
              {sync.orgName && ` · ${sync.orgName}`}
              {sync.lastSuccessAt ? ` · отчёт Anthropic прочитан ${dateTime(sync.lastSuccessAt)}` : " · отчёт ещё не прочитан"}
              {sync.lastError && sync.lastErrorAt && (
                <span className="text-danger"> · ошибка {dateTime(sync.lastErrorAt)}: {sync.lastError}</span>
              )}
            </li>
          ))}
        </ul>
        {days.length === 0 ? (
          <p className="muted px-4 py-6 text-sm">За {DAYS} дней ни хаб, ни Anthropic трат не видели.</p>
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
                {days.map((day) => {
                  const rows = data.rows.filter((row) => row.day === day);
                  const others = data.otherKeys.filter((line) => line.day === day);
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
                              <td className="num">{row.providerMicroUsd === null ? "—" : usd(row.providerMicroUsd)}</td>
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
                            {line.kind === "key" && ` «${line.keyName ?? line.apiKeyId}»`}
                            {line.keyHint && <span className="ml-1 text-xs">{line.keyHint}</span>}
                          </td>
                          <td className="num">—</td>
                          <td className="num">{usd(line.providerMicroUsd)}</td>
                          <td className="num" />
                          <td className="num" />
                          <td>
                            <span className="badge" title="Эти траты не прошли через хаб: в его учёте их нет">вне хаба</span>
                          </td>
                        </tr>
                      ))}
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
            Траты хаба по его расчёту против счёта Anthropic за каждые сутки UTC, за {DAYS} дней. Сходится — разница в пределах 1%.
            Хаб читает отчёты Anthropic раз в час; сегодня и вчера Anthropic ещё досчитывает.
          </p>
        </div>
      </div>
      {content}
    </section>
  );
}
