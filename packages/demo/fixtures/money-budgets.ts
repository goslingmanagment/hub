import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import { between, intBetween, rng, type DemoHandlers, type DemoRequest } from "../core.ts";
import { DEMO_DATA_PAGES, DEMO_MODELS } from "../world.ts";

/**
 * «Деньги → Бюджеты» (`adminBudgets`) of the invented agency, as the agency ledger would count it: nine months up to
 * the running one. Mia carries the agency, Nova started half a year ago and grows, Ivy earns too little to be paid out
 * (her money is «застряло»). The two oldest months are from before the ledger's books were whole (only the journal's
 * cash), the next ones are closed, the last one is over and not closed yet (a part is still on its way), the running
 * one has most of its money on hold. The last three months have a turnover plan by page, «AI и
 * разработка» has a limit it sometimes breaks, the running month has a reinvest cap. Traffic and contractors come and
 * go the way channels do. Invented names and sums only; every sum is whole cents.
 */

type Answer = KernelOperationResponse<"adminBudgets">;
type Month = Answer["months"][number];
type Article = NonNullable<Month["figures"]>["articles"][number];

const MONTHS = 9;
const MSK = 3 * 60 * 60 * 1000;
const cents = (dollars: number) => Math.round(dollars * 100);
/** Whole cents on the wire's mills. */
const wire = (value: number) => value * 10;

const MODEL_NAME = new Map(DEMO_MODELS.map((model) => [model.slug, model.name.split(" ")[0] ?? model.name]));

interface Promo {
  kind: "traffic" | "contractor";
  category: string;
  counterparty: string;
  model: string;
  /** Dollars paid in the month `back` months before the running one; 0 — nothing. `share` — how much of that month has passed. */
  paid: (back: number, share: number, random: () => number) => number;
  /** What the ledger expects to pay regularly: dollars and the ledger's word of the period. */
  regular?: { dollars: number; period: string };
}

/** A monthly fee: paid in full once the month is `after` through. */
const monthly = (amount: number, from: number, to: number, after = 0.1): Promo["paid"] =>
  (back, share) => (back <= from && back >= to && share >= after ? amount : 0);

const PROMO: readonly Promo[] = [
  { kind: "traffic", category: "Трафик", counterparty: "Northwind (Reddit)", model: "Mia", paid: monthly(700, 4, 0, 0.2), regular: { dollars: 700, period: "month" } },
  { kind: "traffic", category: "Трафик", counterparty: "Pixel Rounds (Twitter)", model: "Nova", paid: monthly(620, 1, 0, 0.3), regular: { dollars: 620, period: "month" } },
  { kind: "traffic", category: "Трафик", counterparty: "Bloomgram (Instagram)", model: "Mia", paid: monthly(290, 7, 3) },
  { kind: "traffic", category: "Трафик", counterparty: "Coral (паки фанов)", model: "Mia", paid: (back) => (back === 5 || back === 2 ? 300 : 0) },
  { kind: "contractor", category: "Подрядчик", counterparty: "SFS Helper", model: "Mia", paid: (_back, share, random) => Math.round(between(random, 96, 164) * share), regular: { dollars: 30, period: "week" } },
  { kind: "contractor", category: "Подрядчик", counterparty: "Sam (клипы для For You)", model: "Mia, Nova", paid: (back, share, random) => (back <= 5 && share > 0.45 ? intBetween(random, 180, 260) : 0) },
  { kind: "contractor", category: "Подрядчик", counterparty: "Аня (помощь с наймом)", model: "", paid: (back, share) => (back <= 3 ? Math.floor(share * 4) * 50 : 0), regular: { dollars: 50, period: "week" } },
];

function build(now: Date): Answer {
  const local = new Date(now.getTime() + MSK);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const keyOf = (back: number) => {
    const date = new Date(Date.UTC(year, month - back, 1));
    return { key: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`, days: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate() };
  };
  const runningDays = keyOf(0).days;
  const runningShare = Math.min(1, (local.getUTCDate() - 1 + local.getUTCHours() / 24) / runningDays);

  const backs = Array.from({ length: MONTHS }, (_, index) => MONTHS - 1 - index);
  const promoPaid = PROMO.map((promo) => backs.map((back) => cents(promo.paid(back, back === 0 ? runningShare : 1, rng(`budget-promo:${promo.counterparty}:${keyOf(back).key}`)))));

  const months: Month[] = backs.map((back, monthIndex) => {
    const { key, days } = keyOf(back);
    const share = back === 0 ? runningShare : 1;
    const random = rng(`budget:${key}`);

    // The pages' turnover: the agency grows a little every month, Nova started half a year ago.
    const pages = DEMO_DATA_PAGES.map((page) => {
      const started = page.modelSlug === "nova-lane" ? (back <= 5 ? 1 - 0.13 * back : 0) : 1 - 0.035 * back;
      return { page, turnover: cents(page.dailyNet * days * share * started * between(random, 0.9, 1.1)) };
    }).filter((row) => row.turnover > 0);
    const turnoverOf = (slug: string, platform: string) => pages.filter((row) => row.page.modelSlug === slug && row.page.platform === platform).reduce((sum, row) => sum + row.turnover, 0);
    const offPlatform = back !== 0 && random() < 0.6 ? cents(intBetween(random, 30, 90) * 10) : 0;
    const sources = [
      { model: "mia-hart", channel: "fansly" as const, channelName: "Fansly", turnover: turnoverOf("mia-hart", "fansly"), rate: 0.7 * 0.968 },
      { model: "mia-hart", channel: "onlyfans" as const, channelName: "OnlyFans", turnover: turnoverOf("mia-hart", "onlyfans"), rate: 0.7 * 0.958 },
      { model: "nova-lane", channel: "fansly" as const, channelName: "Fansly", turnover: turnoverOf("nova-lane", "fansly"), rate: 0.7 * 0.968 },
      { model: "ivy-rose", channel: "fansly" as const, channelName: "Fansly", turnover: turnoverOf("ivy-rose", "fansly"), rate: 0.7 * 0.908 },
      { model: "mia-hart", channel: "off_platform" as const, channelName: "вне платформ", turnover: offPlatform, rate: 0.7 },
    ].filter((source) => source.turnover > 0).map((source) => ({ ...source, earned: Math.round(source.turnover * source.rate) }));
    const turnover = sources.reduce((sum, source) => sum + source.turnover, 0);
    const earned = sources.reduce((sum, source) => sum + source.earned, 0);
    // Ivy's pages never reach the payout minimum.
    const stuck = sources.find((source) => source.model === "ivy-rose")?.earned ?? 0;
    const transit = Math.round((earned - stuck) * (back === 0 ? 0.86 : back === 1 ? 0.14 : 0));

    const chatterParts = [
      { name: "Mia", amountMills: wire(Math.round((turnoverOf("mia-hart", "fansly") + turnoverOf("mia-hart", "onlyfans")) * 0.21)) },
      { name: "Nova", amountMills: wire(Math.round(turnoverOf("nova-lane", "fansly") * 0.2)) },
      { name: "Сверх таблиц", amountMills: wire(random() < 0.55 ? cents(intBetween(random, 40, 320) * share) : 0) },
    ].filter((part) => part.amountMills > 0);
    const promoOf = (kind: Promo["kind"]) => PROMO.reduce((sum, promo, index) => sum + (promo.kind === kind ? promoPaid[index]?.[monthIndex] ?? 0 : 0), 0);
    const flat = (name: string, amount: number, capMills: number | null = null): Article => ({ key: name, name, amountMills: wire(amount), capMills, parts: [] });
    const articles: Article[] = [
      { key: "chatters", name: "Чаттеры", amountMills: chatterParts.reduce((sum, part) => sum + part.amountMills, 0), capMills: null, parts: chatterParts },
      flat("AI и разработка", cents(between(random, 760, 1340) * share), wire(cents(1000))),
      flat("КМ зарплата", share > 0.5 ? cents(600) : 0),
      flat("Трафик", promoOf("traffic")),
      flat("Подрядчик", promoOf("contractor")),
      flat("Инструменты", cents(between(random, 180, 330) * (back === 0 ? Math.max(share, 0.4) : 1))),
      flat("Комиссии", cents(between(random, 70, 170) * share)),
      flat("Прочее", random() < 0.7 ? cents(intBetween(random, 4, 22) * 10) : 0),
      flat("Возврат расхода", back !== 0 && random() < 0.35 ? -cents(intBetween(random, 40, 130)) : 0),
    ].filter((article) => article.amountMills !== 0 || article.capMills !== null).sort((a, b) => b.amountMills - a.amountMills);
    const expensesMills = articles.reduce((sum, article) => sum + article.amountMills, 0);
    const decisionMills = wire(earned - stuck) - expensesMills;
    const rateMills = wire(cents(back >= 6 ? 3000 : back >= 4 ? 3500 : back >= 2 ? 4000 : 4500));

    const planPages = back > 2 ? [] : DEMO_DATA_PAGES.filter((page) => page.dailyNet >= 50).map((page) => {
      const perDay = Math.round((page.dailyNet * (1.06 - 0.03 * back)) / 5) * 5;
      return { pageLabel: page.label, perDayMills: wire(cents(perDay)), planMills: wire(cents(perDay * days)) };
    }).sort((a, b) => b.planMills - a.planMills);

    // The two oldest months: before the ledger's books were whole. Only the journal's cash, by model; no pages, plan or CEO rate.
    if (back >= MONTHS - 2) {
      const cashArticles = articles.map((article) => ({ ...article, capMills: null, parts: [] })).filter((article) => article.amountMills !== 0);
      const spent = cashArticles.reduce((sum, article) => sum + article.amountMills, 0);
      const byModel = new Map<string, number>();
      for (const source of sources) byModel.set(source.model, (byModel.get(source.model) ?? 0) + source.earned);
      return {
        month: key,
        state: "incomplete",
        closedAt: null,
        daysInMonth: days,
        elapsedShare: 1,
        figures: {
          turnoverMills: wire(earned), earnedMills: wire(earned), arrivedMills: wire(earned), transitMills: 0, stuckMills: 0,
          sources: [...byModel].map(([model, amount]) => ({ model: MODEL_NAME.get(model) ?? model, channel: "other" as const, channelName: "Платформы", turnoverMills: wire(amount), earnedMills: wire(amount) }))
            .sort((a, b) => b.earnedMills - a.earnedMills),
          pages: [],
          expensesMills: spent,
          articles: cashArticles,
          decisionMills: wire(earned) - spent,
          leftMills: wire(earned) - spent,
          notes: [],
        },
        unknownReason: null,
        owner: { salaryRateMills: null, salaryPaidMills: 0, drawMills: 0, injectionMills: back === MONTHS - 1 ? wire(cents(3000)) : 0 },
        plan: { turnoverMills: null, factMills: null, pages: [], reinvest: [] },
      };
    }

    return {
      month: key,
      state: back === 0 ? "open" : back === 1 ? "preliminary" : "closed",
      closedAt: back <= 1 ? null : new Date(Date.UTC(year, month - back + 1, 14, 9, 0, 0)).toISOString(),
      daysInMonth: days,
      elapsedShare: share,
      figures: {
        turnoverMills: wire(turnover),
        earnedMills: wire(earned),
        arrivedMills: wire(earned - stuck - transit),
        transitMills: wire(transit),
        stuckMills: wire(stuck),
        sources: sources.map((source) => ({
          model: MODEL_NAME.get(source.model) ?? source.model, channel: source.channel, channelName: source.channelName,
          turnoverMills: wire(source.turnover), earnedMills: wire(source.earned),
        })).sort((a, b) => b.earnedMills - a.earnedMills),
        pages: pages.map((row) => ({ pageLabel: row.page.label, turnoverMills: wire(row.turnover) })).sort((a, b) => b.turnoverMills - a.turnoverMills),
        expensesMills,
        articles,
        decisionMills,
        leftMills: decisionMills - rateMills,
        notes: ["mia-tg не подключена к хабу — не видим"],
      },
      unknownReason: null,
      owner: {
        salaryRateMills: rateMills,
        salaryPaidMills: back === 0 ? Math.floor((rateMills * Math.min(1, share + 0.2)) / 5_000) * 5_000 : rateMills,
        drawMills: back !== 0 && back % 3 === 1 ? wire(cents(intBetween(random, 20, 50) * 100)) : 0,
        injectionMills: back === MONTHS - 1 ? wire(cents(3000)) : 0,
      },
      plan: {
        turnoverMills: planPages.length === 0 ? null : planPages.reduce((sum, page) => sum + page.planMills, 0),
        factMills: planPages.length === 0 ? null : wire(pages.filter((row) => planPages.some((page) => page.pageLabel === row.page.label)).reduce((sum, row) => sum + row.turnover, 0)),
        pages: planPages,
        reinvest: back === 0 ? [{ name: "Реинвест: рост Mia, Reddit и Twitter", capMills: wire(cents(2500)) }] : [],
      },
    };
  });

  const monthKeys = months.map((item) => item.month);
  const promoSources = PROMO.map((promo, index) => {
    const byMonth = (promoPaid[index] ?? []).map(wire);
    return {
      kind: promo.kind, category: promo.category, counterparty: promo.counterparty, model: promo.model,
      byMonth, totalMills: byMonth.reduce((sum, value) => sum + value, 0), payments: byMonth.filter((value) => value > 0).length,
      regular: promo.regular ? {
        amountMills: wire(cents(promo.regular.dollars)), period: promo.regular.period,
        monthlyMills: wire(cents(promo.regular.period === "week" ? (promo.regular.dollars * 52) / 12 : promo.regular.dollars)),
      } : null,
    };
  }).filter((source) => source.totalMills > 0).sort((a, b) => b.totalMills - a.totalMills);

  return {
    months,
    promotion: {
      months: monthKeys,
      sources: promoSources,
      totals: monthKeys.map((key, index) => ({
        month: key,
        trafficMills: promoSources.filter((source) => source.kind === "traffic").reduce((sum, source) => sum + (source.byMonth[index] ?? 0), 0),
        contractorMills: promoSources.filter((source) => source.kind === "contractor").reduce((sum, source) => sum + (source.byMonth[index] ?? 0), 0),
      })),
    },
    ledgerAsOf: new Date(now.getTime() - 47 * 60 * 1000).toISOString(),
    serverNow: now.toISOString(),
  };
}

function adminBudgets(request: DemoRequest): Answer {
  return build(request.now);
}

export const budgetsHandlers: DemoHandlers = { adminBudgets };
