/**
 * Команда → Анкеты: the site's model questionnaire, invented. One model is typing
 * right now, one stopped an hour ago, two have sent it (one of them from a page
 * that reported no filling). Every moment is relative to the request.
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import { demoError, type DemoRequest, type DemoReply } from "../core.ts";

type Answer = KernelOperationResponse<"adminModelApplication">["answers"][number];
type Item = KernelOperationResponse<"adminModelApplications">["items"][number];

const MIN = 60_000;

interface Seed {
  ref: string;
  name: string;
  /** Minutes since she started and since her page last reported. */
  startedMin: number;
  updatedMin: number;
  status: Item["status"];
  applicationId: number | null;
  googleStatus: Item["googleStatus"];
  /** How many of the questions below she has answered. */
  answered: number;
  answers: readonly [string, string][];
}

const QUESTIONS: readonly { section: string; key: string; label: string }[] = [
  { section: "1. Основное", key: "name", label: "Имя или псевдоним" },
  { section: "1. Основное", key: "age", label: "Возраст" },
  { section: "1. Основное", key: "place", label: "Страна и город" },
  { section: "1. Основное", key: "telegram", label: "Telegram" },
  { section: "2. Опыт", key: "platforms", label: "Где уже работала" },
  { section: "2. Опыт", key: "experience", label: "Сколько времени в индустрии" },
  { section: "3. Съёмка", key: "camera", label: "Чем снимаете" },
  { section: "3. Съёмка", key: "hoursWeek", label: "Сколько часов в неделю готовы снимать" },
  { section: "4. Хобби", key: "hobbies", label: "Чем увлекаетесь" },
  { section: "4. Хобби", key: "about", label: "Пара слов о себе" },
];

const SEEDS: readonly Seed[] = [
  {
    ref: "6f1c2b9e-4d3a-4e8f-9b21-7c5d0a1e2f34", name: "Алина", startedMin: 14, updatedMin: 0.2,
    status: "filling", applicationId: null, googleStatus: null, answered: 7,
    answers: [["name", "Алина"], ["age", "22"], ["place", "Сербия / Нови-Сад"], ["telegram", "@alina_demo"], ["platforms", "Fansly, OnlyFans"], ["experience", "Полгода"], ["camera", "iPhone 15, кольцевая лампа"]],
  },
  {
    ref: "a83d5f10-2c6b-4f7e-8a19-3e4d5c6b7a80", name: "Вероника", startedMin: 95, updatedMin: 62,
    status: "abandoned", applicationId: null, googleStatus: null, answered: 4,
    answers: [["name", "Вероника"], ["age", "24"], ["place", "Грузия / Батуми"], ["telegram", "@nika_demo"]],
  },
  {
    ref: "c2e7b4a1-9f3d-4b6c-8e52-1d0a9b8c7e6f", name: "Mira", startedMin: 26 * 60, updatedMin: 25 * 60 + 40,
    status: "sent", applicationId: 3, googleStatus: "recorded", answered: 10,
    answers: [["name", "Mira"], ["age", "21"], ["place", "Польша / Вроцлав"], ["telegram", "@mira_demo"], ["platforms", "Нигде"], ["experience", "Нет опыта"], ["camera", "Samsung S23"], ["hoursWeek", "10–12"], ["hobbies", "Йога, рисование"], ["about", "Спокойная, люблю долгие разговоры.\nГотова учиться."]],
  },
  {
    ref: "2", name: "Дарья", startedMin: 3 * 24 * 60, updatedMin: 3 * 24 * 60,
    status: "sent", applicationId: 2, googleStatus: "failed", answered: 9,
    answers: [["name", "Дарья"], ["age", "23"], ["place", "Казахстан / Алматы"], ["telegram", "@dasha_demo"], ["platforms", "OnlyFans"], ["experience", "Два года"], ["camera", "iPhone 13"], ["hoursWeek", "20"], ["hobbies", "Танцы"]],
  },
];

function answersOf(seed: Seed): Answer[] {
  const given = new Map(seed.answers);
  return QUESTIONS.map((question) => ({ ...question, value: given.get(question.key) ?? "" }));
}

function itemOf(seed: Seed, now: number): Item {
  return {
    ref: seed.ref,
    name: seed.name,
    filled: seed.answered,
    total: QUESTIONS.length,
    section: seed.status === "sent" && /^\d+$/.test(seed.ref)
      ? null
      : QUESTIONS[Math.min(seed.answered, QUESTIONS.length - 1)]!.section.replace(/^\d+\.\s*/, ""),
    startedAt: new Date(now - Math.round(seed.startedMin * MIN)).toISOString(),
    updatedAt: new Date(now - Math.round(seed.updatedMin * MIN)).toISOString(),
    status: seed.status,
    applicationId: seed.applicationId,
    googleStatus: seed.googleStatus,
  };
}

const OWNER_ONLY = () => demoError(403, "Forbidden", "Анкеты видит только владелец.");

export function adminModelApplications(request: DemoRequest): KernelOperationResponse<"adminModelApplications"> | DemoReply {
  if (request.role !== "owner") return OWNER_ONLY();
  const now = request.now.getTime();
  return { serverNow: request.now.toISOString(), items: SEEDS.map((seed) => itemOf(seed, now)) };
}

export function adminModelApplication(request: DemoRequest): KernelOperationResponse<"adminModelApplication"> | DemoReply {
  if (request.role !== "owner") return OWNER_ONLY();
  const seed = SEEDS.find((candidate) => candidate.ref === request.params.ref);
  if (!seed) return demoError(404, "not_found", "No such questionnaire");
  return {
    ...itemOf(seed, request.now.getTime()),
    serverNow: request.now.toISOString(),
    googleError: seed.googleStatus === "failed" ? "HTTP 400" : null,
    answersFrom: seed.status === "sent" ? "submitted" : "snapshot",
    answers: answersOf(seed),
  };
}
