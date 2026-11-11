/**
 * Деньги → Бюджеты in the invented agency: five months of its ledger, the
 * oldest before full accounting. Turnover is the pages' own daily net (the same
 * numbers as the home), income are the models' weekly withdrawals of it,
 * expenses follow it; plans are written for every month, the current one too.
 * The owner's plan writes are kept in memory until the server restarts.
 */
import type { KernelOperationResponse, MoneyBudgetRow } from "@agency_hub_core/contracts";
import { between, demoError, intBetween, microUsd, pick, rng, type DemoHandlers, type DemoRequest } from "../core.ts";
import { DEMO_DATA_PAGES, demoDailyNet } from "../world.ts";

type Answer = KernelOperationResponse<"adminMoneyBudgets">;
type Month = Answer["months"][number];

const MODEL_NAMES: Readonly<Record<string, string>> = { Mia: "Mia Hart", Nova: "Nova Lane", Ivy: "Ivy Rose" };
const CHATTERS = ["Кирилл", "Олег", "Марта", "Влад"] as const;
const MONTHS_BACK = 4;

/** The owner's plans written in the demo: `${month}|${item}` → micro-USD, null — removed. */
const planWrites = new Map<string, number | null>();

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function addMonths(month: string, delta: number): string {
  const [year, mm] = month.split("-").map(Number) as [number, number];
  const date = new Date(Date.UTC(year, mm - 1 + delta, 1));
  return monthKey(date);
}

function daysIn(month: string): number {
  const [year, mm] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, mm, 0)).getUTCDate();
}

function day(month: string, d: number): string {
  return `${month}-${String(d).padStart(2, "0")}`;
}

/** A page's net over the month's days up to `last` (a day of the month), dollars. */
function pageNet(label: string, month: string, last: number): number {
  if (last <= 0) return 0;
  const end = new Date(`${day(month, last)}T12:00:00Z`);
  return demoDailyNet(label, end, last).reduce((sum, item) => sum + item.net, 0);
}

/** A model's net over the 7 days before `date`, dollars. */
function weekNet(modelSlug: string, date: string): number {
  const end = new Date(`${date}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  return DEMO_DATA_PAGES.filter((page) => page.modelSlug === modelSlug)
    .reduce((sum, page) => sum + demoDailyNet(page.label, end, 7).reduce((total, item) => total + item.net, 0), 0);
}

const round = (dollars: number, step = 1) => Math.round(dollars / step) * step;

interface Draft {
  date: string;
  kind: MoneyBudgetRow["kind"];
  category: string;
  counterparty: string;
  model?: string;
  dollars: number;
  channel?: string;
  note?: string;
  advanceFrom?: string;
}

/** The month's paid rows up to `last`; the owner's advance for the next month is the next month's. */
function rowsOf(month: string, last: number, index: number): Draft[] {
  const random = rng(`budget:${month}`);
  const out: Draft[] = [];
  const add = (d: number, draft: Omit<Draft, "date">) => {
    if (d <= last) out.push({ ...draft, date: day(month, d) });
  };
  const days = daysIn(month);

  // Income: the models' withdrawals of their own pages, the agency's 70 %.
  for (const d of [3, 10, 17, 24, 31].filter((x) => x <= days)) {
    add(d, { kind: "income", category: "Платформы", counterparty: "Mia Hart", model: "Mia", dollars: round(weekNet("mia-hart", day(month, d)) * 0.7) });
  }
  for (const d of [6, 13, 20, 27].filter((x) => x <= days)) {
    add(d, { kind: "income", category: "Платформы", counterparty: "Nova Lane", model: "Nova", dollars: round(weekNet("nova-lane", day(month, d)) * 0.7) });
  }
  add(15, { kind: "income", category: "Платформы", counterparty: "Payout Desk", model: "Ivy", dollars: round(weekNet("ivy-rose", day(month, 15)) * 4.2, 0.01), note: "вывод Ivy через агента выплат" });
  for (let i = 0; i < intBetween(random, 1, 3); i += 1) {
    add(intBetween(random, 2, days), { kind: "income", category: "Custom", counterparty: pick(random, ["Фан (кастом)", "Фан (видео)", "Фан (крипта)"]), model: "Mia", dollars: round(between(random, 120, 450)), note: "кастом мимо платформ" });
  }
  if (index === 2) add(19, { kind: "income", category: "Рефералы", counterparty: "Реферальная программа", model: "Nova", dollars: 214.6 });

  // The team.
  // Each chatter: a quarter of their pages' week, the two of Mia's splitting hers, plus a fix per shift.
  for (const d of [2, 9, 16, 23, 30].filter((x) => x <= days)) {
    const week = { Mia: weekNet("mia-hart", day(month, d)) * 0.25 / 2, Nova: weekNet("nova-lane", day(month, d)) * 0.25, Ivy: 60 };
    for (const [i, name] of CHATTERS.entries()) {
      const model = i < 2 ? "Mia" : i === 2 ? "Nova" : "Ivy";
      add(d, { kind: "expense", category: "Чаттер зарплата", counterparty: name, model, dollars: round(week[model] * between(random, 0.9, 1.1) + 50, 0.5), note: "25 % выручки смен за неделю + фикс" });
    }
  }
  const ceoRate = 3000 + index * 250;
  const tranches = index === MONTHS_BACK ? 3 : 5;
  for (let i = 0; i < tranches; i += 1) {
    add(1 + i * 2, { kind: "expense", category: "Owner зарплата", counterparty: "Владелец", dollars: round(ceoRate / 5, 0.0001), note: `транш зарплаты CEO ${i + 1}` });
  }
  add(7, { kind: "expense", category: "КМ зарплата", counterparty: "Ника", model: "Mia", dollars: 300, note: "КМ Fansly" });

  // Traffic: paid channels and the contractors whose work is traffic.
  if (index >= 1) add(4, { kind: "expense", category: "Трафик", counterparty: "Studio North", model: "Mia", dollars: 290, channel: "Instagram", note: "ведение основной инсты, месяц" });
  if (index === 2) add(12, { kind: "expense", category: "Трафик", counterparty: "RedLift", model: "Mia", dollars: 520, channel: "Reddit", note: "перезапуск Reddit, первый месяц" });
  if (index >= 3) add(8, { kind: "expense", category: "Трафик", counterparty: "Tweetwave", model: "Mia", dollars: index === 3 ? 350 : 420, channel: "Twitter", note: "Twitter-раунды" });
  if (index === 1 || index === 3) add(18, { kind: "expense", category: "Трафик", counterparty: "PackHouse", model: "Nova", dollars: 300, channel: "Порнтоки", note: "пак на 500 фанов" });
  for (const d of [5, 12, 19, 26].filter((x) => x <= days)) {
    add(d, { kind: "expense", category: "Подрядчик", counterparty: "FanFlow", model: "Mia", dollars: round(between(random, 22, 40)), channel: "SFS", note: "SFS за неделю, $0.41 за фана" });
    if (index >= 2) add(d, { kind: "expense", category: "Подрядчик", counterparty: "ClipHouse", model: "Nova", dollars: 60, channel: "FYP", note: "FYP-постинг, неделя" });
    add(d, { kind: "expense", category: "Подрядчик", counterparty: "Ассистент", dollars: 50, note: "HR-помощник, неделя" });
  }

  // Tools and AI.
  add(3, { kind: "expense", category: "AI и разработка", counterparty: "Anthropic", dollars: 200, note: "пополнение счёта" });
  add(14, { kind: "expense", category: "AI и разработка", counterparty: "Anthropic", dollars: round(between(random, 180, 260), 0.01), note: "пополнение счёта" });
  add(21, { kind: "expense", category: "AI и разработка", counterparty: "OpenAI", dollars: 98.45 });
  add(11, { kind: "expense", category: "AI и разработка", counterparty: "Сервер", dollars: 32.36, note: "VPS, два месяца" });
  if (index % 3 === 0) add(2, { kind: "expense", category: "Инструменты", counterparty: "CRM", dollars: 217, note: "предоплата на 3 месяца" });
  add(10, { kind: "expense", category: "Инструменты", counterparty: "Прокси", dollars: 70.5 });
  add(11, { kind: "expense", category: "Инструменты", counterparty: "Аналитика фанов", dollars: 61.45 });
  for (let i = 0; i < 9; i += 1) add(intBetween(random, 1, days), { kind: "expense", category: "Комиссии", counterparty: "Биржа", dollars: round(between(random, 1, 4.5), 0.01), note: "сетевая комиссия" });
  add(16, { kind: "expense", category: "Прочее", counterparty: "Mia Hart", model: "Mia", dollars: round(between(random, 40, 160)), note: "покупки для контента" });
  add(16, { kind: "expense", category: "Доля модели", counterparty: "Ivy Rose", model: "Ivy", dollars: round(weekNet("ivy-rose", day(month, 15)) * 4.2 * 0.3, 0.01), note: "30 % от вывода" });

  // The owner's money and refunds.
  if (index === 1 || index === 3) add(20, { kind: "owner_out", category: "Owner draw", counterparty: "Владелец", dollars: index === 1 ? 3000 : 4500, note: "в личный резерв" });
  if (index === 0) add(9, { kind: "owner_in", category: "Owner вливание", counterparty: "Владелец", dollars: 500, note: "старт бюджета" });
  if (index === 2) add(22, { kind: "refund", category: "Возврат расхода", counterparty: "Сервис", dollars: 98.83, note: "возврат подписки" });
  return out;
}

/** The plans of a month: the owner's, the demo's writes over them. */
function plansOf(month: string, index: number, ceoRate: number): Month["plans"] {
  const base: Array<[string, number, string]> = [
    ["Доход", 36000 + index * 1000, "на базе «заработано»"],
    ["Чаттер зарплата", 10500 + index * 300, "25 % выручки + фикс за смены"],
    ["Owner зарплата", ceoRate, ""],
    ["КМ зарплата", 300, ""],
    ["Трафик", index >= 3 ? 1000 : 600, index >= 3 ? "рост Mia: Twitter + пак" : ""],
    ["Подрядчик", index >= 2 ? 650 : 400, "SFS, FYP по факту, HR"],
    ["AI и разработка", 1000, "лимит в месяц"],
    ["Инструменты", 300, ""],
    ["Комиссии", 40, ""],
    ["Прочее", 150, ""],
  ];
  const plans = new Map<string, Month["plans"][number]>();
  if (index > 0) {
    for (const [item, dollars, note] of base) plans.set(item, { item, planMicroUsd: microUsd(dollars), note, source: "plan", setAt: `${month}-01T10:00:00+03:00` });
  } else {
    plans.set("Owner зарплата", { item: "Owner зарплата", planMicroUsd: microUsd(ceoRate), note: "ставка CEO", source: "rate", setAt: null });
  }
  for (const [key, value] of planWrites) {
    const [m, item] = key.split("|") as [string, string];
    if (m !== month) continue;
    if (value === null) plans.delete(item);
    else plans.set(item, { item, planMicroUsd: value, note: "", source: "plan", setAt: new Date().toISOString() });
  }
  return [...plans.values()].sort((left, right) => left.item.localeCompare(right.item));
}

function adminMoneyBudgets(request: DemoRequest): Answer {
  const today = request.now.toISOString().slice(0, 10);
  const current = today.slice(0, 7);
  const first = addMonths(current, -MONTHS_BACK);
  const drafts = new Map<string, Draft[]>();
  for (let index = 0; index <= MONTHS_BACK; index += 1) {
    const month = addMonths(first, index);
    const last = month === current ? Number(today.slice(8, 10)) : daysIn(month);
    drafts.set(month, [...(drafts.get(month) ?? []), ...rowsOf(month, last, index)]);
  }
  // The owner's advance for the current month, paid on the last day of the month before.
  const previous = addMonths(current, -1);
  for (const n of [1, 2]) {
    drafts.get(current)!.push({ date: day(previous, daysIn(previous)), kind: "expense", category: "Owner зарплата", counterparty: "Владелец", dollars: 650, note: `аванс зарплаты CEO за следующий месяц, транш ${n}`, advanceFrom: previous });
  }

  let num = 100;
  const months: Month[] = [];
  for (let index = 0; index <= MONTHS_BACK; index += 1) {
    const month = addMonths(first, index);
    const days = daysIn(month);
    const elapsed = month === current ? Number(today.slice(8, 10)) : days;
    const rows: MoneyBudgetRow[] = drafts.get(month)!.sort((left, right) => left.date.localeCompare(right.date)).map((draft) => ({
      num: (num += 1),
      date: draft.date,
      kind: draft.kind,
      category: draft.category,
      counterparty: draft.counterparty,
      model: draft.model ?? "",
      amountMicroUsd: microUsd(draft.dollars),
      channel: draft.channel ?? null,
      note: draft.note ?? "",
      incomplete: false,
      advanceFrom: draft.advanceFrom ?? null,
    }));
    const planned = index >= MONTHS_BACK - 1;
    const pages = DEMO_DATA_PAGES.map((page) => {
      const net = pageNet(page.label, month, elapsed);
      const plan = planned ? microUsd(round(page.dailyNet * (index === MONTHS_BACK ? 1.05 : 0.95), 5)) : null;
      return { pageLabel: page.label, modelName: page.modelName, platform: page.platform, netMicroUsd: microUsd(round(net, 0.01)), planPerDayMicroUsd: plan };
    }).filter((page) => page.netMicroUsd !== 0 || page.planPerDayMicroUsd !== null)
      .sort((left, right) => right.netMicroUsd - left.netMicroUsd);
    const turnover = pages.reduce((sum, page) => sum + page.netMicroUsd, 0);
    const spentNoCeo = rows.filter((row) => row.kind === "expense" && row.category !== "Owner зарплата").reduce((sum, row) => sum + row.amountMicroUsd, 0)
      - rows.filter((row) => row.kind === "refund").reduce((sum, row) => sum + row.amountMicroUsd, 0);
    const earned = Math.round(turnover * 0.69);
    const closed = index < MONTHS_BACK - 1;
    const decision = earned - spentNoCeo;
    months.push({
      month,
      days,
      elapsedDays: elapsed,
      closed,
      complete: index > 0,
      rows,
      plans: plansOf(month, index, 3000 + index * 250),
      pages,
      result: index === 0 ? null : {
        turnoverMicroUsd: turnover,
        earnedMicroUsd: earned,
        expensesMicroUsd: spentNoCeo,
        decisionMicroUsd: decision,
        decisionAtCloseMicroUsd: closed ? decision - microUsd(round(between(rng(`close:${month}`), 0, 40), 0.01)) : null,
      },
    });
  }
  return {
    months,
    currentMonth: current,
    fullLedgerFrom: `${addMonths(first, 1)}-01`,
    modelNames: MODEL_NAMES,
    generatedAt: request.now.toISOString(),
  };
}

function adminMoneyBudgetPlansSet(request: DemoRequest): KernelOperationResponse<"adminMoneyBudgetPlansSet"> | ReturnType<typeof demoError> {
  const body = request.body as { plans?: Array<{ month: string; item: string; planMicroUsd: number | null }> } | null;
  if (!body?.plans?.length) return demoError(400, "Bad Request", "нет ни одного плана");
  for (const plan of body.plans) planWrites.set(`${plan.month}|${plan.item.trim()}`, plan.planMicroUsd);
  return { written: body.plans.length, unchanged: 0 };
}

export const moneyBudgetsHandlers: DemoHandlers = { adminMoneyBudgets, adminMoneyBudgetPlansSet };
