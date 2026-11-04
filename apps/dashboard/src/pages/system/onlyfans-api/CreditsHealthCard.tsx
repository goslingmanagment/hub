import { useEffect, useState } from "react";
import { formatUsdFromMills } from "@agency_hub_core/shared";
import { ChevronDown } from "lucide-react";
import { Link } from "react-router";
import { useAdminOfapiCreditsSummary, useAdminOfapiSpendComparison } from "@/api/queries";
import { Disclosure } from "@/components/ui/Disclosure";
import { KeyValue } from "@/components/ui/KeyValue";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatDateTime, formatDay } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import type { OfapiStatus } from "@/lib/statusWords";

// The credit health of «Состояние»: the old «Состояние системы» and «Точность
// проекций» of /ofapi-credits (design/screens/system.md §8, block 5).

function fmt(value: number) {
  return value.toLocaleString("ru-RU");
}

function credits(value: number) {
  return `${fmt(value)} ${ruPlural(value, "кредит", "кредита", "кредитов")}`;
}

function creditsToUsd(amount: number, microUsdPerCredit: number) {
  return formatUsdFromMills(Math.round((amount * microUsdPerCredit) / 1000));
}

const OPERATION_LABELS: Readonly<Record<string, string>> = {
  ofapi_chats: "Сбор чатов",
  ofapi_chat_messages: "Сбор сообщений",
  ofapi_dm_conversations: "Сбор диалогов",
  ofapi_transactions: "Сбор операций",
  ofapi_fans_active: "Сбор активных фанов",
  ofapi_fans_expired: "Сбор бывших фанов",
  ofapi_audience: "Сбор аудитории",
  ofapi_audience_sweep: "Обход аудитории",
  ofapi_sync_events: "Сбор событий",
  ofapi_balance_ping: "Проверка баланса",
  ofapi_admin_accounts: "Проверка аккаунта",
  ofapi_webhook_crud: "Настройка приёма событий",
};

const COMPARISON_LABELS: Readonly<Record<string, string>> = {
  matched: "совпало",
  skipped: "пропущено",
  ppv_estimated: "платное сообщение оценено",
  tips_blocked: "чаевые заблокированы",
  tips_signal: "чаевые (сигнал)",
  blocked: "заблокировано",
};

const BENIGN = new Set(["matched", "skipped", "ppv_estimated", "tips_blocked", "tips_signal", "blocked"]);

function ConfigLink({ configKey, children }: { configKey: string; children: string }) {
  return <Link className="link" to={`/system/dev/config#config-${configKey}`}>{children}</Link>;
}

/** «Точность оценки выручки»: read only when opened. */
function SpendComparison() {
  const query = useAdminOfapiSpendComparison({ days: 7, sampleLimit: 25 });
  const data = query.data;
  if (query.isLoading) return <Skeleton width={320} />;
  if (!data) {
    return (
      <div className="sys-pause-missing">
        <span>Hub не ответил.</span>
        <button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>Повторить</button>
      </div>
    );
  }
  if (data.summary.length === 0 && data.byPage.length === 0 && data.samples.length === 0) {
    return <p>Пока нечего сравнивать: за последние 7 дней оценка ничего не считала. Она оценивает выручку по событиям до прихода данных сбора.</p>;
  }
  const matched = data.summary.find((row) => row.status === "matched")?.count ?? 0;
  const drift = data.summary.filter((row) => !BENIGN.has(row.status)).reduce((sum, row) => sum + row.count, 0);
  return (
    <div className="sys-stack-16">
      <div className="sys-chips">
        <span className="badge">{fmt(matched)} совпало · {fmt(drift)} {ruPlural(drift, "расхождение", "расхождения", "расхождений")}</span>
        {data.summary.filter((row) => row.status !== "matched").map((row) => (
          <span key={row.status} className="badge">{COMPARISON_LABELS[row.status] ?? row.status.replace(/_/g, " ")} · {fmt(row.count)}</span>
        ))}
      </div>
      {data.samples.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Статус</th>
                <th>Страница</th>
                <th>Время</th>
                <th>Событие</th>
                <th className="num">Оценка, после комиссии</th>
                <th className="num">Сбор, после комиссии</th>
              </tr>
            </thead>
            <tbody>
              {data.samples.map((sample) => (
                <tr key={sample.projectionId}>
                  <td>{COMPARISON_LABELS[sample.comparisonStatus] ?? sample.comparisonStatus.replace(/_/g, " ")}</td>
                  <td>{sample.pageLabel}</td>
                  <td className="muted whitespace-nowrap">{formatDateTime(sample.occurredAt, { yearUnlessCurrent: true })}</td>
                  <td className="muted"><span className="sys-code">{sample.sourceEventType}</span></td>
                  <td className="num">{sample.creatorNetAmountMills !== null ? formatUsdFromMills(sample.creatorNetAmountMills) : "—"}</td>
                  <td className="num">{sample.coreCreatorNetAmountMills !== null ? formatUsdFromMills(sample.coreCreatorNetAmountMills) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.limitations.length > 0 && (
        <ul className="sys-lines" lang="en">{data.limitations.map((note) => <li key={note}>{note}</li>)}</ul>
      )}
    </div>
  );
}

/** «Учёт кредитов»: the balance's reconciliation, the events' accrual, the burn rate. */
export function CreditsHealthCard({ ofapi }: { ofapi: OfapiStatus }) {
  const query = useAdminOfapiCreditsSummary();
  const summary = query.data;
  const burn = summary?.recentBurn ?? null;
  const parked = summary ? summary.budgets.filter((budget) => budget.state !== "ok") : [];
  const needsAttention = summary !== undefined && (summary.floor.blocked
    || summary.incidents.length > 0
    || (burn?.alerting ?? false)
    || (summary.forecast.unverifiedResidual?.credits ?? 0) !== 0
    || parked.length > 0);
  const urgent = summary !== undefined && (summary.floor.blocked || summary.incidents.length > 0 || (burn?.alerting ?? false));
  const on = ofapi === "on";
  const [open, setOpen] = useState(false);
  // While the API is on, the card opens by itself once something needs a look.
  useEffect(() => {
    if (on && needsAttention) setOpen(true);
  }, [on, needsAttention]);

  const badge = !on
    ? <span className="badge badge-off">Выключено</span>
    : !summary
      ? null
      : needsAttention
        ? <span className={urgent ? "badge badge-danger" : "badge badge-warning"}>Нужно посмотреть</span>
        : <span className="badge badge-bare badge-success">В порядке</span>;
  const microUsdPerCredit = summary?.pricing?.microUsdPerCredit ?? 0;
  const pending = summary?.accrual.pendingToday ?? null;
  const drift = summary?.reconciliation.lastDriftCredits ?? 0;

  return (
    <details className="card sys-fold" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="sys-fold-summary">
        <span className="min-w-0 flex-1">
          <span className="sys-fold-head">
            <span className="card-title">Учёт кредитов</span>
            {badge}
          </span>
          {summary?.reconciliation.lastRunAt && (
            <span className="card-description block">баланс сверен {formatDateTime(summary.reconciliation.lastRunAt, { yearUnlessCurrent: true })}</span>
          )}
        </span>
        <ChevronDown size={18} aria-hidden="true" className="sys-fold-chevron" />
      </summary>
      <div className="sys-fold-body sys-stack-16">
        {query.isLoading && !summary ? (
          <Skeleton width={320} />
        ) : !summary ? (
          <div className="sys-pause-missing">
            <span>Hub не ответил.</span>
            <button type="button" className="btn btn-sm" onClick={() => void query.refetch()}>Повторить</button>
          </div>
        ) : (
          <>
            <KeyValue
              rows={[
                {
                  label: "Сверка баланса",
                  value: summary.reconciliation.lastRunAt
                    ? `Сверен с OnlyFans API ${formatDateTime(summary.reconciliation.lastRunAt, { yearUnlessCurrent: true })}: ${drift === 0 ? "последнее окно без расхождений." : `расхождение ${credits(drift)}; источник изменения не подтверждён.`}`
                    : "Ещё не выполнялась. Приложение периодически сверяет свой журнал с реальным балансом.",
                },
                {
                  label: "Начисления за события",
                  value: (
                    <>
                      {summary.accrual.lastPostedDay ? `Проведены по ${formatDay(summary.accrual.lastPostedDay)}.` : "Ещё ничего не проведено."}
                      {pending && pending.eventCount > 0 && (
                        ` Сегодня: ~${credits(pending.estimatedCredits)} за ${fmt(pending.eventCount)} ${ruPlural(pending.eventCount, "событие", "события", "событий")}: спишутся в полночь UTC, в 03:00 по Москве.`
                      )}
                    </>
                  ),
                },
                {
                  label: "Скорость трат",
                  value: burn ? (
                    <>
                      {credits(burn.total)} за последние {burn.windowMinutes} мин
                      {microUsdPerCredit > 0 ? ` (≈ ${creditsToUsd(burn.total, microUsdPerCredit)})` : ""}
                      {burn.threshold > 0 ? ` · тревога выше ${credits(burn.threshold)} в час` : " · тревога выключена"}
                      {(burn.topOperations.length > 0 || burn.topPages.length > 0) && (
                        <span className="block text-text-secondary">
                          больше всего тратят: {[
                            ...burn.topOperations.map((op) => `${op.operation ? OPERATION_LABELS[op.operation] ?? op.operation : "без атрибуции"} · ${fmt(op.credits)}`),
                            ...burn.topPages.map((page) => `${page.pageLabel} · ${fmt(page.credits)}`),
                          ].join(", ")}
                        </span>
                      )}
                    </>
                  ) : "За последний час трат нет.",
                },
              ]}
            />
            <Disclosure label="Подробнее">
              <p>
                Тревога по тратам меняется в списке параметров и применяется сразу. Цена кредита, дневные бюджеты и порог автостопа
                задаются при настройке сервера:{" "}
                <ConfigLink configKey="ofapiBurnAlertCreditsPerHour">тревога по тратам</ConfigLink>
                {" · "}
                <ConfigLink configKey="ofapiMirrorGlobalDailyCreditBudget">дневной лимит</ConfigLink>
                {" · "}
                <ConfigLink configKey="ofapiCreditFloor">порог автостопа</ConfigLink>
                {" · "}
                <ConfigLink configKey="ofapiCreditMicroUsdPrice">цена кредита</ConfigLink>
              </p>
              <Disclosure label="Точность оценки выручки: оценка против данных сбора за 7 дней" lazy>
                <SpendComparison />
              </Disclosure>
            </Disclosure>
          </>
        )}
      </div>
    </details>
  );
}
