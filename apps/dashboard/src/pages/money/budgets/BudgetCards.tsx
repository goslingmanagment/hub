import { useState, type ReactNode } from "react";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { Tooltip } from "@/components/shared/Tooltip";
import { BulletBar, Hint, LineRow, useOpenLine } from "./BudgetParts.js";
import { formatUsd, type MonthView } from "./budgetsModel.js";

type Names = Readonly<Record<string, string>>;

function CardHead({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <div className="card-header">
      <h2 className="card-title">{title}</h2>
      {aside && <div className="budget-card-aside">{aside}</div>}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="budget-empty">{children}</p>;
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return "—";
  return `${Math.round((part / whole) * 100)} %`;
}

/** «Пришло»: the month's income by source — each model's platforms, the deals past them, the rest. */
export function IncomeCard({ view, names }: { view: MonthView; names: Names }) {
  const { open, toggle } = useOpenLine();
  const max = Math.max(0, ...view.incomeLines.map((line) => line.amount));
  return (
    <section className="card budget-card" aria-labelledby="budget-income">
      <CardHead title="Откуда пришли" aside={<span className="budget-total">{formatUsd(view.income)}</span>} />
      {view.incomeLines.length === 0 ? (
        <Empty>{view.current ? "В этом месяце денег на счета ещё не приходило." : "Денег на счета не приходило."}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data-table budget-table" id="budget-income">
            <thead className="sr-only">
              <tr><th>Источник</th><th className="budget-bar-cell">Доля</th><th className="num">Пришло</th><th className="num">Доля</th></tr>
            </thead>
            <tbody>
              {view.incomeLines.map((line) => (
                <LineRow key={line.key} open={open === line.key} onToggle={() => toggle(line.key)} label={line.label} sub={line.sub} rows={line.rows} colSpan={4} names={names}>
                  <td className="budget-bar-cell budget-bar-narrow"><BulletBar value={line.amount} plan={null} max={max} tone="earn" /></td>
                  <td className="num budget-amount">{formatUsd(line.amount)}</td>
                  <td className="num budget-share">{pct(line.amount, view.income)}</td>
                </LineRow>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(view.ownerIn > 0 || view.ownerOut > 0) && (
        <div className="card-footer budget-owner">
          <Hint text="Деньги владельца — не доход и не расход: вложенное — финансирование, вынутое — распределение прибыли. В «Пришло», «Ушло» и прибыль не входят.">
            <span>Владелец</span>
          </Hint>
          <span className="budget-owner-sums">
            {view.ownerOut > 0 && <span>вынул <b>{formatUsd(view.ownerOut)}</b></span>}
            {view.ownerIn > 0 && <span>вложил <b>{formatUsd(view.ownerIn)}</b></span>}
          </span>
        </div>
      )}
    </section>
  );
}

/** «Куда ушли»: the month's expenses by item against the plan, refunds taken off. */
export function ItemsCard({ view, names, editor }: { view: MonthView; names: Names; editor?: ReactNode }) {
  const { open, toggle } = useOpenLine();
  const lines = view.itemLines;
  const max = Math.max(0, ...lines.map((line) => Math.max(line.amount, line.plan ?? 0)));
  const planOf = (line: MonthView["itemLines"][number]) => {
    if (line.plan === null) return <span className="budget-muted">—</span>;
    const text = formatUsd(line.plan);
    if (line.planSource === "rate") return <Hint text={`Ставка CEO на месяц — своего плана у статьи нет${line.planNote ? ` (${line.planNote})` : ""}.`}><span className="budget-muted">{text}</span></Hint>;
    return line.planNote ? <Hint text={line.planNote}>{text}</Hint> : <>{text}</>;
  };
  const leftOf = (fact: number, plan: number | null) => {
    if (plan === null) return <span className="budget-muted">—</span>;
    const diff = plan - fact;
    if (diff >= 0) return <span className="budget-muted">{formatUsd(diff)}</span>;
    return <span className="budget-over">+{formatUsd(-diff)}</span>;
  };
  return (
    <section className="card budget-card" aria-labelledby="budget-items-title">
      <div className="card-header">
        <h2 className="card-title" id="budget-items-title">Куда ушли</h2>
        <div className="budget-card-aside">
          <span className="budget-total">{formatUsd(view.spent)}</span>
          {view.planSpent !== null && <span className="budget-muted"> из плана {formatUsd(view.planSpent)}</span>}
          {editor}
        </div>
      </div>
      {lines.length === 0 ? (
        <Empty>{view.current ? "Расходов в этом месяце ещё нет." : "Расходов не было."}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data-table budget-table budget-items">
            <thead>
              <tr>
                <th>Статья</th>
                <th className="budget-bar-cell"><span className="sr-only">Факт против плана</span></th>
                <th className="num">Ушло</th>
                <th className="num">План</th>
                <th className="num"><Hint text="Сколько осталось до плана; «+» — сверх плана.">Остаток</Hint></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <LineRow key={line.key} open={open === line.key} onToggle={() => toggle(line.key)} label={line.label} rows={line.rows} colSpan={5} names={names}>
                  <td className="budget-bar-cell"><BulletBar value={line.amount} plan={line.plan} max={max} tone="spend" /></td>
                  <td className="num budget-amount">{formatUsd(line.amount)}</td>
                  <td className="num">{planOf(line)}</td>
                  <td className="num">{leftOf(line.amount, line.plan)}</td>
                </LineRow>
              ))}
              {view.refunds > 0 && (
                <LineRow open={open === "refunds"} onToggle={() => toggle("refunds")} label="Возвраты расходов" rows={view.refundRows} colSpan={5} names={names}>
                  <td className="budget-bar-cell" />
                  <td className="num budget-amount">−{formatUsd(view.refunds)}</td>
                  <td />
                  <td />
                </LineRow>
              )}
            </tbody>
            <tfoot>
              {view.unplanned > 0 && (
                <tr className="budget-foot budget-foot-quiet">
                  <td><Hint text="Траты статей, у которых в этом месяце нет плана.">Вне плана</Hint></td>
                  <td className="budget-bar-cell" />
                  <td className="num">{formatUsd(view.unplanned)}</td>
                  <td />
                  <td />
                </tr>
              )}
              <tr className="budget-foot">
                <td>Всего</td>
                <td className="budget-bar-cell" />
                <td className="num">{formatUsd(view.spent)}</td>
                <td className="num">{view.planSpent === null ? <span className="budget-muted">—</span> : formatUsd(view.planSpent)}</td>
                <td className="num">{view.planSpent === null ? <span className="budget-muted">—</span> : leftOf(view.spent, view.planSpent)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

/** «Оборот страниц»: Hub's net of each page against the ledger's plan, a day. */
export function TurnoverCard({ view }: { view: MonthView }) {
  const days = Math.max(1, view.elapsed);
  const withPlan = view.turnoverPlanMonth !== null;
  const perDay = (value: number) => value / days;
  const planned = view.pages.filter((page) => page.planMonth !== null);
  const rest = view.pages.filter((page) => page.planMonth === null);
  const max = Math.max(0, ...view.pages.map((page) => Math.max(perDay(page.net), page.planMonth === null ? 0 : page.planMonth / view.days)));
  const planDay = view.turnoverPlanMonth === null ? null : view.turnoverPlanMonth / view.days;
  const row = (page: MonthView["pages"][number]) => {
    const planPerDay = page.planMonth === null ? null : page.planMonth / view.days;
    const pace = planPerDay === null || planPerDay === 0 ? null : perDay(page.net) / planPerDay;
    return (
      <tr key={page.pageLabel}>
        <td>
          <span className="budget-page-name">
            <span className="budget-line-label">{page.pageLabel}</span>
            {page.platform && <PlatformBadge platform={page.platform} />}
          </span>
        </td>
        <td className="budget-bar-cell"><BulletBar value={perDay(page.net)} plan={planPerDay} max={max} tone="earn" /></td>
        <td className="num budget-amount">{formatUsd(perDay(page.net))}</td>
        {withPlan && <td className="num">{planPerDay === null ? <span className="budget-muted">—</span> : formatUsd(planPerDay)}</td>}
        {withPlan && <td className="num">{pace === null ? <span className="budget-muted">—</span> : <span className={pace >= 1 ? "budget-good" : "budget-over"}>{Math.round(pace * 100)} %</span>}</td>}
        <td className="num budget-col-month">{formatUsd(page.net)}</td>
        {withPlan && <td className="num budget-col-month">{page.planMonth === null ? <span className="budget-muted">—</span> : formatUsd(page.planMonth)}</td>}
      </tr>
    );
  };
  return (
    <section className="card budget-card" aria-labelledby="budget-turnover-title">
      <div className="card-header">
        <h2 className="card-title" id="budget-turnover-title">Оборот страниц</h2>
        <div className="budget-card-aside">
          <Hint text={`Net страниц по дням МСК${view.current ? `, ${view.elapsed} из ${view.days} дней` : ""} — то же, что на Главной. План — ledger, $ в день по страницам.`}>
            <span className="budget-total">{formatUsd(perDay(view.turnover))}</span>
            <span className="budget-muted"> в день</span>
          </Hint>
          {planDay !== null ? <span className="budget-muted"> · план {formatUsd(planDay)}</span> : <span className="budget-muted"> · плана нет</span>}
        </div>
      </div>
      {view.pages.length === 0 ? (
        <Empty>Оборота нет.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data-table budget-table">
            <thead>
              <tr>
                <th>Страница</th>
                <th className="budget-bar-cell"><span className="sr-only">В день против плана</span></th>
                <th className="num">В день</th>
                {withPlan && <th className="num">План в день</th>}
                {withPlan && <th className="num"><Hint text="Оборот в день против плана в день.">Темп</Hint></th>}
                <th className="num budget-col-month">{view.current ? "С начала месяца" : "За месяц"}</th>
                {withPlan && <th className="num budget-col-month">План месяца</th>}
              </tr>
            </thead>
            <tbody>
              {planned.map(row)}
              {rest.map(row)}
            </tbody>
            <tfoot>
              <tr className="budget-foot">
                <td>Всего</td>
                <td className="budget-bar-cell" />
                <td className="num">{formatUsd(perDay(view.turnover))}</td>
                {withPlan && <td className="num">{planDay === null ? <span className="budget-muted">—</span> : formatUsd(planDay)}</td>}
                {withPlan && <td className="num">{view.turnoverPlanToDate ? <span className={view.turnover >= view.turnoverPlanToDate ? "budget-good" : "budget-over"}>{Math.round((view.turnover / view.turnoverPlanToDate) * 100)} %</span> : <span className="budget-muted">—</span>}</td>}
                <td className="num budget-col-month">{formatUsd(view.turnover)}</td>
                {withPlan && <td className="num budget-col-month">{view.turnoverPlanMonth === null ? <span className="budget-muted">—</span> : formatUsd(view.turnoverPlanMonth)}</td>}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

/** «Трафик»: what the month put into traffic, by channel, and the months before beside it. */
export function TrafficCard({ view, months, names }: { view: MonthView; months: readonly MonthView[]; names: Names }) {
  const { open, toggle } = useOpenLine();
  const max = Math.max(0, ...view.trafficLines.map((line) => line.amount));
  const recent = months.filter((month) => month.complete && month.month <= view.month).slice(-6);
  // One colour a channel, in the list and in the months: the list is the chart's legend.
  const channels = [...new Set([...view.trafficLines, ...recent.flatMap((month) => month.trafficLines)].map((line) => line.key))]
    .sort((left, right) => total(right) - total(left) || left.localeCompare(right));
  function total(channel: string) {
    return recent.reduce((sum, month) => sum + (month.trafficLines.find((line) => line.key === channel)?.amount ?? 0), 0);
  }
  const toneOf = (channel: string) => `budget-tone-${Math.max(0, channels.indexOf(channel)) % 6}`;
  const top = Math.max(1, ...recent.map((month) => month.traffic));
  return (
    <section className="card budget-card" aria-labelledby="budget-traffic-title">
      <div className="card-header">
        <h2 className="card-title" id="budget-traffic-title">Трафик</h2>
        <div className="budget-card-aside">
          <Hint text="Статья «Трафик» и подрядчики, чья работа — трафик (SFS, FYP): в «Куда ушли» они стоят в «Подрядчиках».">
            <span className="budget-total">{formatUsd(view.traffic)}</span>
          </Hint>
          {view.spent > 0 && <Hint text="Доля трафика в расходах месяца."><span className="budget-muted"> · {pct(view.traffic, view.spent)} расходов</span></Hint>}
        </div>
      </div>
      {view.trafficLines.length === 0 ? (
        <Empty>{view.current ? "В этом месяце в трафик ещё не вкладывали." : "В трафик не вкладывали."}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data-table budget-table">
            <thead className="sr-only">
              <tr><th>Канал</th><th className="budget-bar-cell">Доля</th><th className="num">Вложено</th></tr>
            </thead>
            <tbody>
              {view.trafficLines.map((line) => (
                <LineRow key={line.key} open={open === line.key} onToggle={() => toggle(line.key)} label={line.label} sub={line.models.join(", ")} rows={line.rows} colSpan={3} names={names}>
                  <td className="budget-bar-cell"><BulletBar value={line.amount} plan={null} max={max} fillClass={toneOf(line.key)} /></td>
                  <td className="num budget-amount">{formatUsd(line.amount)}</td>
                </LineRow>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {recent.length > 1 && (
        <div className="budget-trend" aria-label="Трафик по месяцам">
          {recent.map((month) => (
            <div key={month.month} className={`budget-trend-col${month.month === view.month ? " is-current" : ""}`}>
              <Tooltip
                className="budget-trend-bar"
                content={(
                  <span className="budget-hint">
                    <b>{month.label}: {formatUsd(month.traffic)}</b>
                    {month.trafficLines.map((line) => <span key={line.key} className="block">{line.label} — {formatUsd(line.amount)}</span>)}
                  </span>
                )}
              >
                <span className="budget-trend-stack" style={{ height: `${Math.max(2, (month.traffic / top) * 100)}%` }}>
                  {channels.map((channel) => {
                    const amount = month.trafficLines.find((line) => line.key === channel)?.amount ?? 0;
                    if (amount <= 0) return null;
                    return <span key={channel} className={`budget-trend-part ${toneOf(channel)}`} style={{ flexGrow: amount }} />;
                  })}
                </span>
              </Tooltip>
              <span className="budget-trend-sum">{formatUsd(month.traffic)}</span>
              <span className="budget-trend-label">{month.short}</span>
            </div>
          ))}
        </div>
      )}
      {recent.length > 1 && channels.some((channel) => !view.trafficLines.some((line) => line.key === channel)) && (
        <ul className="budget-legend" aria-label="Каналы на графике">
          {channels.map((channel) => (
            <li key={channel}><span className={`budget-legend-dot ${toneOf(channel)}`} />{channel}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** «По месяцам»: every month in one table; a row opens its month. The months before full accounting are folded. */
export function HistoryCard({ months, selected, onSelect }: { months: readonly MonthView[]; selected: string; onSelect: (month: string) => void }) {
  const newest = [...months].reverse();
  const partial = newest.filter((month) => !month.complete);
  const [opened, setShowPartial] = useState(false);
  // A month before full accounting that is chosen shows its row.
  const showPartial = opened || partial.some((month) => month.month === selected);
  const shown = showPartial ? newest : newest.filter((month) => month.complete);
  return (
    <section className="card budget-card" aria-labelledby="budget-history-title">
      <CardHead title="По месяцам" />
      <div className="table-wrap">
        <table className="data-table budget-history">
          <thead>
            <tr>
              <th id="budget-history-title">Месяц</th>
              <th className="num"><Hint text="Net страниц за месяц, Hub.">Оборот</Hint></th>
              <th className="num"><Hint text="Деньги, пришедшие на счета агентства, без денег владельца.">Пришло</Hint></th>
              <th className="num"><Hint text="Расходы с зарплатой CEO, за вычетом возвратов.">Ушло</Hint></th>
              <th className="num">Трафик</th>
              <th className="num"><Hint text="Итог месяца по правилам ledger: цифра решения минус зарплата CEO по плану; у закрытого месяца — на закрытии.">Прибыль</Hint></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((month) => (
              <tr
                key={month.month}
                className={`budget-history-row${month.month === selected ? " is-selected" : ""}${month.complete ? "" : " is-partial"}`}
                onClick={() => onSelect(month.month)}
                aria-current={month.month === selected ? "true" : undefined}
              >
                <td>
                  <button type="button" className="budget-month-link" onClick={(event) => { event.stopPropagation(); onSelect(month.month); }}>{month.label}</button>
                  {month.current && <span className="budget-chip">идёт</span>}
                  {!month.current && !month.closed && month.complete && <span className="budget-chip">не закрыт</span>}
                  {!month.complete && <span className="budget-chip budget-chip-warn">неполный учёт</span>}
                </td>
                <td className="num">{month.turnover > 0 ? formatUsd(month.turnover) : <span className="budget-muted">—</span>}</td>
                <td className="num">{formatUsd(month.income)}</td>
                <td className="num">{formatUsd(month.spent)}</td>
                <td className="num">{month.traffic > 0 ? formatUsd(month.traffic) : <span className="budget-muted">—</span>}</td>
                <td className="num budget-amount">
                  {month.profit === null ? <span className="budget-muted">—</span> : <span className={month.profit < 0 ? "budget-over" : ""}>{formatUsd(month.profit)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {partial.length > 0 && (
        <div className="card-footer">
          <button type="button" className="link" onClick={() => setShowPartial((value) => !value)}>
            {showPartial ? "Скрыть месяцы до полного учёта" : `Ещё ${partial.length} ${partial.length === 1 ? "месяц" : partial.length < 5 ? "месяца" : "месяцев"} до полного учёта: ${partial.at(-1)!.short} – ${partial[0]!.short}`}
          </button>
        </div>
      )}
    </section>
  );
}
