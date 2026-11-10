import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import { demoError, type DemoHandlers, type DemoReply, type DemoRequest } from "../core.ts";
import { demoFans } from "../world.ts";
import { DAY, HOUR } from "./team-world.ts";

/**
 * The open questions «whose is this sale» the team's chat agent asked (`teamLedgerQuestions`, the owner's «Решения →
 * Чья продажа»), as the agency ledger keeps them. Four wait for the owner — a custom two chatters worked on (the sum
 * and the sale known, waiting past a week), a sale that has not happened yet, a paid PPV with a long note, a tip
 * with the message in the chat — and two the chatters settle among themselves. The fans are the demo pages' own.
 * Invented names, amounts and chat only.
 */

type Answer = KernelOperationResponse<"teamLedgerQuestions">;
type Question = Answer["owner"][number];

interface Seed {
  id: number;
  page: string;
  /** The index of the page's fan (demoFans). */
  fan: number;
  netCents: number | null;
  /** Days before now the sale was; null — not paid yet. */
  soldDaysAgo: number | null;
  askedDaysAgo: number;
  askedOf: "owner" | "chatters";
  who: string;
  question: string;
  note: string;
  link: boolean;
}

/** The team chat's thread of the agent, invented. */
const CHAT = "https://t.me/c/1000000000/12";

const SEEDS: readonly Seed[] = [
  {
    id: 301,
    page: "mia-1",
    fan: 3,
    netCents: 18_000,
    soldDaysAgo: 12.6,
    askedDaysAgo: 12.4,
    askedOf: "owner",
    who: "alex.k, kate.v",
    question: "Кастом-видео делали двое: alex.k договорился о цене и сценарии, kate.v записала с моделью и отдала фану. Чья продажа — пополам или целиком одному?",
    note: "alex.k вёл переписку до оплаты, kate.v была на смене, когда пришла оплата.",
    link: false,
  },
  {
    id: 305,
    page: "mia-1",
    fan: 6,
    netCents: 6_400,
    soldDaysAgo: 8.9,
    askedDaysAgo: 8.6,
    askedOf: "owner",
    who: "kate.v, alex.k",
    question: "PPV отправила kate.v, купил фан на следующий день на смене alex.k, после его напоминания. Чья продажа?",
    note: "kate.v отправила платное в 23:40, в конце своей смены; фан ответил «посмотрю завтра». Утром alex.k напомнил ему про видео и предложил скидку 10 %, "
      + "фан купил через 20 минут — по полной цене, скидку не взял. По правилу отправителя продажа kate.v, но напоминание alex.k явно помогло; в похожем "
      + "случае на прошлой неделе вы решили пополам. Если решите так же, запишу пополам и предложу сделать это правилом для PPV, купленных на следующей смене.",
    link: false,
  },
  {
    id: 312,
    page: "nova-1",
    fan: 1,
    netCents: null,
    soldDaysAgo: null,
    askedDaysAgo: 2.3,
    askedOf: "owner",
    who: "den.s",
    question: "Фан договорился с den.s о кастоме на $120, но оплатит после выходных, когда на nova-1 будет другой чаттер. Чья будет продажа, когда он оплатит?",
    note: "Фан обещал оплатить в понедельник.",
    link: false,
  },
  {
    id: 318,
    page: "ivy-1",
    fan: 2,
    netCents: 2_500,
    soldDaysAgo: 0.21,
    askedDaysAgo: 0.13,
    askedOf: "owner",
    who: "ivan.p",
    question: "Чаевые пришли через 3 минуты после конца смены ivan.p, следующей смены на ivy-1 не было. Записать ему или в Общак?",
    note: "",
    link: true,
  },
  {
    id: 309,
    page: "mia-3",
    fan: 5,
    netCents: 4_000,
    soldDaysAgo: 1.5,
    askedDaysAgo: 1.2,
    askedOf: "chatters",
    who: "kate.v, alex.k",
    question: "kate.v и alex.k оба писали фану в пересменку; кому записать продажу?",
    note: "Договорятся между собой до конца недели.",
    link: true,
  },
  {
    id: 314,
    page: "mia-2",
    fan: 8,
    netCents: null,
    soldDaysAgo: null,
    askedDaysAgo: 3.8,
    askedOf: "chatters",
    who: "alex.k",
    question: "Фото-кастом начинала lena.r до ухода, заканчивает alex.k. Кому будет продажа, когда фан оплатит?",
    note: "",
    link: false,
  },
];

function questionOf(seed: Seed, now: number): Question {
  const fans = demoFans(seed.page);
  const fan = fans[seed.fan % Math.max(1, fans.length)];
  const sold = seed.soldDaysAgo === null || seed.netCents === null ? null : now - Math.round(seed.soldDaysAgo * DAY);
  return {
    id: seed.id,
    pageLabel: seed.page,
    fanRef: fan?.platformUserId ?? null,
    fanName: fan?.displayName ?? null,
    transactionRef: sold === null ? null : `demo-tx-${seed.id}`,
    netMills: seed.netCents === null || sold === null ? null : seed.netCents * 10,
    occurredAt: sold === null ? null : new Date(sold).toISOString(),
    question: seed.question,
    who: seed.who,
    askedAt: new Date(now - Math.round(seed.askedDaysAgo * DAY) - HOUR / 4).toISOString(),
    sourceLink: seed.link ? `${CHAT}/${4000 + seed.id}` : null,
    note: seed.note,
  };
}

function teamLedgerQuestions(request: DemoRequest): Answer | DemoReply {
  if (request.role !== "owner") return demoError(403, "Forbidden", "Вопросы «чья продажа» видит только владелец.");
  const now = request.now.getTime();
  const all = SEEDS.map((seed) => ({ seed, question: questionOf(seed, now) }));
  const oldestFirst = (left: Question, right: Question) => left.askedAt.localeCompare(right.askedAt) || left.id - right.id;
  return {
    owner: all.filter((one) => one.seed.askedOf === "owner").map((one) => one.question).sort(oldestFirst),
    chatters: all.filter((one) => one.seed.askedOf === "chatters").map((one) => one.question).sort(oldestFirst),
    questionsRead: true,
    serverNow: request.now.toISOString(),
  };
}

export const teamQuestionsHandlers: DemoHandlers = { teamLedgerQuestions };
