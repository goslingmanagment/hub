import {
  TEAM_QUESTION_KIND_WORDS,
  type TeamQuestion,
  type TeamQuestionKind,
  type TeamQuestionsResponse,
  type TeamQuestionWriteResponse,
} from "@agency_hub_core/contracts";

import { demoError, type DemoHandlers, type DemoReply, type DemoRequest } from "../core.ts";
import { DEMO_USERS, demoUserByRole, type DemoUser } from "../world.ts";
import { HOUR } from "./team-world.ts";

/**
 * Вопросы тому, кто решает (products plan §4.6) in the demo: a small store for the browser's session. The team lead of
 * the demo decides every question of their pages; the chatter asks. Two to start with: one waiting for the lead, one the
 * lead answered. Invented words only.
 */

interface Kept {
  id: number;
  askerId: number;
  pageLabel: string;
  fanName: string | null;
  kind: TeamQuestionKind;
  text: string;
  deciderId: number | null;
  askedAt: number;
  state: "open" | "answered" | "withdrawn";
  answer: "yes" | "no" | null;
  answerText: string | null;
  answeredBy: number | null;
  answeredAt: number | null;
  seen: boolean;
}

let store: Kept[] | null = null;
let nextId = 40;

function seeded(now: number): Kept[] {
  if (store !== null) return store;
  const chatter = demoUserByRole("chatter");
  const lead = demoUserByRole("team_lead");
  store = [
    {
      id: 31, askerId: chatter.id, pageLabel: chatter.pages[0] ?? "mia-1", fanName: "Dominic", kind: "discount_over_50",
      text: "Фан просит 60 % на пак из трёх видео, тратит каждую неделю", deciderId: lead.id, askedAt: now - 0.7 * HOUR,
      state: "open", answer: null, answerText: null, answeredBy: null, answeredAt: null, seen: false,
    },
    {
      id: 30, askerId: chatter.id, pageLabel: chatter.pages[0] ?? "mia-1", fanName: null, kind: "swap",
      text: "Могу взять смену Кати в четверг вечером", deciderId: lead.id, askedAt: now - 20 * HOUR,
      state: "answered", answer: "yes", answerText: "Да, я поправлю график", answeredBy: lead.id, answeredAt: now - 18 * HOUR, seen: false,
    },
  ];
  return store;
}

const nameOf = (id: number | null) => DEMO_USERS.find((user) => user.id === id)?.name ?? "";
const viewerOf = (request: DemoRequest): DemoUser => demoUserByRole(request.narrow ? "chatter" : request.role);

function wire(kept: Kept, viewer: DemoUser, narrow: boolean): TeamQuestion {
  const owner = viewer.role === "owner" && !narrow;
  return {
    id: kept.id,
    kind: kept.kind,
    text: kept.text,
    pageLabel: kept.pageLabel,
    fan: kept.fanName === null ? null : { fanRef: null, name: kept.fanName },
    asker: { userId: kept.askerId, name: nameOf(kept.askerId) },
    decider: kept.deciderId === null ? { kind: "owner", name: "Владелец" } : { kind: "team_lead", name: nameOf(kept.deciderId) },
    door: "workboard",
    askedAt: new Date(kept.askedAt).toISOString(),
    state: kept.state,
    answer: kept.answer,
    answerText: kept.answerText,
    answeredBy: kept.answeredBy === null ? null : nameOf(kept.answeredBy),
    answeredAt: kept.answeredAt === null ? null : new Date(kept.answeredAt).toISOString(),
    seen: kept.seen,
    canAnswer: kept.state === "open" && (owner || kept.deciderId === viewer.id),
    mine: kept.askerId === viewer.id,
  };
}

function reads(kept: Kept, viewer: DemoUser, narrow: boolean): boolean {
  return (viewer.role === "owner" && !narrow) || kept.askerId === viewer.id || kept.deciderId === viewer.id;
}

/** The questions as matters of the demo's «Ждут вас» (matters.ts): the decider's while open, the asker's until read. */
export interface DemoAskMatter { kind: string; key: string; title: string; pages: string[]; owner: "team_lead" | number; evidence: Record<string, unknown>; link: string; agoMs: number }

export function demoAskMatters(now: number): DemoAskMatter[] {
  return seeded(now).flatMap((kept): DemoAskMatter[] => {
    const word = TEAM_QUESTION_KIND_WORDS[kept.kind].toLowerCase();
    if (kept.state === "open") {
      return [{ kind: "question.asked", key: `question.asked:${kept.id}`, title: `${nameOf(kept.askerId)} спрашивает: ${word}`, pages: [kept.pageLabel], owner: "team_lead", evidence: { questionId: kept.id, askedAt: new Date(kept.askedAt).toISOString() }, link: `/workboard/waiting?question=${kept.id}#asks`, agoMs: now - kept.askedAt }];
    }
    if (kept.state === "answered" && !kept.seen) {
      return [{ kind: "question.answered", key: `question.answered:${kept.id}`, title: `${kept.answer === "yes" ? "Можно" : "Нельзя"}: ${word}${kept.answerText ? `. ${kept.answerText}` : ""}`, pages: [kept.pageLabel], owner: kept.askerId, evidence: { questionId: kept.id }, link: `/workboard/waiting?question=${kept.id}#asks`, agoMs: now - (kept.answeredAt ?? now) }];
    }
    return [];
  });
}

const notFound = (): DemoReply => demoError(404, "Not Found", "No such question");

export const askHandlers: DemoHandlers = {
  teamQuestions: (request): TeamQuestionsResponse | DemoReply => {
    const viewer = viewerOf(request);
    const narrow = request.narrow === true;
    const list = seeded(request.now.getTime()).filter((kept) => reads(kept, viewer, narrow));
    const id = Number(request.query.id ?? Number.NaN);
    if (Number.isSafeInteger(id) && id > 0) {
      const one = list.find((kept) => kept.id === id);
      if (!one) return notFound();
      return { questions: [wire(one, viewer, narrow)], serverNow: request.now.toISOString() };
    }
    return { questions: list.map((kept) => wire(kept, viewer, narrow)), serverNow: request.now.toISOString() };
  },
  teamQuestionAsk: (request): TeamQuestionWriteResponse | DemoReply => {
    const viewer = viewerOf(request);
    const body = request.body as { pageLabel: string; kind: TeamQuestionKind; text: string; fanName?: string };
    const lead = demoUserByRole("team_lead");
    const kept: Kept = {
      id: nextId++, askerId: viewer.id, pageLabel: body.pageLabel, fanName: body.fanName ?? null, kind: body.kind, text: body.text,
      deciderId: viewer.id === lead.id ? null : lead.id, askedAt: request.now.getTime(), state: "open", answer: null, answerText: null,
      answeredBy: null, answeredAt: null, seen: false,
    };
    seeded(request.now.getTime()).unshift(kept);
    return { question: wire(kept, viewer, request.narrow === true), savedAt: request.now.toISOString() };
  },
  teamQuestionAnswer: (request): TeamQuestionWriteResponse | DemoReply => {
    const viewer = viewerOf(request);
    const kept = seeded(request.now.getTime()).find((one) => one.id === Number(request.params.id));
    if (!kept || !reads(kept, viewer, request.narrow === true)) return notFound();
    if (!wire(kept, viewer, request.narrow === true).canAnswer) return demoError(403, "Forbidden", "Only whoever decides answers it");
    const body = request.body as { answer: "yes" | "no"; text?: string };
    Object.assign(kept, { state: "answered", answer: body.answer, answerText: body.text ?? null, answeredBy: viewer.id, answeredAt: request.now.getTime() });
    return { question: wire(kept, viewer, false), savedAt: request.now.toISOString() };
  },
  teamQuestionClose: (request): TeamQuestionWriteResponse | DemoReply => {
    const viewer = viewerOf(request);
    const kept = seeded(request.now.getTime()).find((one) => one.id === Number(request.params.id));
    if (!kept || kept.askerId !== viewer.id) return notFound();
    const how = (request.body as { how: "withdraw" | "seen" }).how;
    if (how === "withdraw") kept.state = "withdrawn";
    else kept.seen = true;
    return { question: wire(kept, viewer, request.narrow === true), savedAt: request.now.toISOString() };
  },
};
