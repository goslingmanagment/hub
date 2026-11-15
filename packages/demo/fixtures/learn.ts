import type { LearnPageMeta, LearnPageResponse, LearnPagesResponse } from "@agency_hub_core/contracts";

import { demoError, type DemoHandlers, type DemoReply, type DemoRequest } from "../core.ts";
import { DAY } from "./team-world.ts";

/**
 * «Обучение» (products plan §2.3) in the demo: three pages an agent published (section `learn`), one of them not yet
 * approved by the owner; the owner's switch is kept for the browser's session. `hub-demo-scenario=learn-0` — none
 * published. Invented words only.
 */

interface Kept { slug: string; title: string; body: string; daysAgo: number; version: number; approved: boolean }

const PAGES: Kept[] = [
  {
    slug: "chatter-job", title: "Инструкция чаттера", daysAgo: 3, version: 4, approved: true,
    body: "## Смена\n\nСмена начинается сама, когда вы начинаете писать в чатах. В конце смены нажмите «Отчёт» в расширении и сдайте смену.\n\n## Что решает тимлид\n\n- скидка больше 50 %;\n- отправить платное бесплатно;\n- цена кастома и условия киту.\n\nСпросите через «Ждут вас» → «Спросить», ответ придёт туда же.\n",
  },
  {
    slug: "ppv-prices", title: "Цены PPV", daysAgo: 6, version: 2, approved: true,
    body: "## Цены\n\n| Что | Цена |\n|---|---|\n| фото-сет | от $10 |\n| видео до 5 минут | от $25 |\n\nЦены ниже согласуйте с тимлидом.\n",
  },
  {
    slug: "customs-howto", title: "Кастомы: от заказа до отдачи", daysAgo: 1, version: 1, approved: false,
    body: "## Как записать кастом\n\nЗапишите заказ из панели фана: «Записать кастом». Фан подставится сам.\n",
  },
];

const approvals = new Map<string, boolean>();
const approvedOf = (page: Kept) => approvals.get(page.slug) ?? page.approved;
const owner = (request: DemoRequest) => request.role === "owner" && request.narrow !== true;

function meta(page: Kept, request: DemoRequest): LearnPageMeta {
  const publishedAt = new Date(request.now.getTime() - page.daysAgo * DAY).toISOString();
  return {
    slug: page.slug, title: page.title, section: "learn", teamLeads: false, validHours: null, version: page.version,
    publishedAt, publishedBy: { agentKeyId: 7, name: "Генгар" }, bytes: page.body.length, staleAt: null, stale: false, approved: approvedOf(page),
  };
}

function visible(request: DemoRequest): Kept[] {
  if (request.scenario === "learn-0") return [];
  return PAGES.filter((page) => owner(request) || approvedOf(page));
}

export const learnHandlers: DemoHandlers = {
  learnPages: (request): LearnPagesResponse => ({ pages: visible(request).map((page) => meta(page, request)), canApprove: owner(request), serverNow: request.now.toISOString() }),
  learnPage: (request): LearnPageResponse | DemoReply => {
    const page = visible(request).find((one) => one.slug === request.params.slug);
    if (!page) return demoError(404, "Not Found", "No such page");
    return { page: { ...meta(page, request), body: page.body }, canApprove: owner(request), serverNow: request.now.toISOString() };
  },
  learnPageApprove: (request) => {
    if (!owner(request)) return demoError(403, "Forbidden", "Only the owner approves «Обучение»");
    const page = PAGES.find((one) => one.slug === request.params.slug);
    if (!page) return demoError(404, "Not Found", "No such page");
    approvals.set(page.slug, (request.body as { approved: boolean }).approved);
    return { page: meta(page, request), savedAt: request.now.toISOString() };
  },
};
