import type {
  AdminPersonCreateBody,
  AdminPersonImportNoteSettleBody,
  AdminPersonPayTermBody,
  AdminPersonUpdateBody,
  KernelOperationResponse,
  PersonImportNote,
  PersonPayTerm,
  PersonProposal,
  PersonScheduleSlot,
} from "@agency_hub_core/contracts";

import { demoError, iso, isoDay, daysAgo, hoursAgo, queryString, type DemoHandlers, type DemoReply, type DemoRequest } from "../core.ts";
import { DEMO_MODELS, DEMO_PAGES, demoPage } from "../world.ts";
import { NEWCOMER, demoStartForCard, newcomerLogin, newcomerPages } from "./person-start.ts";
import { ownerOnly } from "./settings-common.ts";
import { OWNER_CHAT_LOGIN, demoLastActiveAt, teamUsers } from "./settings.ts";

/**
 * The people registry in the invented agency (contracts people.ts): one record
 * per person, the owner one person with two logins (the console's `owner` and
 * the extension's `owner.chat`), a content manager and a traffic contractor
 * with no login at all, a chatter who left, one invited, two agents with their
 * keys and a capture server held as a service. One chatter's working pages are
 * narrower than her access, as in life, and one has an earlier end on one page.
 * The owner's card carries the pay terms (money: the owner's only); the team's
 * list never does.
 *
 * The owner's writes (a new person with an invitation, an edit, a slot or pay
 * terms from a day, «Сверено», an agent's proposal decided) change this registry
 * in memory until the dev server restarts, like «Что продаёт»'s approaches
 * (wb-sales.ts): the screen can be walked through end to end. Nothing else of
 * the invented world follows (a new person has no shifts, devices or links).
 */

type TeamPeople = KernelOperationResponse<"teamPeople">;
type Person = TeamPeople["people"][number];
type AdminPerson = KernelOperationResponse<"adminPerson">;
type Weekdays = PersonScheduleSlot["weekdays"];

interface SlotSpec {
  page?: string;
  start: string;
  end: string;
  weekdays: Weekdays;
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
  rights?: Array<"customs_lead" | "records_customs" | "submits_shift" | "sees_own_pay">;
  leftDaysAgo?: number;
  note?: string;
  notes?: { code: string; text: string; settledDaysAgo?: number }[];
  origin?: Person["origin"];
  onboarding?: { step: string; doneDays: number | null }[];
  /** Pay terms: share in basis points, fix per shift in mills, from N days back. */
  terms?: { model: string; share: number; fix: number; fromDays: number }[];
}

const WEEK: Weekdays = ["mon", "tue", "wed", "thu", "fri"];
const LATE: Weekdays = ["wed", "thu", "fri", "sat", "sun"];
const SIX: Weekdays = ["mon", "tue", "wed", "thu", "fri", "sat"];

const PEOPLE: readonly PersonSpec[] = [
  { id: 1, code: "owner", name: "Владелец", kind: "human", role: "owner", state: "working", logins: [1, OWNER_CHAT_LOGIN.id], pages: [], slots: [],
    telegram: { userId: 700_000_001, handle: "owner_demo", tag: null }, note: "Второй вход: для расширения." },
  { id: 2, code: "marta", name: "Марта", kind: "human", role: "team_lead", state: "working", logins: [2], pages: [], slots: [],
    telegram: { userId: 700_000_002, handle: "marta_lead", tag: null } },
  { id: 3, code: "oleg", name: "Олег", kind: "human", role: "team_lead", state: "working", logins: [3], pages: [], slots: [],
    telegram: { userId: 700_000_003, handle: "oleg_lead", tag: null } },
  { id: 4, code: "alex", name: "Алекс", kind: "human", role: "chatter", state: "working", logins: [4], pages: ["mia-1", "mia-2"],
    slots: [{ start: "08:00", end: "16:00", weekdays: WEEK, fromDays: 60 }],
    telegram: { userId: 700_000_004, handle: "alex_k", tag: "#alex" }, rights: ["sees_own_pay"],
    terms: [{ model: "mia-hart", share: 2000, fix: 0, fromDays: 140 }, { model: "mia-hart", share: 2500, fix: 5_000, fromDays: 30 }] },
  { id: 5, code: "kate", name: "Катя", kind: "human", role: "chatter", state: "working", logins: [5], pages: ["mia-1"],
    slots: [{ start: "16:00", end: "00:00", weekdays: LATE, fromDays: 40 }],
    telegram: { userId: 700_000_005, handle: "kate_v", tag: "#катя" }, rights: ["customs_lead"],
    notes: [
      { code: "pages_differ", text: "рабочие страницы карточки: mia-1; доступ хаба (kate.v): mia-1, mia-3; только в доступе: mia-3" },
      { code: "telegram_missing", text: "в карточке нет Telegram, в ledger есть: взят из ledger" },
      { code: "tab_fix_unknown", text: "вкладка «Mia выплаты»: «Фикс/см» ledger не знает: взят 0, проверьте", settledDaysAgo: 1 },
    ],
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
  // The newcomer: her way to the first shift is read live («Ввод», person-start.ts), nothing noted by hand.
  { id: 10, code: "nika", name: "Ника", kind: "human", role: "chatter", state: "invited", logins: [10], pages: ["mia-3"], slots: [],
    telegram: { userId: 700_000_010, handle: "nika_new", tag: null } },
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

const MODEL_NAMES: Readonly<Record<string, string>> = Object.fromEntries(DEMO_MODELS.map((model) => [model.slug, model.name]));

// ── the registry in memory ───────────────────────────────────────────────────

interface SlotRec {
  id: number;
  page: string | null;
  start: string;
  end: string;
  weekdays: Weekdays;
  validFrom: string | null;
  validTo: string | null;
}

interface TermRec {
  id: number;
  model: string;
  share: number;
  fix: number;
  validFrom: string;
  note: string | null;
  updatedAt: string;
}

interface Rec {
  id: number;
  code: string;
  name: string;
  kind: Person["kind"];
  role: Person["role"];
  state: Person["state"];
  leftOn: string | null;
  logins: number[];
  keys: { id: number; name: string; state: "active" | "expired" | "revoked" }[];
  pages: string[];
  slots: SlotRec[];
  telegram: Person["telegram"];
  rights: { right: "customs_lead" | "records_customs" | "submits_shift" | "sees_own_pay"; grantedAt: string }[];
  note: string | null;
  notes: PersonImportNote[];
  origin: Person["origin"];
  onboarding: Person["onboarding"];
  terms: TermRec[];
  createdAt: string;
  updatedAt: string;
}

/** A login the demo's invitation made: it has no password yet, no device, no shift. */
interface NewLogin {
  id: number;
  username: string;
  role: "chatter" | "team_lead";
}

interface Registry {
  people: Rec[];
  proposals: PersonProposal[];
  logins: NewLogin[];
  nextId: number;
}

let registry: Registry | null = null;

function recOf(spec: PersonSpec, now: Date): Rec {
  return {
    id: spec.id,
    code: spec.code,
    name: spec.name,
    kind: spec.kind,
    role: spec.role,
    state: spec.state,
    leftOn: spec.leftDaysAgo === undefined ? null : isoDay(daysAgo(now, spec.leftDaysAgo)),
    logins: [...spec.logins],
    keys: [...(spec.keys ?? [])],
    pages: [...spec.pages],
    slots: spec.slots.map((slot, index) => ({
      id: spec.id * 10 + index,
      page: slot.page ?? null,
      start: slot.start,
      end: slot.end,
      weekdays: slot.weekdays,
      validFrom: slot.fromDays === null ? null : isoDay(daysAgo(now, slot.fromDays)),
      validTo: slot.toDays === undefined ? null : isoDay(daysAgo(now, slot.toDays)),
    })),
    telegram: spec.telegram
      ? { userId: spec.telegram.userId, handle: spec.telegram.handle, reportTag: spec.telegram.tag }
      : { userId: null, handle: null, reportTag: null },
    rights: (spec.rights ?? []).map((right) => ({ right, grantedAt: iso(daysAgo(now, 25)) })),
    note: spec.note ?? null,
    notes: (spec.notes ?? []).map((note) => ({
      code: note.code, text: note.text, settledAt: note.settledDaysAgo === undefined ? null : iso(daysAgo(now, note.settledDaysAgo)),
    })),
    origin: spec.origin ?? "owner",
    onboarding: (spec.onboarding ?? []).map((step) => ({ step: step.step, doneAt: step.doneDays === null ? null : iso(daysAgo(now, step.doneDays)), note: null })),
    terms: (spec.terms ?? []).map((term, index) => ({
      id: spec.id * 10 + index, model: term.model, share: term.share, fix: term.fix,
      validFrom: isoDay(daysAgo(now, term.fromDays)), note: null, updatedAt: iso(daysAgo(now, term.fromDays)),
    })),
    createdAt: iso(daysAgo(now, 30)),
    updatedAt: iso(hoursAgo(now, spec.id * 3)),
  };
}

function seedProposals(now: Date): PersonProposal[] {
  return [
    {
      id: 3, kind: "create", personCode: "vika",
      change: { kind: "create", person: { code: "vika", displayName: "Вика", role: "content_manager", state: "set_up", telegram: { handle: "vika_content" } } },
      reason: "Вика начала разбирать кастомы Mia, просила завести её в Hub", requestedBy: "sonya", sourceRef: "чат контента",
      agentKeyName: "Очереди фанов", state: "open", createdAt: iso(hoursAgo(now, 26)), decidedAt: null, decisionNote: null,
    },
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

function world(now: Date): Registry {
  registry ??= { people: PEOPLE.map((spec) => recOf(spec, now)), proposals: seedProposals(now), logins: [], nextId: 100 };
  return registry;
}

// ── views ────────────────────────────────────────────────────────────────────

function minute(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

function slotView(rec: Rec, slot: SlotRec): PersonScheduleSlot {
  const page = slot.page ? demoPage(slot.page) : undefined;
  return {
    id: slot.id,
    personId: rec.id,
    pageId: page?.id ?? null,
    pageLabel: page?.label ?? null,
    startMinute: minute(slot.start),
    endMinute: minute(slot.end),
    start: slot.start,
    end: slot.end,
    weekdays: slot.weekdays,
    validFrom: slot.validFrom,
    validTo: slot.validTo,
  };
}

/** The slot of a line holding today, else the next one to begin (the service's `currentSlot`). */
function currentOf(slots: readonly PersonScheduleSlot[], today: string): PersonScheduleSlot | null {
  let holding: PersonScheduleSlot | null = null;
  for (const slot of slots) {
    if ((slot.validFrom === null || slot.validFrom <= today) && (slot.validTo === null || slot.validTo >= today)) holding = slot;
  }
  return holding ?? slots.find((slot) => slot.validFrom !== null && slot.validFrom > today) ?? null;
}

function loginsOf(rec: Rec, reg: Registry, now: Date, scenario: string | undefined): Person["logins"] {
  const users = teamUsers();
  return rec.logins.flatMap((id) => {
    const made = reg.logins.find((one) => one.id === id);
    if (made) return [{ userId: made.id, username: made.username, role: made.role, state: "invited" as const, lastSeenAt: null }];
    const user = users.find((one) => one.id === id);
    if (!user) return [];
    // Ника at a later stage of «Начало» (person-start.ts): her login has its password and was seen.
    const newcomer = id === NEWCOMER.userId ? newcomerLogin(scenario, now) : null;
    if (newcomer) return [{ userId: user.id, username: user.username, role: user.role, ...newcomer }];
    const lastSeenAt = demoLastActiveAt(user, now);
    const state = !user.active || rec.state === "left" ? "disabled" as const : lastSeenAt === null ? "invited" as const : "active" as const;
    return [{ userId: user.id, username: user.username, role: user.role, state, lastSeenAt }];
  });
}

function personOf(rec: Rec, reg: Registry, now: Date, scenario?: string): Person {
  const today = isoDay(now);
  const slots = rec.slots.map((slot) => slotView(rec, slot));
  const general = currentOf(slots.filter((slot) => slot.pageId === null), today);
  const pageIds = [...new Set(slots.flatMap((slot) => (slot.pageId === null ? [] : [slot.pageId])))];
  return {
    id: rec.id,
    code: rec.code,
    displayName: rec.name,
    kind: rec.kind,
    role: rec.role,
    state: rec.state,
    leftOn: rec.leftOn,
    telegram: rec.telegram,
    logins: loginsOf(rec, reg, now, scenario),
    agentKeys: rec.keys.map((key) => ({ agentKeyId: key.id, name: key.name, state: key.state })),
    workingPages: rec.pages.flatMap((label) => {
      const page = DEMO_PAGES.find((one) => one.label === label);
      return page ? [{ pageLabel: page.label, platform: page.platform, modelSlug: page.modelSlug, modelName: page.modelName }] : [];
    }),
    schedule: general,
    pageSchedules: pageIds.flatMap((pageId) => {
      const slot = currentOf(slots.filter((one) => one.pageId === pageId), today);
      return slot ? [slot] : [];
    }),
    rights: rec.rights,
    onboarding: rec.onboarding,
    note: rec.note,
    importNotes: rec.notes,
    origin: rec.origin,
    openProposals: reg.proposals.filter((one) => one.personCode === rec.code && one.state === "open").length,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

function termsOf(rec: Rec): PersonPayTerm[] {
  const terms = [...rec.terms].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  return terms.map((term, index) => {
    const next = terms.slice(index + 1).find((other) => other.model === term.model);
    return {
      id: term.id,
      modelSlug: term.model,
      modelName: MODEL_NAMES[term.model] ?? term.model,
      validFrom: term.validFrom,
      validTo: next ? dayBefore(next.validFrom) : null,
      shareBasisPoints: term.share,
      fixPerShiftMills: term.fix,
      note: term.note,
      updatedAt: term.updatedAt,
    };
  });
}

function cardOf(rec: Rec, reg: Registry, request: DemoRequest): AdminPerson {
  const now = request.now;
  // «Ввод» and where to pay (person-start.ts): Ника's by the scenario's stage, the rest work already.
  const pages = rec.code === NEWCOMER.code ? newcomerPages(request.scenario) : rec.pages;
  const start = demoStartForCard({ code: rec.code, kind: rec.kind, state: rec.state, pages, hasLogin: rec.logins.length > 0 }, request);
  return {
    person: personOf(rec, reg, now, request.scenario),
    scheduleSlots: rec.slots.map((slot) => slotView(rec, slot)),
    payTerms: termsOf(rec),
    proposals: reg.proposals.filter((one) => one.personCode === rec.code),
    start: start.start,
    payoutDetails: start.payoutDetails,
    serverNow: iso(now),
  };
}

// ── the writes, with the service's own checks ────────────────────────────────

function dayBefore(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, date! - 1)).toISOString().slice(0, 10);
}

/** A change of the person, as the service's edit (people/index.ts `resolveChange` + `applyChange`); an error is the service's refusal. */
function applyUpdate(rec: Rec, body: AdminPersonUpdateBody, now: Date): DemoReply | null {
  if (body.workingPageLabels) {
    const missing = body.workingPageLabels.filter((label) => !DEMO_PAGES.some((page) => page.label === label));
    if (missing.length > 0) return demoError(404, "Not Found", `No active page ${missing.map((label) => `«${label}»`).join(", ")}`);
  }
  if (body.schedule) {
    const { from, slot } = body.schedule;
    const page = body.schedule.pageLabel ?? null;
    if (slot) {
      const length = (minute(slot.end) - minute(slot.start) + 1440) % 1440;
      if (length < 60 || length > 16 * 60) return demoError(400, "Bad Request", `A shift lasts 1 to 16 hours: ${slot.start}-${slot.end} does not`);
    }
    const line = rec.slots.filter((one) => one.page === page);
    const latest = line.at(-1);
    if (from === null && latest) return demoError(400, "Bad Request", "The person has a schedule: give the day the change begins");
    if (from !== null && latest?.validFrom != null && latest.validFrom > from) {
      return demoError(400, "Bad Request", `The schedule has a slot from ${latest.validFrom}: a change begins after it`);
    }
    if (from !== null && latest?.validFrom === from && slot === null) {
      return demoError(400, "Bad Request", `A slot begins on ${from}: give the slot itself, or another day`);
    }
    if (latest && from !== null && latest.validFrom === from && slot) {
      Object.assign(latest, { start: slot.start, end: slot.end, weekdays: slot.weekdays ?? null });
    } else {
      if (latest && from !== null && (latest.validTo === null || latest.validTo >= from)) latest.validTo = dayBefore(from);
      if (slot) {
        rec.slots.push({ id: rec.id * 10 + rec.slots.length + 100, page, start: slot.start, end: slot.end, weekdays: slot.weekdays ?? null, validFrom: from, validTo: null });
      }
    }
  }
  if (body.displayName !== undefined) rec.name = body.displayName.trim();
  if (body.role !== undefined) rec.role = body.role;
  if (body.state !== undefined) rec.state = body.state;
  if (body.leftOn !== undefined) rec.leftOn = body.leftOn;
  else if (rec.state !== "left") rec.leftOn = null;
  if (body.telegram) {
    const { userId, handle, reportTag } = body.telegram;
    rec.telegram = {
      userId: userId === undefined ? rec.telegram.userId : userId,
      handle: handle === undefined ? rec.telegram.handle : handle === null ? null : handle.replace(/^@/, ""),
      reportTag: reportTag === undefined ? rec.telegram.reportTag : reportTag,
    };
  }
  if (body.workingPageLabels) rec.pages = [...body.workingPageLabels];
  if (body.rights) rec.rights = [...new Set(body.rights)].map((right) => rec.rights.find((one) => one.right === right) ?? { right, grantedAt: iso(now) });
  if (body.note !== undefined) rec.note = body.note === null || body.note.trim() === "" ? null : body.note.trim();
  rec.updatedAt = iso(now);
  return null;
}

function setTerm(rec: Rec, body: AdminPersonPayTermBody, now: Date): DemoReply | null {
  if (rec.kind !== "human") return demoError(400, "Bad Request", `Only a human has pay terms, not a ${rec.kind}`);
  const model = DEMO_MODELS.find((one) => one.slug === body.modelSlug);
  if (!model) return demoError(404, "Not Found", `No model «${body.modelSlug}»`);
  const same = rec.terms.find((term) => term.model === model.slug && term.validFrom === body.validFrom);
  const values = { share: body.shareBasisPoints, fix: body.fixPerShiftMills, note: body.note?.trim() || null, updatedAt: iso(now) };
  if (same) Object.assign(same, values);
  else rec.terms.push({ id: rec.id * 10 + rec.terms.length + 100, model: model.slug, validFrom: body.validFrom, ...values });
  rec.updatedAt = iso(now);
  return null;
}

function specOf(request: DemoRequest): Rec | undefined {
  const people = world(request.now).people;
  const code = request.params.code;
  // On Hub the ledger's code of a person is the registry's; the demo's ledger names chatters by login (team-ledger.ts),
  // so «Выплаты» asking a person's card by it gets the login's person here.
  const login = teamUsers().find((user) => user.username === code);
  return people.find((rec) => rec.code === code) ?? (login ? people.find((rec) => rec.logins.includes(login.id)) : undefined);
}

export const peopleHandlers: DemoHandlers = {
  teamPeople: (request) => {
    if (request.role === "chatter") return demoError(403, "Forbidden", "Список людей — для владельца и тимлидов");
    const reg = world(request.now);
    return {
      people: [...reg.people].sort((a, b) => a.name.localeCompare(b.name, "ru")).map((rec) => personOf(rec, reg, request.now, request.scenario)),
      unlinkedLogins: [],
      serverNow: iso(request.now),
    };
  },

  adminPerson: (request) => {
    const refused = ownerOnly(request);
    if (refused) return refused;
    const rec = specOf(request);
    return rec ? cardOf(rec, world(request.now), request) : demoError(404, "Not Found", `No person «${request.params.code}»`);
  },

  adminPersonCreate: (request) => {
    const refused = ownerOnly(request);
    if (refused) return refused;
    const reg = world(request.now);
    const body = (request.body ?? {}) as AdminPersonCreateBody;
    if (reg.people.some((rec) => rec.code === body.code)) return demoError(409, "Conflict", "Another person has this code");
    const username = body.invite?.username;
    if (username && [...teamUsers(), ...reg.logins].some((user) => user.username.toLowerCase() === username.toLowerCase())) {
      return demoError(409, "Conflict", "Username already exists");
    }
    const id = reg.nextId;
    const rec: Rec = {
      id, code: body.code, name: body.displayName.trim(), kind: body.kind ?? "human", role: body.role, state: body.state ?? "invited",
      leftOn: null, logins: [], keys: [], pages: [], slots: [], telegram: { userId: null, handle: null, reportTag: null }, rights: [],
      note: null, notes: [], origin: "owner", onboarding: [], terms: [], createdAt: iso(request.now), updatedAt: iso(request.now),
    };
    const failed = applyUpdate(rec, {
      ...(body.telegram ? { telegram: body.telegram } : {}),
      ...(body.workingPageLabels ? { workingPageLabels: body.workingPageLabels } : {}),
      ...(body.schedule ? { schedule: body.schedule } : {}),
      ...(body.rights ? { rights: body.rights } : {}),
      ...(body.note !== undefined ? { note: body.note } : {}),
    }, request.now);
    if (failed) return failed;
    for (const term of body.payTerms ?? []) {
      const refusedTerm = setTerm(rec, term, request.now);
      if (refusedTerm) return refusedTerm;
    }
    let invite: KernelOperationResponse<"adminPersonCreate">["invite"] = null;
    if (username) {
      const login: NewLogin = { id: id + 1000, username, role: body.invite?.role ?? "chatter" };
      reg.logins.push(login);
      rec.logins.push(login.id);
      const hours = body.invite?.expiresInHours ?? 168;
      invite = { userId: login.id, username, link: { id: id + 2000, keyPrefix: "dmoNEW1234", token: "demo-invite-token-not-real", expiresAt: iso(hoursAgo(request.now, -hours)) } };
    }
    reg.nextId += 1;
    reg.people.push(rec);
    return { ...cardOf(rec, reg, request), invite };
  },

  adminPersonUpdate: (request) => {
    const refused = ownerOnly(request);
    if (refused) return refused;
    const rec = specOf(request);
    if (!rec) return demoError(404, "Not Found", `No person «${request.params.code}»`);
    const failed = applyUpdate(rec, (request.body ?? {}) as AdminPersonUpdateBody, request.now);
    return failed ?? cardOf(rec, world(request.now), request);
  },

  adminPersonPayTermSet: (request) => {
    const refused = ownerOnly(request);
    if (refused) return refused;
    const rec = specOf(request);
    if (!rec) return demoError(404, "Not Found", `No person «${request.params.code}»`);
    const failed = setTerm(rec, (request.body ?? {}) as AdminPersonPayTermBody, request.now);
    return failed ?? cardOf(rec, world(request.now), request);
  },

  adminPersonImportNoteSettle: (request) => {
    const refused = ownerOnly(request);
    if (refused) return refused;
    const rec = specOf(request);
    if (!rec) return demoError(404, "Not Found", `No person «${request.params.code}»`);
    const body = (request.body ?? {}) as AdminPersonImportNoteSettleBody;
    const note = rec.notes[body.index];
    if (!note || note.code !== body.code) return demoError(409, "Conflict", "The person's import notes are not as read: read them again");
    rec.notes[body.index] = { ...note, settledAt: body.settled ? iso(request.now) : null };
    rec.updatedAt = iso(request.now);
    return cardOf(rec, world(request.now), request);
  },

  adminPeopleProposals: (request) => {
    const refused = ownerOnly(request);
    if (refused) return refused;
    const state = queryString(request, "state") ?? "open";
    return { proposals: world(request.now).proposals.filter((one) => one.state === state) };
  },

  adminPersonProposalDecide: (request) => {
    const refused = ownerOnly(request);
    if (refused) return refused;
    const reg = world(request.now);
    const index = reg.proposals.findIndex((one) => one.id === Number(request.params.proposalId));
    const proposal = reg.proposals[index];
    if (!proposal) return demoError(404, "Not Found", "No proposal");
    if (proposal.state !== "open") return demoError(409, "Conflict", `The proposal is ${proposal.state} already`);
    const body = (request.body ?? {}) as { decision?: string; note?: string };
    const accept = body.decision !== "reject";
    let rec = reg.people.find((one) => one.code === proposal.personCode);
    if (accept) {
      const change = proposal.change as { kind: string; change?: AdminPersonUpdateBody; person?: AdminPersonCreateBody };
      if (change.kind === "update" && rec && change.change) {
        const failed = applyUpdate(rec, change.change, request.now);
        if (failed) return demoError(409, "Conflict", "The change no longer applies");
      } else if (change.kind === "create" && change.person) {
        const person = change.person;
        rec = {
          id: reg.nextId, code: person.code, name: person.displayName, kind: person.kind ?? "human", role: person.role, state: person.state ?? "invited",
          leftOn: null, logins: [], keys: [], pages: [], slots: [], telegram: { userId: null, handle: null, reportTag: null }, rights: [],
          note: null, notes: [], origin: "proposal", onboarding: [], terms: [], createdAt: iso(request.now), updatedAt: iso(request.now),
        };
        applyUpdate(rec, { ...(person.telegram ? { telegram: person.telegram } : {}), ...(person.workingPageLabels ? { workingPageLabels: person.workingPageLabels } : {}) }, request.now);
        reg.nextId += 1;
        reg.people.push(rec);
      }
    }
    const decided: PersonProposal = { ...proposal, state: accept ? "accepted" : "rejected", decidedAt: iso(request.now), decisionNote: body.note?.trim() || null };
    reg.proposals[index] = decided;
    return { proposal: decided, person: rec && (accept || proposal.kind === "update") ? personOf(rec, reg, request.now) : null };
  },
};
