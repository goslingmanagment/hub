import type { ReactNode } from "react";
import type { AdminBudgetsResponse, BudgetArticle, BudgetFigures, BudgetMonth } from "@agency_hub_core/contracts";
import { sumMills } from "@agency_hub_core/shared";
import { usdAxisFormatter } from "@/components/charts/format";
import { StackedBarChart } from "@/components/shared/StackedBarChart";
import { Disclosure } from "@/components/ui/Disclosure";
import { Stat, StatGrid } from "@/components/ui/StatGrid";
import { formatMills, formatPercent } from "@/lib/format";
import { articleRows, monthAxisLabel, monthLong, monthShort, monthSince, monthWindow, runningDay, shareOf } from "./budgetsView.js";

/** One hue per thing on the whole screen: what came in, what was spent, the CEO's pay, what is left. */
const INCOME = "var(--color-chart-blue)";
const SPENT = "var(--color-chart-orange)";
const CEO = "var(--color-chart-violet)";
const LEFT = "var(--color-chart-aqua)";

const share = (part: number, whole: number) => {
  const value = shareOf(part, whole);
  return value === null || part <= 0 ? "" : formatPercent(value);
};

// ── The month in four numbers ────────────────────────────────────────────

export function MonthTiles({ month }: { month: BudgetMonth }) {
  const figures = month.figures;
  const rate = month.owner.salaryRateMills;
  const unknown = "Ledger не посчитал";
  return (
    <StatGrid className="budget-tiles">
      <Stat
        label="Заработано"
        value={figures ? formatMills(figures.earnedMills) : "—"}
        meta={figures ? `оборот ${formatMills(figures.turnoverMills)}` : unknown}
      />
      <Stat
        label="Расходы"
        value={figures ? formatMills(figures.expensesMills) : "—"}
        meta={figures ? `${share(figures.expensesMills, figures.earnedMills) || "—"} заработанного` : unknown}
      />
      <Stat
        label="Зарплата CEO"
        value={rate === null ? "—" : formatMills(rate)}
        meta={rate === null ? "ставка не задана" : `выплачено ${formatMills(month.owner.salaryPaidMills)}`}
      />
      <Stat
        label={month.state === "open" ? "Остаётся на сегодня" : "Остаётся"}
        value={figures?.leftMills == null ? "—" : formatMills(figures.leftMills)}
        meta={!figures ? unknown : figures.leftMills === null ? "нет ставки CEO" : figures.leftMills < 0
          ? "расходы и зарплата больше заработанного"
          // Earned − expenses − the CEO's pay is this number only without what is stuck: say so beside it.
          : `${share(figures.leftMills, figures.earnedMills) || "—"} заработанного${figures.stuckMills > 0 ? ` · без застрявших ${formatMills(figures.stuckMills)}` : ""}`}
      />
    </StatGrid>
  );
}

// ── Every month side by side ─────────────────────────────────────────────

export function MonthsCard({ months, active, onPick }: { months: readonly BudgetMonth[]; active: string; onPick: (month: string) => void }) {
  const keys = months.map((month) => month.month);
  // A month the ledger did not count has no bar: the chart says «нет данных» for it, not a zero.
  const rows = months.map((month): Record<string, string | number> => {
    const figures = month.figures;
    const rate = month.owner.salaryRateMills;
    return figures && figures.leftMills !== null && rate !== null
      ? { month: month.month, spent: figures.expensesMills, ceo: rate, left: figures.leftMills, earned: figures.earnedMills, open: month.state === "open" ? 1 : 0 }
      : { month: month.month };
  });
  return (
    <section className="card" aria-label="Месяцы">
      <div className="card-header">
        <h2 className="card-title">По месяцам</h2>
        <p className="card-description">Клик по столбику открывает месяц</p>
      </div>
      <div className="card-body">
        <StackedBarChart
          title=""
          data={rows}
          xKey="month"
          height={220}
          series={[
            { key: "spent", label: "Расходы", color: SPENT },
            { key: "ceo", label: "Зарплата CEO", color: CEO },
            { key: "left", label: "Остаётся", color: LEFT },
          ]}
          xTickFormatter={(value) => monthAxisLabel(value, keys)}
          tooltipLabelFormatter={monthLong}
          emptyText="Ledger не посчитал этот месяц"
          valueFormatter={formatMills}
          axisFormatter={usdAxisFormatter}
          totalLabel={null}
          note={(row) => (typeof row.earned === "number" ? `Заработано ${formatMills(row.earned)}${row.open === 1 ? ", месяц идёт" : ""}` : null)}
          unfinished={(row) => row.open === 1}
          activeX={active}
          onPick={onPick}
        />
        <Disclosure label="Числа таблицей" lazy className="mt-2">
          <MonthsTable months={months} active={active} />
        </Disclosure>
      </div>
    </section>
  );
}

/** The budget sheet: every article against every month. The chart's twin, and the place to compare months. */
function MonthsTable({ months, active }: { months: readonly BudgetMonth[]; active: string }) {
  const chosen = Math.max(0, months.findIndex((month) => month.month === active));
  const { from, to } = monthWindow(months.length, chosen);
  const shown = months.slice(from, to);
  const keys = shown.map((month) => month.month);
  const articles = articleRows(shown);
  const anyStuck = shown.some((month) => (month.figures?.stuckMills ?? 0) !== 0);
  // A month the ledger did not count is «—»; a counted month without the article is an empty cell.
  const cell = (month: BudgetMonth, value: (figures: BudgetFigures) => number | null) => {
    const amount = month.figures ? value(month.figures) : null;
    return (
      <td key={month.month} className={month.month === active ? "num budget-col-active" : "num"}>
        {!month.figures ? "—" : amount === null ? "" : formatMills(amount)}
      </td>
    );
  };
  const row = (label: ReactNode, value: (figures: BudgetFigures, month: BudgetMonth) => number | null, className?: string) => (
    <tr className={className}>
      <td>{label}</td>
      {shown.map((month) => cell(month, (figures) => value(figures, month)))}
    </tr>
  );
  return (
    <div className="table-wrap budget-sheet">
      <table className="data-table data-table-dense" aria-label="Статьи бюджета по месяцам">
        <thead>
          <tr>
            <th scope="col">Статья</th>
            {shown.map((month) => (
              <th key={month.month} scope="col" className={month.month === active ? "num budget-col-active" : "num"}>
                {monthAxisLabel(month.month, keys)}{month.state === "open" ? ", идёт" : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {row("Оборот", (figures) => figures.turnoverMills, "budget-sheet-quiet")}
          {row("Заработано", (figures) => figures.earnedMills, "budget-sheet-strong")}
          {anyStuck && row("Застряло на страницах", (figures) => (figures.stuckMills === 0 ? null : -figures.stuckMills), "budget-sheet-quiet")}
          {articles.map((article) => (
            <tr key={article.key}>
              <td>{article.name}</td>
              {shown.map((month) => cell(month, (figures) => figures.articles.find((one) => one.key === article.key)?.amountMills ?? null))}
            </tr>
          ))}
          {row("Расходы", (figures) => figures.expensesMills, "row-total")}
          {row("До зарплаты CEO", (figures) => figures.decisionMills)}
          {row("Зарплата CEO", (_figures, month) => month.owner.salaryRateMills)}
          {row("Остаётся", (figures) => figures.leftMills, "row-total")}
        </tbody>
      </table>
    </div>
  );
}

// ── Where the month's money came from and where it went ──────────────────

/** A row of a flow card: a name, a bar on the card's scale, the sum, its share; a quiet line under them. */
function FlowRow({ name, sub, amount, whole, color, mark, total = false, note }: {
  name: ReactNode;
  sub?: ReactNode;
  amount: number;
  /** What a full bar is: the month's earned money on both cards, so their bars compare. */
  whole: number;
  color: string;
  /** A line on the bar at this sum: the article's limit. */
  mark?: number | null | undefined;
  total?: boolean;
  /** Said in the warning colour: the article is over its limit. */
  note?: ReactNode;
}) {
  const width = shareOf(Math.max(0, amount), whole) ?? 0;
  const markAt = mark == null ? null : shareOf(mark, whole);
  return (
    <li className={total ? "budget-row budget-row-total" : "budget-row"}>
      <span className="budget-row-name">{name}</span>
      <span className="budget-bar" aria-hidden="true">
        <span className="budget-bar-fill" style={{ width: `${Math.min(100, width)}%`, background: color }} />
        {markAt !== null && markAt <= 100 && <span className="budget-bar-mark" style={{ left: `${markAt}%` }} />}
      </span>
      <span className="budget-row-sum">{formatMills(amount)}</span>
      <span className="budget-row-share">{share(amount, whole)}</span>
      {(sub || note) && (
        <span className="budget-row-sub">
          {sub}
          {sub && note ? " · " : null}
          {note && <span className="budget-row-over">{note}</span>}
        </span>
      )}
    </li>
  );
}

/** The quiet line of an article: what it is made of, whom it was paid to, its limit. */
function articleSub(article: BudgetArticle, paidTo: string): ReactNode {
  if (article.parts.length > 0) return article.parts.map((part) => `${part.name} ${formatMills(part.amountMills)}`).join(" · ");
  if (article.capMills !== null) return `лимит ${formatMills(article.capMills)}`;
  return paidTo === "" ? undefined : paidTo;
}

export function FlowCards({ month, figures, promotion }: { month: BudgetMonth; figures: BudgetFigures; promotion: AdminBudgetsResponse["promotion"] }) {
  const whole = figures.earnedMills;
  // Whom the month's traffic and contractors' money went to (by the date of payment), the largest first.
  const at = promotion.months.indexOf(month.month);
  const paidTo = (category: string) => promotion.sources
    .map((source) => ({ name: source.counterparty, category: source.category, paid: source.byMonth[at] ?? 0 }))
    .filter((source) => source.category === category && source.paid !== 0)
    .sort((a, b) => b.paid - a.paid)
    .map((source) => `${source.name} ${formatMills(source.paid)}`)
    .join(" · ");
  const rate = month.owner.salaryRateMills;
  const arrived = shareOf(Math.max(0, figures.arrivedMills), whole) ?? 0;
  const transit = shareOf(Math.max(0, figures.transitMills), whole) ?? 0;
  const ownerNotes = [
    month.owner.drawMills > 0 ? `Сверх зарплаты владелец вывел ${formatMills(month.owner.drawMills)}.` : null,
    month.owner.injectionMills > 0 ? `Владелец вложил ${formatMills(month.owner.injectionMills)}.` : null,
    month.owner.injectionMills < 0 ? `Владельцу возвращено вложенное: ${formatMills(-month.owner.injectionMills)}.` : null,
  ].filter((note): note is string => note !== null);
  return (
    <div className="budget-flow">
      <div className="budget-flow-column">
        <section className="card" aria-label="Откуда пришло">
          <div className="card-header">
            <h2 className="card-title">Откуда пришло</h2>
          </div>
          <ul className="budget-rows">
            {figures.sources.map((source) => (
              <FlowRow
                key={`${source.model}:${source.channel}:${source.channelName}`}
                name={`${source.model} · ${source.channelName}`}
                amount={source.earnedMills}
                whole={whole}
                color={INCOME}
              />
            ))}
          </ul>
          <div className="card-footer budget-where">
            <span className="budget-bar budget-bar-wide" aria-hidden="true">
              <span className="budget-bar-fill" style={{ width: `${arrived}%`, background: INCOME }} />
              <span className="budget-bar-fill" style={{ width: `${transit}%`, background: INCOME, opacity: 0.35 }} />
            </span>
            <span className="budget-where-item"><i style={{ background: INCOME }} />Пришло {formatMills(figures.arrivedMills)}</span>
            {figures.transitMills !== 0 && <span className="budget-where-item"><i style={{ background: INCOME, opacity: 0.35 }} />В пути {formatMills(figures.transitMills)}</span>}
            {figures.stuckMills !== 0 && <span className="budget-where-item"><i className="budget-where-stuck" />Застряло {formatMills(figures.stuckMills)}</span>}
          </div>
        </section>
        <PagesCard month={month} figures={figures} />
      </div>

      <section className="card" aria-label="Куда ушло">
        <div className="card-header">
          <h2 className="card-title">Куда ушло</h2>
        </div>
        <ul className="budget-rows">
          {figures.articles.map((article) => (
            <FlowRow
              key={article.key}
              name={article.name}
              sub={articleSub(article, paidTo(article.key))}
              amount={article.amountMills}
              whole={whole}
              color={SPENT}
              mark={article.capMills}
              note={article.capMills !== null && article.amountMills > article.capMills
                ? `выше на ${formatMills(sumMills([article.amountMills, -article.capMills]))}`
                : undefined}
            />
          ))}
          {rate !== null && <FlowRow name="Зарплата CEO" sub={`выплачено ${formatMills(month.owner.salaryPaidMills)}`} amount={rate} whole={whole} color={CEO} />}
          {figures.leftMills !== null && <FlowRow name="Остаётся" amount={figures.leftMills} whole={whole} color={LEFT} total />}
        </ul>
        {ownerNotes.length > 0 && <p className="card-footer budget-notes">{ownerNotes.join(" ")}</p>}
      </section>
    </div>
  );
}

// ── The pages' turnover, against the plan where there is one ─────────────

/** A page's turnover: against its plan (the bar is the plan, the line is where the month is today), or as a share of all pages. */
function PageRow({ name, fact, plan, whole, elapsed, strong = false }: {
  name: ReactNode;
  fact: number;
  /** null — the page has no plan this month. */
  plan: number | null;
  /** What a full bar is when there is no plan: all the pages' turnover. */
  whole: number;
  elapsed: number | null;
  strong?: boolean;
}) {
  const done = shareOf(fact, plan ?? whole);
  return (
    <li className={strong ? "budget-row budget-page-row budget-row-strong" : "budget-row budget-page-row"}>
      <span className="budget-row-name">{name}</span>
      <span className="budget-row-sum">{formatMills(fact)}</span>
      <span className="budget-bar" aria-hidden="true">
        <span className="budget-bar-fill" style={{ width: `${Math.min(100, done ?? 0)}%`, background: INCOME }} />
        {plan !== null && elapsed !== null && <span className="budget-bar-mark" style={{ left: `${elapsed}%` }} />}
      </span>
      <span className="budget-row-of">{plan === null ? "" : formatMills(plan)}</span>
      <span className="budget-row-share">{done === null ? "" : formatPercent(done)}</span>
    </li>
  );
}

function PagesCard({ month, figures }: { month: BudgetMonth; figures: BudgetFigures }) {
  const { plan } = month;
  if (figures.pages.length === 0 && plan.pages.length === 0) return null;
  const running = month.state === "open";
  const elapsed = running ? month.elapsedShare * 100 : null;
  const planOf = new Map(plan.pages.map((page) => [page.pageLabel, page.planMills]));
  const factOf = new Map(figures.pages.map((page) => [page.pageLabel, page.turnoverMills]));
  // The planned pages first, in the plan's order; then the ones without a plan.
  const rows = [
    ...plan.pages.map((page) => ({ pageLabel: page.pageLabel, fact: factOf.get(page.pageLabel) ?? 0, plan: page.planMills as number | null })),
    ...figures.pages.filter((page) => !planOf.has(page.pageLabel)).map((page) => ({ pageLabel: page.pageLabel, fact: page.turnoverMills, plan: null })),
  ];
  const whole = Number(sumMills(figures.pages.map((page) => page.turnoverMills)));
  // The plan is of the planned pages' turnover: what came past the platforms is not in it.
  const done = plan.turnoverMills === null || plan.factMills === null ? null : shareOf(plan.factMills, plan.turnoverMills);
  return (
    <section className="card" aria-label="Страницы">
      <div className="card-header">
        <h2 className="card-title">{plan.turnoverMills === null ? "Оборот страниц" : "План оборота"}</h2>
        {done !== null && (
          <p className="card-description">
            {running ? `${formatPercent(done)} плана за ${formatPercent(month.elapsedShare * 100)} месяца` : `${formatPercent(done)} плана`}
          </p>
        )}
      </div>
      <ul className="budget-rows">
        {plan.turnoverMills !== null && plan.factMills !== null && <PageRow name="Всего" fact={plan.factMills} plan={plan.turnoverMills} whole={whole} elapsed={elapsed} strong />}
        {rows.map((row) => <PageRow key={row.pageLabel} name={row.pageLabel} fact={row.fact} plan={row.plan} whole={whole} elapsed={elapsed} />)}
      </ul>
      {running && plan.turnoverMills !== null && (
        <p className="card-footer budget-plan-legend"><i className="budget-bar-mark" />план на сегодня: день {runningDay(month)} из {month.daysInMonth}</p>
      )}
    </section>
  );
}

// ── Traffic and contractors by source ────────────────────────────────────

/** «$30.00 в неделю»: what the ledger expects to pay a source regularly, in the ledger's period. */
function regularText(regular: { amountMills: number; period: string }): string {
  const days = /^(\d+)d$/.exec(regular.period)?.[1];
  const period = regular.period === "week" ? "в неделю" : regular.period === "month" ? "в месяц" : regular.period === "once" ? "разово"
    : days ? `раз в ${days} дн.` : regular.period;
  return `${formatMills(regular.amountMills)} ${period}`.trim();
}

export function PromotionCard({ promotion, month }: { promotion: AdminBudgetsResponse["promotion"]; month: BudgetMonth }) {
  const active = month.month;
  const chosen = Math.max(0, promotion.months.indexOf(active));
  // Five months and the total: a table of months stays inside seven columns.
  const { from, to } = monthWindow(promotion.months.length, chosen, 5);
  const months = promotion.months.slice(from, to);
  const totals = promotion.totals.slice(from, to);
  // A source is a row when it was paid in these months, or when a regular payment to it is agreed.
  const shown = promotion.sources
    .map((source) => ({ ...source, shownByMonth: source.byMonth.slice(from, to) }))
    .filter((source) => source.regular !== null || source.shownByMonth.some((value) => value !== 0));
  const activeTotals = promotion.totals[chosen];
  const money = (value: number) => (value === 0 ? "" : formatMills(value));
  const caps = month.plan.reinvest;
  const capSum = Number(sumMills(caps.map((item) => item.capMills)));
  const column = (key: string) => (key === active ? "num budget-col-active" : "num");
  const both = (total: { trafficMills: number; contractorMills: number }) => Number(sumMills([total.trafficMills, total.contractorMills]));
  const allTime = (pick: (total: (typeof totals)[number]) => number) => Number(sumMills(promotion.totals.map(pick)));
  const first = promotion.months[0];
  const invested = activeTotals ? both(activeTotals) : 0;
  const group = (kind: "traffic" | "contractor", label: string, sum: (total: (typeof totals)[number]) => number) => {
    const sources = shown.filter((source) => source.kind === kind);
    if (sources.length === 0) return null;
    return (
      <>
        <tr className="row-group">
          <td>{label}</td>
          {totals.map((total) => <td key={total.month} className={column(total.month)}>{money(sum(total))}</td>)}
          <td className="num">{money(allTime(sum))}</td>
        </tr>
        {sources.map((source) => {
          const sub = [
            source.category === "Трафик" || source.category === "Подрядчик" ? null : source.category,
            source.model,
            source.regular ? `обычно ${regularText(source.regular)}` : null,
          ].filter(Boolean).join(" · ");
          return (
            <tr key={`${source.category}:${source.counterparty}`}>
              <td>
                {source.counterparty}
                {sub && <span className="budget-row-sub">{sub}</span>}
              </td>
              {source.shownByMonth.map((value, index) => <td key={months[index]} className={column(months[index] ?? "")}>{money(value)}</td>)}
              <td className="num">{money(source.totalMills)}</td>
            </tr>
          );
        })}
      </>
    );
  };
  return (
    <section className="card" aria-label="Трафик и подрядчики">
      <div className="card-header">
        <h2 className="card-title">Трафик и подрядчики</h2>
        {activeTotals && (
          <p className="card-description">
            {monthLong(active)}: вложено {formatMills(both(activeTotals))} — трафик {formatMills(activeTotals.trafficMills)}, подрядчики {formatMills(activeTotals.contractorMills)}
          </p>
        )}
      </div>
      {/* The plan of the month's growth spending (the caps the owner allowed) against what was put in. */}
      {caps.length > 0 && activeTotals && (
        <div className="budget-cap">
          <span className="budget-cap-name"><b>План: до {formatMills(capSum)}</b> · {caps.map((item) => item.name).join("; ")}</span>
          <span className="budget-bar" aria-hidden="true">
            <span className="budget-bar-fill" style={{ width: `${Math.min(100, shareOf(invested, capSum) ?? 0)}%`, background: SPENT }} />
          </span>
          <span className="budget-row-sum">вложено {formatMills(invested)}</span>
          <span className="budget-row-share">{share(invested, capSum)}</span>
          {invested > capSum && <span className="budget-row-sub budget-row-over">выше плана на {formatMills(sumMills([invested, -capSum]))}</span>}
        </div>
      )}
      {shown.length === 0 ? (
        <p className="card-body budget-empty">За эти месяцы платежей за трафик и подрядчикам нет.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table budget-promo" aria-label="Трафик и подрядчики по месяцам">
            <thead>
              <tr>
                <th scope="col">Кому платили</th>
                {months.map((key) => <th key={key} scope="col" className={column(key)}>{monthShort(key, key === months[0] || key.endsWith("-01"))}</th>)}
                <th scope="col" className="num">{first ? `Всего ${monthSince(first)}` : "Всего"}</th>
              </tr>
            </thead>
            <tbody>
              {group("traffic", "Трафик", (total) => total.trafficMills)}
              {group("contractor", "Подрядчики", (total) => total.contractorMills)}
              <tr className="row-total">
                <td>Итого</td>
                {totals.map((total) => <td key={total.month} className={column(total.month)}>{money(both(total))}</td>)}
                <td className="num">{money(allTime(both))}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
