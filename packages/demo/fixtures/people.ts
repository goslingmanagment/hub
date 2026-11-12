import type { KernelOperationResponse, PersonPayTerm, PersonProposal, PersonScheduleSlot } from "@agency_hub_core/contracts";

import { demoError, iso, isoDay, daysAgo, hoursAgo, queryString, type DemoHandlers, type DemoRequest } from "../core.ts";
import { DEMO_PAGES, demoPage } from "../world.ts";
import { ownerOnly } from "./settings-common.ts";
import { OWNER_CHAT_LOGIN, teamUsers } from "./settings.ts";

/**
 * The people registry in the invented agency (contracts people.ts): one record
 * per person, the owner one person with two logins (the console's `owner` and
 * the extension's `owner.chat`), a content manager and a traffic contractor
 * with no login at all, a chatter who left, one invited, two agents with their
 * keys and a capture server held as a service. One chatter's working pages are
 * narrower than her access, as in life, and one has an earlier end on one page.
 * The owner's card carries the pay terms (money: the owner's only); the team's
 * list never does. Writes are accepted and change nothing: a reload shows the
 * agency as before.
 */

type TeamPeople = KernelOperationResponse<"teamPeople">;
type Person = TeamPeople["people"][number];
type AdminPerson = KernelOperationResponse<"adminPerson">;

interface SlotSpec {
  page?: string;
  start: string;
  end: string;
  weekdays: PersonScheduleSlot["weekdays"];
  /** Days back the slot began; null — not known. */
  fromDays: number | null;
  /** Days back it ended; absent — it holds. */
  toDays?: number;
}

interface PersonSpec {
  id: number;
  code: string;
  name: string;
  kind: Person["kind"];
  role: Person["role"];
  state: Person["state"];
  logins: number[];
  /** Agent keys of the demo's «Доступ ИИ-агентов» (system.ts): id and name. */
  keys?: { id: number; name: string; state: "active" | "expired" | "revoked" }[];
  pages: string[];
  slots: SlotSpec[];
  telegram?: { userId: number; handle: string; tag: string | null };
  rights?: "customs_lead"[];
  leftDaysAgo?: number;
  note?: string;
  notes?: Person["importNotes"];
  origin?: Person["origin"];
  onboarding?: { step: string; doneDays: number | null }[];
  /** Pay terms: share in basis points, fix per shift in mills, from N days back. */
  terms?: { model: string; share: number; fix: number; fromDays: number }[];
}

const WEEK: PersonScheduleSlot["weekdays"] = ["mon", "tue", "wed", "thu", "fri"];
const LATE: PersonScheduleSlot["weekdays"] = ["wed", "thu", "fri", "sat", "sun"];
const SIX: PersonScheduleSlot["weekdays"] = ["mon", "tue", "wed", "thu", "fri", "sat"];

const PEOPLE: readonly PersonSpec[] = [
  { id: 1, code: "owner", name: "Владелец", kind: "human", role: "owner", state: "working", logins: [1, OWNER_CHAT_LOGIN.id], pages: [], slots: [],
    telegram: { userId: 700_000_001, handle: "owner_demo", tag: null }, note: "Второй вход — для расширения." },
  { id: 2, code: "marta", name: "Марта", kind: "human", role: "team_lead", state: "working", logins: [2], pages: [], slots: [],
    telegram: { userId: 700_000_002, handle: "marta_lead", tag: null } },
  { id: 3, code: "oleg", name: "Олег", kind: "human", role: "team_lead", state: "working", logins: [3], pages: [], slots: [],
    telegram: { userId: 700_000_003, handle: "oleg_lead", tag: null } },
  { id: 4, code: "alex", name: "Алекс", kind: "human", role: "chatter", state: "working", logins: [4], pages: ["mia-1", "mia-2"],
    slots: [{ start: "08:00", end: "16:00", weekdays: WEEK, fromDays: 60 }],
    telegram: { userId: 700_000_004, handle: "alex_k", tag: "#alex" },
    terms: [{ model: "mia-hart", share: 2000, fix: 0, fromDays: 140 }, { model: "mia-hart", share: 2500, fix: 5_000, fromDays: 30 }] },
  { id: 5, code: "kate", name: "Катя", kind: "human", role: "chatter", state: "working", logins: [5], pages: ["mia-1"],
    slots: [{ start: "16:00", end: "00:00", weekdays: LATE, fromDays: 40 }],
    telegram: { userId: 700_000_005, handle: "kate_v", tag: "#катя" }, rights: ["customs_lead"],
    notes: [{ code: "pages_differ", text: "рабочие страницы карточки: mia-1; доступ хаба (kate.v): mia-1, mia-3; только в доступе: mia-3" }],
    origin: "import", terms: [{ model: "mia-hart", share: 2500, fix: 0, fromDays: 110 }] },
  { id: 6, code: "den", name: "Денис", kind: "human", role: "chatter", state: "working", logins: [6], pages: ["nova-1"],
    slots: [{ start: "00:00", end: "08:00", weekdays: WEEK, fromDays: 90 }],
    telegram: { userId: 700_000_006, handle: "den_s", tag: "#den" }, terms: [{ model: "nova-lane", share: 2200, fix: 0, fromDays: 90 }] },
  { id: 7, code: "olya", name: "Оля", kind: "human", role: "chatter", state: "working", logins: [7], pages: ["mia-of", "mia-vip-of"],
    slots: [{ start: "12:00", end: "20:00", weekdays: SIX, fromDays: 70 }],
    telegram: { userId: 700_000_007, handle: "olya_m", tag: "#olya" }, terms: [{ model: "mia-hart", share: 2000, fix: 3_000, fromDays: 70 }] },
  { id: 8, code: "ivan", name: "Иван", kind: "human", role: "chatter", state: "working", logins: [8], pages: ["ivy-1", "ivy-2"],
    slots: [
      { start: "18:00", end: "02:00", weekdays: SIX, fromDays: 44 },
      { page: "ivy-2", start: "18:00", end: "00:00", weekdays: SIX, fromDays: 20 },
    ],
    telegram: { userId: 700_000_008, handle: "ivan_p", tag: "#ivan" }, terms: [{ model: "ivy-rose", share: 2500, fix: 0, fromDays: 44 }] },
  { id: 9, code: "lena", name: "Лена", kind: "human", role: "chatter", state: "left", logins: [9], pages: ["mia-2", "nova-1"],
    slots: [{ start: "16:00", end: "00:00", weekdays: WEEK, fromDays: 131, toDays: 12 }], leftDaysAgo: 12,
    telegram: { userId: 700_000_009, handle: "lena_r", tag: "#лена" }, terms: [{ model: "mia-hart", share: 2000, fix: 0, fromDays: 131 }] },
  { id: 10, code: "nika", name: "Ника", kind: "human", role: "chatter", state: "invited", logins: [10], pages: ["mia-3"], slots: [],
    onboarding: [{ step: "Приглашение отправлено", doneDays: 1 }, { step: "Пароль по ссылке", doneDays: null }, { step: "Первая смена", doneDays: null }] },
  { id: 11, code: "sonya", name: "Соня", kind: "human", role: "content_manager", state: "working", logins: [], pages: [], slots: [],
    telegram: { userId: 700_000_011, handle: "sonya_content", tag: null }, note: "Без входа хаба: работает в ContentOps и своим ключом агента." },
  { id: 12, code: "traffic-tim", name: "Тимур (трафик)", kind: "human", role: "contractor", state: "working", logins: [], pages: [], slots: [] },
  { id: 13, code: "helper-bot", name: "Помощник в чате", kind: "agent", role: "agent", state: "working", logins: [], pages: [], slots: [],
    keys: [{ id: 10, name: "Очереди фанов", state: "active" }, { id: 7, name: "Исследователь архива", state: "active" }] },
  { id: 14, code: "contentops", name: "Сервер ContentOps", kind: "agent", role: "agent", state: "working", logins: [], pages: [], slots: [],
    keys: [{ id: 9, name: "ContentOps", state: "active" }] },
  { id: 15, code: "capture-server", name: "Сервер захвата", kind: "service", role: "service", state: "working", logins: [], pages: [], slots: [],
    note: "Служебный: проверки «вход без человека» и «смена без отчёта» его не трогают." },
];

const MODEL_NAMES: Readonly<Record<string, string>> = { "mia-hart": "Mia Hart", "nova-lane": "Nova Lane", "ivy-rose": "Ivy Rose" };

function slotsOf(spec: PersonSpec, now: Date): PersonScheduleSlot[] {
  return spec.slots.map((slot, index) => {
    const page = slot.page ? demoPage(slot.page) : undefined;
    const minute = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    return {
      id: spec.id * 10 + index,
      personId: spec.id,
      pageId: page?.id ?? null,
      pageLabel: page?.label ?? null,
      startMinute: minute(slot.start),
      endMinute: minute(slot.end),
      start: slot.start,
      end: slot.end,
      weekdays: slot.weekdays,
      validFrom: slot.fromDays === null ? null : isoDay(daysAgo(now, slot.fromDays)),
      validTo: slot.toDays === undefined ? null : isoDay(daysAgo(now, slot.toDays)),
    };
  });
}

function personOf(spec: PersonSpec, now: Date): Person {
  const users = teamUsers();
  const slots = slotsOf(spec, now);
  const holding = (slot: PersonScheduleSlot) => slot.validTo === null;
  return {
    id: spec.id,
    code: spec.code,
    displayName: spec.name,
    kind: spec.kind,
    role: spec.role,
    state: spec.state,
    leftOn: spec.leftDaysAgo === undefined ? null : isoDay(daysAgo(now, spec.leftDaysAgo)),
    telegram: spec.telegram
      ? { userId: spec.telegram.userId, handle: spec.telegram.handle, reportTag: spec.telegram.tag }
      : { userId: null, handle: null, reportTag: null },
    logins: spec.logins.flatMap((id) => {
      const user = users.find((one) => one.id === id);
      if (!user) return [];
      const state = !user.active || spec.state === "left" ? "disabled" as const : spec.state === "invited" ? "invited" as const : "active" as const;
      return [{ userId: user.id, username: user.username, role: user.role, state }];
    }),
    agentKeys: (spec.keys ?? []).map((key) => ({ agentKeyId: key.id, name: key.name, state: key.state })),
    workingPages: spec.pages.flatMap((label) => {
      const page = DEMO_PAGES.find((one) => one.label === label);
      return page ? [{ pageLabel: page.label, platform: page.platform, modelSlug: page.modelSlug, modelName: page.modelName }] : [];
    }),
    schedule: slots.find((slot) => slot.pageId === null && holding(slot)) ?? null,
    pageSchedules: slots.filter((slot) => slot.pageId !== null && holding(slot)),
    rights: (spec.rights ?? []).map((right) => ({ right, grantedAt: iso(daysAgo(now, 25)) })),
    onboarding: (spec.onboarding ?? []).map((step) => ({ step: step.step, doneAt: step.doneDays === null ? null : iso(daysAgo(now, step.doneDays)), note: null })),
    note: spec.note ?? null,
    importNotes: spec.notes ?? [],
    origin: spec.origin ?? "owner",
    openProposals: proposalsOf(now).filter((one) => one.personCode === spec.code && one.state === "open").length,
    createdAt: iso(daysAgo(now, 30)),
    updatedAt: iso(hoursAgo(now, spec.id * 3)),
  };
}

function termsOf(spec: PersonSpec, now: Date): PersonPayTerm[] {
  const terms = spec.terms ?? [];
  return terms.map((term, index) => {
    const next = terms.slice(index + 1).find((other) => other.model === term.model);
    return {
      id: spec.id * 10 + index,
      modelSlug: term.model,
      modelName: MODEL_NAMES[term.model] ?? term.model,
      validFrom: isoDay(daysAgo(now, term.fromDays)),
      validTo: next ? isoDay(daysAgo(now, next.fromDays + 1)) : null,
      shareBasisPoints: term.share,
      fixPerShiftMills: term.fix,
      note: null,
      updatedAt: iso(daysAgo(now, term.fromDays)),
    };
  });
}

function proposalsOf(now: Date): PersonProposal[] {
  return [
    {
      id: 2, kind: "update", personCode: "den",
      change: { kind: "update", personCode: "den", change: { schedule: { from: isoDay(daysAgo(now, -2)), slot: { start: "02:00", end: "10:00", weekdays: WEEK } } } },
      reason: "Денис написал в чате команды, что с понедельника выходит на 02:00–10:00", requestedBy: "den.s", sourceRef: "чат команды",
      agentKeyName: "Очереди фанов", state: "open", createdAt: iso(hoursAgo(now, 5)), decidedAt: null, decisionNote: null,
    },
    {
      id: 1, kind: "update", personCode: "kate",
      change: { kind: "update", personCode: "kate", change: { telegram: { handle: "kate_v" } } },
      reason: "Катя сменила ник в Telegram", requestedBy: "kate.v", sourceRef: null,
      agentKeyName: "Очереди фанов", state: "accepted", createdAt: iso(daysAgo(now, 6)), decidedAt: iso(daysAgo(now, 6)), decisionNote: "да",
    },
  ];
}

function cardOf(spec: PersonSpec, now: Date): AdminPerson {
  return {
    person: personOf(spec, now),
    scheduleSlots: slotsOf(spec, now),
    payTerms: termsOf(spec, now),
    proposals: proposalsOf(now).filter((one) => one.personCode === spec.code),
    serverNow: iso(now),
  };
}

function specOf(request: DemoRequest): PersonSpec | undefined {
  return PEOPLE.find((spec) => spec.code === request.params.code);
}

export const peopleHandlers: DemoHandlers = {
  teamPeople: (request) => {
    if (request.role === "chatter") return demoError(403, "Forbidden", "Список людей — для владельца и тимлидов");
    return {
      people: PEOPLE.map((spec) => personOf(spec, request.now)),
      unlinkedLogins: [],
      serverNow: iso(request.now),
    };
  },

  adminPerson: (request) => {
    const refused = ownerOnly(request);
    if (refused) return refused;
    const spec = specOf(request);
    return spec ? cardOf(spec, request.now) : demoError(404, "Not Found", `No person «${request.params.code}»`);
  },

  adminPersonCreate: (request) => {
    const refused = ownerOnly(request);
    if (refused) return refused;
    const body = (request.body ?? {}) as { code?: string; displayName?: string; role?: Person["role"]; invite?: { username?: string } };
    if (PEOPLE.some((spec) => spec.code === body.code)) return demoError(409, "Conflict", "Another person has this code");
    const spec: PersonSpec = {
      id: 99, code: body.code ?? "new", name: body.displayName ?? "Новый человек", kind: "human", role: body.role ?? "chatter",
      state: "invited", logins: [], pages: [], slots: [],
    };
    const card = cardOf(spec, request.now);
    const username = body.invite?.username;
    return {
      ...card,
      invite: username
        ? { userId: 99, username, link: { id: 99, keyPrefix: "dmoNEW1234", token: "demo-invite-token-not-real", expiresAt: iso(daysAgo(request.now, -7)) } }
        : null,
    };
  },

  adminPersonUpdate: (request) => {
    const refused = ownerOnly(request);
    if (refused) return refused;
    const spec = specOf(request);
    if (!spec) return demoError(404, "Not Found", `No person «${request.params.code}»`);
    const body = (request.body ?? {}) as { displayName?: string; state?: Person["state"]; workingPageLabels?: string[] };
    const card = cardOf({
      ...spec,
      ...(body.displayName === undefined ? {} : { name: body.displayName }),
      ...(body.state === undefined ? {} : { state: body.state }),
      ...(body.workingPageLabels === undefined ? {} : { pages: body.workingPageLabels }),
    }, request.now);
    return card;
  },

  adminPersonPayTermSet: (request) => {
    const refused = ownerOnly(request);
    if (refused) return refused;
    const spec = specOf(request);
    if (!spec) return demoError(404, "Not Found", `No person «${request.params.code}»`);
    if (spec.kind !== "human") return demoError(400, "Bad Request", `Only a human has pay terms, not a ${spec.kind}`);
    const body = (request.body ?? {}) as { modelSlug?: string; shareBasisPoints?: number; fixPerShiftMills?: number };
    return cardOf({
      ...spec,
      terms: [...(spec.terms ?? []), { model: body.modelSlug ?? "mia-hart", share: body.shareBasisPoints ?? 0, fix: body.fixPerShiftMills ?? 0, fromDays: 0 }],
    }, request.now);
  },

  adminPeopleProposals: (request) => {
    const refused = ownerOnly(request);
    if (refused) return refused;
    const state = queryString(request, "state") ?? "open";
    return { proposals: proposalsOf(request.now).filter((one) => one.state === state) };
  },

  adminPersonProposalDecide: (request) => {
    const refused = ownerOnly(request);
    if (refused) return refused;
    const proposal = proposalsOf(request.now).find((one) => one.id === Number(request.params.proposalId));
    if (!proposal) return demoError(404, "Not Found", "No proposal");
    if (proposal.state !== "open") return demoError(409, "Conflict", `The proposal is ${proposal.state} already`);
    const decision = (request.body as { decision?: string } | null)?.decision === "reject" ? "rejected" as const : "accepted" as const;
    const spec = PEOPLE.find((one) => one.code === proposal.personCode);
    return {
      proposal: { ...proposal, state: decision, decidedAt: iso(request.now), decisionNote: null },
      person: spec ? personOf(spec, request.now) : null,
    };
  },
};
