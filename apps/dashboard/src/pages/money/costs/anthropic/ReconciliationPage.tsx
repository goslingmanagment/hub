import { Fragment, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import type {
  AdminAiReconciliationImportResponse,
  AdminAiReconciliationResponse,
  AdminAiReconciliationRow,
} from "@agency_hub_core/contracts";
import { useAdminAiReconciliation, useAdminAiReconciliationImport, useAdminAiReconciliationKey } from "@/api/adminAiAccounts";
import { KernelApiError } from "@/api/sdk";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { NoAnswerPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { DisclosureCard } from "@/components/ui/DisclosureCard";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatAiUsd, formatCount, formatDateTime } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import { ANTHROPIC_RECONCILIATION_STATUS } from "@/lib/statusWords";

type Data = AdminAiReconciliationResponse;
type Org = Data["orgs"][number];
type Account = Data["accounts"][number];
const DAYS = [7, 14, 31] as const;
type Days = (typeof DAYS)[number];

const STATUS_HINT: Record<AdminAiReconciliationRow["status"], string> = {
  ok: "Разница в пределах 1 % или меньше цента",
  mismatch: "Разница больше 1 %: откройте разбор по моделям",
  open: "Сегодня и вчера Anthropic ещё досчитывает: цифры могут вырасти",
  unmapped: "В организации счёта в этот день тратил ключ, о котором не решено, чей он: отметьте его в «Откуда данные»",
  no_source: "Для счёта нет ни CSV, ни отчёта Anthropic",
  not_synced: "Ни CSV, ни отчёт Anthropic не покрывают этот день",
};

const OTHER_KIND: Record<Data["otherKeys"][number]["kind"], string> = {
  key: "Не Hub:",
  console: "Консоль, без ключа",
  unknown: "Ключ не решён:",
  unsplit: "Не разнесено по ключам",
};

const UTC_DAY = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });
const UTC_WEEKDAY = new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: "UTC" });
const shortDay = (day: string) => UTC_DAY.format(new Date(`${day}T00:00:00Z`));
const dayLabel = (day: string) => `${UTC_WEEKDAY.format(new Date(`${day}T00:00:00Z`))}, ${shortDay(day)}`;

function signedUsd(microUsd: number): string {
  return microUsd > 0 ? `+${formatAiUsd(microUsd)}` : formatAiUsd(microUsd);
}

/** «+0,3 %»: one decimal, the share is small. */
function percent(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  const shown = Math.abs(value) >= 10 ? Math.round(Math.abs(value)) : Math.round(Math.abs(value) * 10) / 10;
  return `${sign}${String(shown).replace(".", ",")} %`;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function daysWord(days: number) {
  return `${days} ${ruPlural(days, "день", "дня", "дней")}`;
}

/** «Ключ Hub» for an organization with one account; a choice among its accounts otherwise. The write as it was. */
function KeyOwnerControl({ orgId, apiKeyId, accountId, candidates, onChanged }: {
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
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={accountId === candidates[0]!.id}
            disabled={update.isPending}
            onChange={(event) => save(event.target.checked ? candidates[0]!.id : null)}
          />
          Ключ Hub
        </label>
      ) : (
        <select
          className="select w-auto"
          aria-label={`Чей ключ ${apiKeyId}`}
          value={accountId ?? ""}
          disabled={update.isPending}
          onChange={(event) => save(event.target.value === "" ? null : Number(event.target.value))}
        >
          <option value="">не Hub</option>
          {candidates.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}
        </select>
      )}
      {update.isError && <span className="ai-warn text-sm">Не сохранилось: {errorText(update.error)}</span>}
    </span>
  );
}

/** What a stale CSV leaves unchecked: one notice, accounts by comma. */
function staleOrgs(data: Data): { labels: string; until: string } | null {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const stale = data.orgs.filter((org) => org.source?.kind === "csv" && org.source.periodTo && org.source.periodTo < yesterday);
  if (stale.length === 0) return null;
  const labels = stale.map((org) => labelsOf(data, org)).join(", ");
  const until = stale.map((org) => org.source!.periodTo!).sort()[0]!;
  return { labels, until: shortDay(until) };
}

function labelsOf(data: Data, org: Org): string {
  return org.accountIds.map((id) => data.accounts.find((account) => account.id === id)?.label).filter(Boolean).join(", ") || "без счёта";
}

function sourceText(org: Org): string {
  if (!org.source) return "данных Anthropic нет";
  if (org.source.kind === "admin_api") return `отчёт Anthropic прочитан ${formatDateTime(org.source.at)}`;
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const period = org.source.periodFrom && org.source.periodTo ? ` за ${shortDay(org.source.periodFrom)} – ${shortDay(org.source.periodTo)}` : "";
  const stale = org.source.periodTo && org.source.periodTo < yesterday ? `, после ${shortDay(org.source.periodTo)} данных нет` : "";
  return `CSV «${org.source.fileName ?? "файл"}»${period}, загружен ${formatDateTime(org.source.at)}${stale}`;
}

/** «Загрузить CSV»: the account is chosen by hand, the file is read, the window asks, then one request. */
function CsvUpload({ data }: { data: Data }) {
  const upload = useAdminAiReconciliationImport();
  const accounts = data.accounts;
  const [accountId, setAccountId] = useState<number | null>(accounts.length === 1 ? accounts[0]!.id : null);
  const [pending, setPending] = useState<{ account: Account; fileName: string; csv: string } | null>(null);
  const [result, setResult] = useState<AdminAiReconciliationImportResponse | null>(null);
  const [failure, setFailure] = useState<{ refused: boolean; text: string } | null>(null);
  const account = accounts.find((candidate) => candidate.id === accountId) ?? null;
  if (accounts.length === 0) return null;

  const orgOf = (target: Account) => data.orgs.find((org) => org.accountIds.includes(target.id)) ?? null;

  return (
    <section className="card" aria-labelledby="csv-title">
      <div className="card-header">
        <div className="min-w-0">
          <h2 id="csv-title" className="card-title">Загрузить CSV</h2>
          <p className="card-description">
            Со страницы Cost консоли Anthropic. Дни файла заменяют прежние данные этой организации. Ключ с именем «hub»
            считается ключом Hub, остальные — нет, пока вы не отметите иначе.
          </p>
        </div>
      </div>
      <div className="card-body space-y-4">
        <div className="tx-filters">
          <label className="tx-field">
            <span className="field-label">Счёт, чей это файл</span>
            <select
              className="select"
              value={accountId ?? ""}
              onChange={(event) => {
                setAccountId(event.target.value === "" ? null : Number(event.target.value));
                setResult(null);
                setFailure(null);
              }}
            >
              <option value="">Выберите счёт</option>
              {accounts.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
            </select>
          </label>
          <label className={`btn${upload.isPending || !account ? " is-disabled" : ""}`} aria-disabled={upload.isPending || !account}>
            {upload.isPending ? "Загружаем…" : "Выбрать файл"}
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
                setFailure(null);
                // The file is only read here; nothing is sent until the window says yes.
                void file.text().then((csv) => setPending({ account, fileName: file.name, csv }));
              }}
            />
          </label>
        </div>
        {failure && (
          <Notice tone="warning" role="alert" detail={failure.refused ? <Disclosure label="Подробнее"><p>{failure.text}</p></Disclosure> : undefined}>
            {failure.refused ? "Файл не принят. Прежние данные на месте." : "Не удалось загрузить: Hub не ответил. Исход неизвестен, проверьте дни в таблице."}
          </Notice>
        )}
        {result && (
          <div className="space-y-3">
            <Notice tone="success" role="status">
              Загружен «{result.fileName ?? "CSV"}» для {result.label}: {shortDay(result.periodFrom)} – {shortDay(result.periodTo)}, {daysWord(result.days)}, всего {formatAiUsd(result.microUsd)}.
            </Notice>
            <div className="ai-cut">
              <table className="data-table data-table-dense" aria-label="Ключи из файла">
                <thead>
                  <tr><th scope="col">Ключ</th><th scope="col">Номер</th><th scope="col" className="num">В файле</th><th scope="col">Чей ключ</th></tr>
                </thead>
                <tbody>
                  {result.keys.map((key) => (
                    <tr key={key.apiKeyId ?? "console"}>
                      <td className="font-medium">{key.name ?? "—"}</td>
                      <td className="muted">{key.apiKeyId ?? "консоль"}</td>
                      <td className="num">{formatAiUsd(key.microUsd)}</td>
                      <td>
                        {key.apiKeyId === null ? <span className="text-text-secondary">не Hub</span> : (
                          <KeyOwnerControl
                            orgId={result.orgId}
                            apiKeyId={key.apiKeyId}
                            accountId={key.accountId}
                            candidates={[{ id: result.accountId, label: result.label }]}
                            onChanged={(next) => setResult({
                              ...result,
                              keys: result.keys.map((entry) => (entry.apiKeyId === key.apiKeyId ? { ...entry, accountId: next, source: "owner" } : entry)),
                            })}
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Disclosure label="Подробнее"><p>Организация {result.orgId}.</p></Disclosure>
          </div>
        )}
      </div>
      {pending && (() => {
        const org = orgOf(pending.account);
        return (
          <ConfirmModal
            title={`Загрузить CSV для счёта ${pending.account.label}?`}
            message="Дни из файла заменят прежние данные этой организации Anthropic."
            facts={[
              { label: "Файл", value: pending.fileName },
              { label: "Куда", value: org?.orgName ? `${pending.account.label}, организация ${org.orgName}` : pending.account.label },
              { label: "Сейчас там", value: org?.source ? sourceText(org) : "Данных Anthropic нет" },
              { label: "Отменить", value: "Нельзя: прежние дни заменятся. Вернуть их можно, загрузив прежний файл" },
            ]}
            confirmLabel={`Загрузить в ${pending.account.label}`}
            pendingLabel="Загружаем…"
            tone="primary"
            initialFocus="cancel"
            isPending={upload.isPending}
            onConfirm={() => {
              // The same request as before, its account fixed when the file was chosen.
              upload.mutate(
                { accountId: pending.account.id, fileName: pending.fileName, csv: pending.csv },
                {
                  onSuccess: (answer) => setResult(answer),
                  onError: (cause) => setFailure({ refused: cause instanceof KernelApiError && (cause.status ?? 0) >= 400 && (cause.status ?? 0) < 500, text: errorText(cause) }),
                  onSettled: () => setPending(null),
                },
              );
            }}
            onClose={() => setPending(null)}
          />
        );
      })()}
    </section>
  );
}

function ModelBreakdown({ row }: { row: AdminAiReconciliationRow }) {
  const write1h = (side: { cacheWrite1hTokens: number | null } | null) => {
    if (!side) return null;
    if (side.cacheWrite1hTokens === null) return <div className="ai-sub" title="Строки Hub до 28 окт. не делят запись кэша на 5 мин и 1 ч">без деления на 5 мин и 1 ч</div>;
    return side.cacheWrite1hTokens > 0 ? <div className="ai-sub">из них на 1 ч: {formatCount(side.cacheWrite1hTokens)}</div> : null;
  };
  return (
    <div className="row-detail-body rc-models">
      <div className="row-detail-table">
        <table className="data-table data-table-dense" aria-label={`По моделям, ${row.label}`}>
          <thead>
            <tr>
              <th scope="col">Модель и источник</th>
              <th scope="col" className="num">Запросы</th>
              <th scope="col" className="num">Вход</th>
              <th scope="col" className="num">Кэш, чтение</th>
              <th scope="col" className="num">Кэш, запись</th>
              <th scope="col" className="num">Выход</th>
              <th scope="col" className="num">$</th>
            </tr>
          </thead>
          <tbody>
            {row.models.map((model) => (
              <Fragment key={model.model}>
                {([["Hub", model.hub], [row.providerTokensEstimated ? "Anthropic ≈" : "Anthropic", model.provider]] as const).map(([source, side], index) => (
                  <tr key={source} className={index === 1 ? "rc-pair" : undefined}>
                    <td>
                      {index === 0 && <div className="font-medium">{model.model || "прочее (поиск, код)"}</div>}
                      <div className="ai-sub" title={index === 1 && row.providerTokensEstimated ? "Токены оценены по долларам из CSV и ценам Hub: в файле их нет" : undefined}>{source}</div>
                    </td>
                    <td className="num">
                      {index === 0
                        ? side ? formatCount((side as NonNullable<typeof model.hub>).requests) : "—"
                        : model.provider?.webSearchRequests ? `поиск ${formatCount(model.provider.webSearchRequests)}` : ""}
                    </td>
                    <td className="num">{side ? formatCount(side.inputTokens) : "—"}</td>
                    <td className="num">{side ? formatCount(side.cacheReadTokens) : "—"}</td>
                    <td className="num">{side ? formatCount(side.cacheWriteTokens) : "—"}{write1h(side)}</td>
                    <td className="num">{side ? formatCount(side.outputTokens) : "—"}</td>
                    <td className="num">{side ? formatAiUsd(side.costMicroUsd) : "—"}</td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="row-detail-note">
        Токены сходятся, а доллары нет — Hub считает по другой цене (например, запись кэша на 1 час дороже, чем на 5
        минут). Токены не сходятся — в учёте Hub не хватает запросов или есть лишние.
      </p>
    </div>
  );
}

function DaysTable({ data, days }: { data: Data; days: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const shownDays = [...new Set([
    ...data.rows.map((row) => row.day),
    ...data.otherKeys.map((line) => line.day),
    ...data.hubUnattributed.map((line) => line.day),
  ])].sort().reverse();
  return (
    <section className="card" aria-labelledby="rc-days-title">
      <div className="card-header"><h2 id="rc-days-title" className="card-title">По дням</h2></div>
      {shownDays.length === 0 ? (
        <div className="card-body"><div className="empty"><p className="empty-title">За {daysWord(days)} ни Hub, ни Anthropic трат не видели.</p></div></div>
      ) : (
        <div className="table-wrap">
          <table className="data-table" aria-label="Сверка по дням">
            <thead>
              <tr>
                <th scope="col">День</th>
                <th scope="col">Счёт</th>
                <th scope="col" className="num">Hub</th>
                <th scope="col" className="num">Anthropic</th>
                <th scope="col" className="num">Разница</th>
                <th scope="col" className="num">%</th>
                <th scope="col">Статус</th>
                <th scope="col"><span className="sr-only">По моделям</span></th>
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
                      const word = ANTHROPIC_RECONCILIATION_STATUS[row.status];
                      const mismatch = row.status === "mismatch";
                      return (
                        <Fragment key={key}>
                          <tr className={index === 0 ? "rc-day-first" : undefined}>
                            <td className="whitespace-nowrap">{index === 0 ? dayLabel(day) : ""}</td>
                            <td>
                              <span className="font-medium">{row.label}</span>
                              {row.split && (
                                <span className="ai-sub-inline ml-2" title="В организации в этот день тратили несколько ключей: счёт Anthropic поделён между ними по токенам, оценённым ценами Hub">доля счёта</span>
                              )}
                              {row.unmappedMicroUsd !== 0 && <div className="ai-sub ai-warn">и ещё ? {formatAiUsd(row.unmappedMicroUsd)} ключа без решения</div>}
                            </td>
                            <td className="num">{formatAiUsd(row.hubMicroUsd)}</td>
                            <td className="num" title={row.source === "csv" ? "из CSV консоли" : row.source === "admin_api" ? "из отчёта Anthropic" : undefined}>
                              {row.providerMicroUsd === null ? "—" : formatAiUsd(row.providerMicroUsd)}
                            </td>
                            <td className={`num${mismatch ? " ai-warn" : ""}`}>{row.diffMicroUsd === null ? "—" : signedUsd(row.diffMicroUsd)}</td>
                            <td className={`num${mismatch ? " ai-warn" : ""}`}>{row.diffPct === null ? "—" : percent(row.diffPct)}</td>
                            <td className="status-col whitespace-nowrap">
                              {word && <StatusBadge status={word} title={STATUS_HINT[row.status]} />}
                            </td>
                            <td className="rc-models-col">
                              {row.models.length > 0 && (
                                <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)}>
                                  {open === key ? "Скрыть" : "По моделям"}
                                </button>
                              )}
                            </td>
                          </tr>
                          {open === key && (
                            <tr className="row-detail"><td colSpan={8}><ModelBreakdown row={row} /></td></tr>
                          )}
                        </Fragment>
                      );
                    })}
                    {others.map((line, index) => (
                      <tr key={`${day}|${line.orgId}|${line.kind}|${line.apiKeyId ?? ""}`} className={`rc-other${rows.length === 0 && index === 0 ? " rc-day-first" : ""}`}>
                        <td className="whitespace-nowrap">{rows.length === 0 && index === 0 ? dayLabel(day) : ""}</td>
                        <td title={line.orgName ?? line.orgId}>
                          {OTHER_KIND[line.kind]}
                          {(line.kind === "key" || line.kind === "unknown") && ` «${line.keyName ?? line.apiKeyId}»`}
                          {line.keyHint && <div className="ai-sub">{line.keyHint}</div>}
                        </td>
                        <td className="num">—</td>
                        <td className="num">{formatAiUsd(line.providerMicroUsd)}</td>
                        <td className="num" />
                        <td className="num" />
                        <td className="status-col">
                          {line.kind === "unknown"
                            ? <StatusBadge tone="attention" title="Не решено, чей это ключ: отметьте его в «Откуда данные»">Не решено</StatusBadge>
                            : <StatusBadge tone="off" title="Эти траты не прошли через Hub: в его учёте их нет">Вне Hub</StatusBadge>}
                        </td>
                        <td />
                      </tr>
                    ))}
                    {unattributed && (
                      <tr className={`rc-other${rows.length === 0 && others.length === 0 ? " rc-day-first" : ""}`}>
                        <td className="whitespace-nowrap">{rows.length === 0 && others.length === 0 ? dayLabel(day) : ""}</td>
                        <td title="Запросы Hub к Anthropic, где счёт не записан: до того, как Hub начал его отмечать">Hub без счёта</td>
                        <td className="num">{formatAiUsd(unattributed.hubMicroUsd)}</td>
                        <td className="num">—</td>
                        <td className="num" />
                        <td className="num" />
                        <td />
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
    </section>
  );
}

/** «Откуда данные»: each organization's source and its keys, with the owner's decisions. */
function Sources({ data }: { data: Data }) {
  const undecided = data.orgs.reduce((sum, org) => sum + org.keys.filter((key) => !key.decided).length, 0);
  const errors = data.syncs.filter((sync) => sync.lastError && sync.lastErrorAt);
  return (
    <DisclosureCard
      title={`Откуда данные: ${data.orgs.length} ${ruPlural(data.orgs.length, "организация", "организации", "организаций")}${undecided > 0 ? `, не решено ключей: ${undecided}` : ""}`}
      defaultOpen={undecided > 0 || errors.length > 0}
    >
      <div className="card-body space-y-6">
        {errors.map((sync) => (
          <Notice key={sync.labels.join(",")} tone="warning" detail={<Disclosure label="Подробнее"><p>{sync.lastError}</p></Disclosure>}>
            {sync.labels.join(", ")}: отчёт Anthropic не прочитан {formatDateTime(sync.lastErrorAt!)}.
          </Notice>
        ))}
        {data.orgs.map((org) => {
          const candidates = org.accountIds.length > 0 ? data.accounts.filter((account) => org.accountIds.includes(account.id)) : data.accounts;
          return (
            <div key={org.orgId} className="space-y-3">
              <p>
                <span className="font-medium">{labelsOf(data, org)}</span>
                {org.orgName && <span className="text-text-secondary">, {org.orgName}</span>}
                <span className="block text-sm text-text-secondary">{sourceText(org)}</span>
              </p>
              {org.keys.length > 0 && (
                <div className="table-wrap rc-keys">
                  <table className="data-table data-table-dense" aria-label={`Ключи ${labelsOf(data, org)}`}>
                    <thead>
                      <tr><th scope="col">Ключ</th><th scope="col">Номер</th><th scope="col" className="num">За окно</th><th scope="col">Чей ключ</th><th scope="col">Отметка</th></tr>
                    </thead>
                    <tbody>
                      {org.keys.map((key) => (
                        <tr key={key.apiKeyId}>
                          <td className="font-medium">{key.name ?? "—"}</td>
                          <td className="muted">{key.apiKeyId}{key.hint && <div className="ai-sub">{key.hint}</div>}</td>
                          <td className="num">{formatAiUsd(key.providerMicroUsd)}</td>
                          <td><KeyOwnerControl orgId={org.orgId} apiKeyId={key.apiKeyId} accountId={key.decided ? key.accountId : null} candidates={candidates} /></td>
                          <td className="status-col">
                            {!key.decided
                              ? <StatusBadge tone="attention">{`не решено${key.source === "guess" && key.label ? `, похоже на ${key.label}` : ""}`}</StatusBadge>
                              : key.source === "owner" ? <span className="text-text-secondary">вы отметили</span>
                                : <span className="text-text-secondary">{key.source === "name" ? "по имени" : "по подсказке ключа"}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </DisclosureCard>
  );
}

/** Деньги → Расходы → Сверка с Anthropic: does Hub's own count meet Anthropic's bill. */
export function ReconciliationPage() {
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const raw = Number(search.get("days"));
  const days: Days = (DAYS as readonly number[]).includes(raw) ? (raw as Days) : 14;
  const query = useAdminAiReconciliation(days);
  const data = query.data;
  const stale = data ? staleOrgs(data) : null;

  const setDays = (next: Days) => {
    const params = new URLSearchParams(search);
    if (next === 14) params.delete("days");
    else params.set("days", String(next));
    setSearch(params, { state: location.state });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        actions={(
          <Segmented<`${Days}`>
            label="Период"
            value={`${days}`}
            onChange={(value) => setDays(Number(value) as Days)}
            options={DAYS.map((value) => ({ value: `${value}` as const, label: daysWord(value) }))}
          />
        )}
        window="Сутки по UTC, как у Anthropic. Сегодня и вчера Anthropic ещё досчитывает."
        fresh={data ? { at: data.generatedAt, refreshing: query.isFetching, onRefresh: () => void query.refetch() } : undefined}
      />
      {!data && query.isError ? (
        <NoAnswerPanel retry={query.refetch} />
      ) : !data ? (
        <div className="card"><TableSkeleton rows={4} columns={7} /></div>
      ) : (
        <>
          <QueryNotice error={query.isError} stale retry={query.refetch} at={query.dataUpdatedAt} />
          {stale && (
            <Notice tone="warning" role="status">
              Последний CSV по {stale.labels} — по {stale.until.replace(/\.$/, "")}. Дни после него не сверить. Загрузите новый.
            </Notice>
          )}
          <CsvUpload data={data} />
          {!data.configured ? (
            <div className="space-y-3">
              <p className="text-text-secondary">Данных Anthropic пока нет: загрузите CSV со страницы Cost консоли Anthropic.</p>
              <Disclosure label="Подробнее"><p>Отчёты Anthropic Hub может читать и сам, если на сервере задан ключ ANTHROPIC_ADMIN_KEYS.</p></Disclosure>
            </div>
          ) : (
            <>
              <DaysTable data={data} days={days} />
              <Sources data={data} />
            </>
          )}
        </>
      )}
      <Disclosure>
        <p>
          Траты Hub по его расчёту против счёта Anthropic за каждые сутки UTC. Сходится — разница в пределах 1 %. Данные
          Anthropic берутся из CSV страницы Cost или из отчётов Anthropic. Сегодня и вчера Anthropic ещё досчитывает.
        </p>
      </Disclosure>
    </div>
  );
}
