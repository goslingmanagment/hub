// The one-off import of the people registry (ecosystem plan 2026-11-12,
// package A): draft people from the sources the agency keeps today — the /OS
// people cards, Hub's logins, ledger's people and settings, the payout sheets'
// tab headers as ledger read them — and every disagreement between them,
// shown, never settled silently.
//
// The sources come in as an argument file prepared on the owner's Mac (the
// repository is public: no name, login, Telegram id or rate lives in code);
// Hub's own logins, pages, models and agent keys are read from the database
// the command runs against. Nothing here touches a login (`users` is only
// read: scripts match chatters by `users.username`), and a code already in the
// registry is left as it is. A link the sources do not prove (a login that
// only looks like a card) is never made: it is listed for the owner, who
// confirms it in the argument file's `links`.
//
// A note stored on a person (`import_notes`) carries no money: the team's list
// shows it. The rates themselves go only into the owner's report (`detail`).

import { z } from "zod";

import {
  PERSON_CODE_PATTERN,
  PERSON_ROLES,
  PERSON_SLOT_MAX_MINUTES,
  PERSON_SLOT_MIN_MINUTES,
  PERSON_WEEKDAYS,
  type AdminPersonCreateBody,
  type AdminPersonPayTermBody,
  type PersonRole,
  type PersonScheduleInput,
  type PersonState,
} from "@agency_hub_core/contracts";
import {
  findPersonRowByCode,
  listPeopleCatalogAgentKeys,
  listPeopleCatalogModels,
  listPeopleCatalogPages,
  listPeopleCatalogUsers,
  listPersonLoginRows,
  listPersonRows,
  type PeopleCatalogAgentKey,
  type PeopleCatalogModel,
  type PeopleCatalogPage,
  type PeopleCatalogUser,
  type PersonImportNoteRow,
} from "@agency_hub_core/db";

import { toBusinessDate } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { withAuditTransaction, type AuditContext } from "../auth.ts";
import {
  createPersonInTransaction,
  setPayTermInTransaction,
  slotLength,
  slotMinute,
  updatePersonInTransaction,
} from "./index.ts";

// ── the argument file ────────────────────────────────────────────────────────

const code = z.string().regex(PERSON_CODE_PATTERN);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = z.string().max(500);

export const peopleImportArgsSchema = z.object({
  version: z.literal(1),
  /** The /OS cards' headers, one per `people/<code>.md`, values as written (lists as lists). */
  cards: z.array(z.object({
    code,
    title: text,
    type: text.nullable().optional(),
    /** employee | contractor. */
    role: text.nullable().optional(),
    position: text.nullable().optional(),
    status: text,
    aliases: z.array(text).default([]),
    started: text.nullable().optional(),
    ended: text.nullable().optional(),
    pages: z.array(text).nullable().optional(),
    schedule: text.nullable().optional(),
    scheduleStarted: text.nullable().optional(),
    workdays: z.array(text).nullable().optional(),
    telegram: text.nullable().optional(),
    models: z.array(text).nullable().optional(),
    /** The free text of `rate`; read only for a leading percent, compared with the tabs. */
    rate: text.nullable().optional(),
  })).max(500),
  ledger: z.object({
    people: z.array(z.object({
      slug: code,
      name: text,
      aliases: z.array(text).default([]),
      status: text,
      position: text.nullable().optional(),
      models: z.array(text).default([]),
      schedule: text.nullable().optional(),
    })).max(500).default([]),
    /** `settings.report_authors`: `tg:<id>` or `#tag` → code. */
    reportAuthors: z.array(z.object({ key: text, code: text })).max(500).default([]),
    /** `payroll_tabs` (+ the tab's fix as ledger last read it): one per model and tab name. */
    payrollTabs: z.array(z.object({
      model: text,
      name: text,
      code: text.nullable(),
      shareBasisPoints: z.number().int().min(0).max(10_000).nullable(),
      fixPerShiftMills: z.number().int().min(0).nullable(),
      status: text.nullable().optional(),
    })).max(500).default([]),
  }).default({ people: [], reportAuthors: [], payrollTabs: [] }),
  /** The owner: no card; the logins are theirs. */
  owner: z.object({
    code,
    displayName: text,
    usernames: z.array(text).max(20),
    telegramUserId: z.number().int().positive().nullable().optional(),
    telegramHandle: text.nullable().optional(),
  }).optional(),
  /** Agent people and the agent keys that are theirs (by key name). */
  agents: z.array(z.object({ code, displayName: text, agentKeyNames: z.array(text).max(20), note: text.optional() })).max(100).default([]),
  /** Service people (kind service): server-side and test logins, by username. Confirmed by the owner from the
   *  import's own proposals. */
  services: z.array(z.object({ code, displayName: text, usernames: z.array(text).max(200), note: text.optional() })).max(50).default([]),
  /** Logins the owner confirmed as a person's, beyond the cards' `hub:<id>`. */
  links: z.array(z.object({ code, username: text })).max(200).default([]),
  /** The role of a person when the card's position does not say it clearly. */
  roles: z.record(z.string(), z.enum(PERSON_ROLES)).default({}),
  /** A page's own schedule line beside the card's (e.g. an earlier end on one page). */
  pageSlots: z.array(z.object({
    code,
    pageLabel: text,
    start: text,
    end: text,
    weekdays: z.array(text).nullable().optional(),
    validFrom: day.nullable().optional(),
  })).max(200).default([]),
  /** Logins other systems write for a person (an agent's table, …): checked against Hub's. */
  otherLogins: z.array(z.object({ source: text, code: text, username: text })).max(200).default([]),
  /** A model name of ledger or the sheets → Hub's model slug (`lily` → `Lilly`). */
  modelAliases: z.record(z.string(), z.string()).default({}),
  /** The first day the imported pay terms hold; without it no terms are imported. */
  termsValidFrom: day.optional(),
});

export type PeopleImportArgs = z.infer<typeof peopleImportArgsSchema>;

// ── the plan ─────────────────────────────────────────────────────────────────

export interface ImportDiscrepancy {
  /** A closed code of the kind (`pages_differ`, `login_without_person`, …). */
  code: string;
  /** The person it is about; null — no person (a login, a tab, a key). */
  person: string | null;
  /** In words, for the owner; never money (it is stored on the person, which the team sees). */
  text: string;
  /** Owner-only detail (may carry rates): the report only, never stored. */
  detail?: string;
}

export interface ImportDraft {
  code: string;
  body: AdminPersonCreateBody;
  /** A page's own schedule lines, applied after the person is created. */
  pageSlots: PersonScheduleInput[];
  /** Money: from the payout tabs' headers. */
  payTerms: AdminPersonPayTermBody[];
  /** Where the draft came from. */
  sources: string[];
}

export interface ServiceProposal {
  userId: number;
  username: string;
  why: string;
}

export interface ImportPlan {
  drafts: ImportDraft[];
  discrepancies: ImportDiscrepancy[];
  /** Logins the import proposes to hold as kind service; the owner confirms them in `services`. */
  serviceProposals: ServiceProposal[];
  /** Codes already in the registry: left as they are. */
  skipped: string[];
}

export interface ImportCatalog {
  users: PeopleCatalogUser[];
  pages: PeopleCatalogPage[];
  models: PeopleCatalogModel[];
  agentKeys: PeopleCatalogAgentKey[];
  /** Codes in the registry already. */
  existingCodes: Set<string>;
  /** Logins linked in the registry already → the person's code. */
  linkedLogins: Map<number, string>;
}

export async function loadImportCatalog(db: AppContext["db"]): Promise<ImportCatalog> {
  const users = await listPeopleCatalogUsers(db);
  const pages = await listPeopleCatalogPages(db);
  const models = await listPeopleCatalogModels(db);
  const agentKeys = await listPeopleCatalogAgentKeys(db);
  const people = await listPersonRows(db);
  const codes = new Map(people.map((person) => [person.id, person.code]));
  const links = await listPersonLoginRows(db);
  return {
    users, pages, models, agentKeys,
    existingCodes: new Set(people.map((person) => person.code)),
    linkedLogins: new Map(links.map((link) => [link.userId, codes.get(link.personId) ?? "?"])),
  };
}

const SLOT = /^"?(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})"?$/;
const SERVICE_NAME = /(^codex-|^mirror-|^kernel-|^of_mirror|probe|canary|smoke|test|-server$|^bot[-_]|[-_]bot$)/i;

/** A card's `HH:MM-HH:MM` → the slot's edges, or null when it is not one. */
export function parseCardSlot(value: string): { start: string; end: string } | null {
  const match = SLOT.exec(value.trim());
  if (!match) return null;
  const [h1, m1, h2, m2] = match.slice(1).map(Number) as [number, number, number, number];
  if (h1 > 23 || m1 > 59 || h2 > 24 || m2 > 59 || (h2 === 24 && m2 !== 0)) return null;
  const start = `${String(h1).padStart(2, "0")}:${String(m1).padStart(2, "0")}`;
  const end = `${String(h2).padStart(2, "0")}:${String(m2).padStart(2, "0")}`;
  const length = slotLength(slotMinute(start), slotMinute(end));
  return length < PERSON_SLOT_MIN_MINUTES || length > PERSON_SLOT_MAX_MINUTES ? null : { start, end };
}

/** A card's status → the registry's state; `exact` false — the word means it only roughly. */
export function stateOfCardStatus(status: string): { state: PersonState; exact: boolean } | null {
  switch (status.trim()) {
    case "active": case "in_progress": return { state: "working", exact: true };
    case "testing": return { state: "working", exact: false };
    case "launching": return { state: "set_up", exact: true };
    case "paused": return { state: "set_up", exact: false };
    case "departed": case "cancelled": case "done": return { state: "left", exact: true };
    default: return null;
  }
}

function guessRole(card: PeopleImportArgs["cards"][number]): { role: PersonRole; sure: boolean } {
  const position = (card.position ?? "").toLowerCase();
  if ((card.role ?? "").trim() === "contractor") return { role: "contractor", sure: true };
  if (/тимлид|team ?lead/.test(position)) return { role: "team_lead", sure: true };
  if (/(^|[^а-яa-z])км([^а-яa-z]|$)|контент/.test(position)) return { role: "content_manager", sure: true };
  if (/чаттер|chatter/.test(position)) return { role: "chatter", sure: true };
  return { role: "contractor", sure: false };
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "—" : values.join(", ");
}

function percentOfRate(rate: string | null | undefined): number | null {
  const match = /(\d+(?:[.,]\d+)?)\s*%/.exec(rate ?? "");
  if (!match) return null;
  const [whole, fraction = ""] = match[1]!.replace(",", ".").split(".");
  return Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
}

/**
 * The import's plan: a draft per person and every disagreement between the
 * sources. Pure: the database is read before (`loadImportCatalog`), nothing is
 * written here.
 */
export function planPeopleImport(args: PeopleImportArgs, catalog: ImportCatalog): ImportPlan {
  const discrepancies: ImportDiscrepancy[] = [];
  const say = (code_: string, person: string | null, words: string, detail?: string) => {
    discrepancies.push({ code: code_, person, text: words, ...(detail === undefined ? {} : { detail }) });
  };
  const usersById = new Map(catalog.users.map((user) => [user.id, user]));
  const usersByName = new Map(catalog.users.map((user) => [user.username.toLowerCase(), user]));
  const pagesByLabel = new Map(catalog.pages.map((page) => [page.label, page]));
  const modelSlugOf = (name: string): string | null => {
    const lower = name.trim().toLowerCase();
    const alias = Object.entries(args.modelAliases).find(([key]) => key.toLowerCase() === lower)?.[1];
    const target = (alias ?? name).trim().toLowerCase();
    return catalog.models.find((model) => model.slug.toLowerCase() === target || model.name.toLowerCase() === target)?.slug ?? null;
  };
  const isActive = (user: PeopleCatalogUser) => user.disabledAt === null && user.deletedAt === null;
  const loginWords = (user: PeopleCatalogUser) => {
    const state = user.deletedAt ? "удалён" : user.disabledAt ? `отключён ${toBusinessDate(user.disabledAt)}`
      : user.hasPassword ? "активен" : "ждёт регистрации";
    return `${user.username} (#${user.id}, ${state})`;
  };

  const cards = new Map(args.cards.map((card) => [card.code, card]));
  const ledgerPeople = new Map(args.ledger.people.map((person) => [person.slug, person]));
  const allCodes = new Set<string>([...cards.keys(), ...ledgerPeople.keys()]);
  for (const special of [args.owner?.code, ...args.agents.map((agent) => agent.code), ...args.services.map((service) => service.code)]) {
    if (special) allCodes.add(special);
  }

  // Who claims each login: a card's hub:<id>, a confirmed link, the owner, a service.
  const claims = new Map<number, { code: string; how: string }>();
  const claim = (userId: number, who: string, how: string) => {
    const prior = claims.get(userId);
    const user = usersById.get(userId)!;
    if (prior && prior.code !== who) {
      say("login_in_two_people", who, `вход ${loginWords(user)} уже за ${prior.code} (${prior.how}); здесь — ${how}: оставлен за ${prior.code}`);
      return false;
    }
    const linked = catalog.linkedLogins.get(userId);
    if (linked !== undefined && linked !== who) {
      say("login_in_two_people", who, `вход ${loginWords(user)} в реестре уже за ${linked}; здесь — ${how}: не связан`);
      return false;
    }
    claims.set(userId, { code: who, how });
    return true;
  };
  const loginsOf = new Map<string, number[]>();
  const addLogin = (who: string, userId: number) => {
    const ids = loginsOf.get(who) ?? [];
    if (!ids.includes(userId)) ids.push(userId);
    loginsOf.set(who, ids);
  };

  for (const card of args.cards) {
    for (const alias of card.aliases) {
      const match = /^hub:(\d+)$/.exec(alias.trim());
      if (!match) continue;
      const userId = Number(match[1]);
      if (!usersById.has(userId)) {
        say("alias_login_missing", card.code, `в карточке hub:${userId}, такого входа в хабе нет`);
        continue;
      }
      if (claim(userId, card.code, `hub:${userId} в карточке`)) addLogin(card.code, userId);
    }
  }
  for (const link of args.links) {
    const user = usersByName.get(link.username.toLowerCase());
    if (!user) { say("link_login_missing", link.code, `подтверждённого входа «${link.username}» в хабе нет`); continue; }
    if (!allCodes.has(link.code)) { say("link_person_missing", link.code, `вход ${link.username} подтверждён за ${link.code}, а такого человека нет`); continue; }
    if (claim(user.id, link.code, "подтверждён владельцем")) addLogin(link.code, user.id);
  }
  if (args.owner) {
    for (const username of args.owner.usernames) {
      const user = usersByName.get(username.toLowerCase());
      if (!user) { say("link_login_missing", args.owner.code, `вход владельца «${username}» в хабе не найден`); continue; }
      if (claim(user.id, args.owner.code, "вход владельца")) addLogin(args.owner.code, user.id);
    }
  }
  for (const service of args.services) {
    for (const username of service.usernames) {
      const user = usersByName.get(username.toLowerCase());
      if (!user) { say("link_login_missing", service.code, `служебного входа «${username}» в хабе нет`); continue; }
      if (claim(user.id, service.code, "служебный")) addLogin(service.code, user.id);
    }
  }

  // Telegram ids and report tags from ledger's report authors.
  const telegramIdOf = new Map<string, number>();
  const tagOf = new Map<string, string>();
  const idTaken = new Map<number, string>();
  const tagTaken = new Map<string, string>();
  for (const author of args.ledger.reportAuthors) {
    const key = author.key.trim();
    if (!allCodes.has(author.code)) {
      say("report_author_unknown", null, `в ledger report_authors «${key}» указывает на ${author.code}, такого человека нет`);
      continue;
    }
    const tg = /^tg:(\d+)$/.exec(key);
    if (tg) {
      const id = Number(tg[1]);
      if (idTaken.has(id) && idTaken.get(id) !== author.code) {
        say("telegram_twice", author.code, `Telegram id из report_authors уже у ${idTaken.get(id)}`);
        continue;
      }
      if (telegramIdOf.has(author.code) && telegramIdOf.get(author.code) !== id) {
        say("telegram_twice", author.code, "в report_authors два разных Telegram id: взят первый");
        continue;
      }
      idTaken.set(id, author.code);
      telegramIdOf.set(author.code, id);
    } else if (/^#[^\s#]{1,63}$/.test(key)) {
      const lower = key.toLowerCase();
      if (tagTaken.has(lower) && tagTaken.get(lower) !== author.code) {
        say("tag_twice", author.code, `тег ${key} уже у ${tagTaken.get(lower)}`);
        continue;
      }
      if (tagOf.has(author.code) && tagOf.get(author.code) !== key) {
        say("tag_twice", author.code, `в report_authors два тега (${tagOf.get(author.code)}, ${key}): взят первый`);
        continue;
      }
      tagTaken.set(lower, author.code);
      tagOf.set(author.code, key);
    } else {
      say("report_author_unreadable", author.code, `ключ report_authors «${key}» — ни tg:<id>, ни #тег`);
    }
  }

  // Pay terms from the tabs (person × model).
  const termsOf = new Map<string, AdminPersonPayTermBody[]>();
  const tabsOf = new Map<string, { model: string; name: string; shareBasisPoints: number | null }[]>();
  for (const tab of args.ledger.payrollTabs) {
    const where = `вкладка «${tab.name}» таблицы ${tab.model}`;
    if (tab.code === null) { say("tab_unmapped", null, `${where} ни с кем не сопоставлена`); continue; }
    if (!allCodes.has(tab.code)) { say("tab_person_missing", tab.code, `${where} сопоставлена с ${tab.code}, такого человека нет`); continue; }
    tabsOf.set(tab.code, [...(tabsOf.get(tab.code) ?? []), { model: tab.model, name: tab.name, shareBasisPoints: tab.shareBasisPoints }]);
    if (tab.status && tab.status !== "ok") say("tab_unreadable", tab.code, `${where}: ledger не разобрал шапку (${tab.status})`);
    const modelSlug = modelSlugOf(tab.model);
    if (modelSlug === null) { say("tab_model_unknown", tab.code, `${where}: модели «${tab.model}» в хабе нет`); continue; }
    if (tab.shareBasisPoints === null) { say("tab_no_rate", tab.code, `${where}: в шапке нет «Ставка %»`); continue; }
    if (!args.termsValidFrom) continue;
    if (tab.fixPerShiftMills === null) say("tab_fix_unknown", tab.code, `${where}: «Фикс/см» ledger не знает: взят 0, проверьте`);
    const terms = termsOf.get(tab.code) ?? [];
    if (terms.some((term) => term.modelSlug === modelSlug)) {
      say("tab_twice", tab.code, `${where}: у человека уже есть вкладка модели ${modelSlug}; условия взяты из первой`);
      continue;
    }
    terms.push({ modelSlug, validFrom: args.termsValidFrom, shareBasisPoints: tab.shareBasisPoints, fixPerShiftMills: tab.fixPerShiftMills ?? 0 });
    termsOf.set(tab.code, terms);
  }

  // Page slots by person.
  const pageSlotsOf = new Map<string, PersonScheduleInput[]>();
  for (const slot of args.pageSlots) {
    const edges = parseCardSlot(`${slot.start}-${slot.end}`);
    if (!allCodes.has(slot.code)) { say("page_slot_person_missing", slot.code, "слот страницы для человека, которого нет"); continue; }
    if (!pagesByLabel.has(slot.pageLabel)) { say("page_unknown", slot.code, `слот страницы ${slot.pageLabel}: такой страницы в хабе нет`); continue; }
    if (!edges) { say("page_slot_unreadable", slot.code, `слот страницы ${slot.pageLabel} «${slot.start}-${slot.end}» не читается`); continue; }
    const weekdays = slot.weekdays?.filter((one): one is (typeof PERSON_WEEKDAYS)[number] => (PERSON_WEEKDAYS as readonly string[]).includes(one)) ?? null;
    pageSlotsOf.set(slot.code, [...(pageSlotsOf.get(slot.code) ?? []), {
      pageLabel: slot.pageLabel, from: slot.validFrom ?? null, slot: { start: edges.start, end: edges.end, weekdays },
    }]);
  }

  const drafts: ImportDraft[] = [];
  const skipped: string[] = [];
  const draftOf = (draft: ImportDraft) => {
    if (catalog.existingCodes.has(draft.code)) { skipped.push(draft.code); return; }
    drafts.push(draft);
  };
  const loginsBody = (who: string) => {
    const ids = loginsOf.get(who) ?? [];
    return ids.length === 0 ? {} : { logins: { add: ids } };
  };

  // People of the cards (and of ledger alone).
  for (const who of [...allCodes].sort()) {
    if (who === args.owner?.code || args.agents.some((agent) => agent.code === who) || args.services.some((service) => service.code === who)) continue;
    const card = cards.get(who);
    const ledger = ledgerPeople.get(who);
    const sources: string[] = [];
    if (card) sources.push("карточка /OS"); else say("card_missing", who, "в ledger есть, карточки /OS нет");
    if (ledger) sources.push("ledger"); else if (card) say("ledger_missing", who, "карточка /OS есть, в ledger нет");
    if (card && ledger) {
      if (card.status.trim() !== ledger.status.trim()) say("status_differs", who, `статус в карточке ${card.status}, в ledger ${ledger.status}`);
      const title = card.title.replace(/^["']|["']$/g, "").trim();
      if (title !== ledger.name.trim()) say("name_differs", who, `имя в карточке «${title}», в ledger «${ledger.name}»`);
      const cardSlot = card.schedule ? parseCardSlot(card.schedule) : null;
      const ledgerSlot = ledger.schedule ? parseCardSlot(ledger.schedule) : null;
      if ((cardSlot?.start ?? null) !== (ledgerSlot?.start ?? null) || (cardSlot?.end ?? null) !== (ledgerSlot?.end ?? null)) {
        say("schedule_differs", who, `график в карточке ${card.schedule ?? "—"}, в ledger ${ledger.schedule ?? "—"}`);
      }
    }

    const status = card?.status ?? ledger?.status ?? "active";
    const mapped = stateOfCardStatus(status);
    if (!mapped) say("status_unknown", who, `статус «${status}» не из словаря: взято «оформлен»`);
    else if (!mapped.exact) say("status_rough", who, `статус «${status}» в реестре — «${mapped.state}»: точнее слова нет`);
    const state: PersonState = mapped?.state ?? "set_up";
    const leftOn = state === "left" && card?.ended && /^\d{4}-\d{2}-\d{2}$/.test(card.ended) ? card.ended : null;

    let role: PersonRole;
    if (args.roles[who]) role = args.roles[who]!;
    else if (card) {
      const guess = guessRole(card);
      role = guess.role;
      if (!guess.sure) say("role_guess", who, `роль по должности «${card.position ?? "—"}» не ясна: взято «${role}», уточните в roles`);
    } else {
      role = /чаттер/i.test(ledger?.position ?? "") ? "chatter" : "contractor";
      say("role_guess", who, `роль по должности ledger «${ledger?.position ?? "—"}»: взято «${role}», уточните в roles`);
    }

    // Working pages.
    const workingPageLabels: string[] = [];
    for (const label of card?.pages ?? []) {
      if (!pagesByLabel.has(label)) say("page_unknown", who, `в карточке страница ${label}, в хабе её нет`);
      else if (!workingPageLabels.includes(label)) workingPageLabels.push(label);
    }

    // Schedule (the card's line for every page).
    let schedule: PersonScheduleInput | undefined;
    if (card?.schedule && card.schedule.trim() !== "null") {
      const edges = parseCardSlot(card.schedule);
      if (!edges) say("schedule_unreadable", who, `график карточки «${card.schedule}» не читается`);
      else {
        const workdays = card.workdays ?? null;
        const bad = (workdays ?? []).filter((one) => !(PERSON_WEEKDAYS as readonly string[]).includes(one));
        if (bad.length > 0) say("workdays_unreadable", who, `дни карточки ${list(bad)} не из mon…sun: дни не взяты`);
        const started = card.scheduleStarted && /^\d{4}-\d{2}-\d{2}$/.test(card.scheduleStarted) ? card.scheduleStarted : null;
        schedule = {
          from: started,
          slot: {
            start: edges.start,
            end: edges.end,
            weekdays: workdays && bad.length === 0 ? workdays as (typeof PERSON_WEEKDAYS)[number][] : null,
          },
        };
      }
    }

    // Telegram.
    let handle = card?.telegram?.trim().replace(/^@/, "") ?? null;
    if (handle === "" || handle === "null") handle = null;
    if (handle !== null && !/^[A-Za-z0-9_]{3,64}$/.test(handle)) {
      say("telegram_unreadable", who, `telegram карточки «${handle}» — не хэндл`);
      handle = null;
    }
    const telegramUserId = telegramIdOf.get(who) ?? null;
    const reportTag = tagOf.get(who) ?? null;
    if (card && handle === null && telegramUserId !== null) {
      say("telegram_missing", who, "в карточке telegram пуст, а в ledger report_authors есть Telegram id");
    }
    if (state === "working" && role === "chatter" && telegramUserId === null) {
      say("telegram_no_id", who, "чаттер без Telegram id (нет в ledger report_authors): его отчёт не узнается по отправителю");
    }

    // Logins vs the card.
    const ids = loginsOf.get(who) ?? [];
    const users = ids.map((id) => usersById.get(id)!);
    const active = users.filter(isActive);
    if (state === "left" && active.length > 0) say("left_login_alive", who, `ушёл, но вход жив: ${list(active.map(loginWords))}`);
    if (state === "working" && users.length > 0 && active.length === 0) {
      say("working_logins_off", who, `работает, но все входы отключены: ${list(users.map(loginWords))}`);
    }
    if (state === "working" && users.length === 0 && (role === "chatter" || role === "team_lead" || role === "content_manager")) {
      say("working_without_login", who, "работает, а входа хаба нет");
    }
    if (state === "working" && role === "chatter" && workingPageLabels.length === 0) {
      say("chatter_without_pages", who, "чаттер работает, а рабочих страниц в карточке нет");
    }
    if (workingPageLabels.length > 0 && active.length > 0) {
      const access = [...new Set(active.flatMap((user) => user.pageLabels))].sort();
      const working = new Set(workingPageLabels);
      const extra = access.filter((label) => !working.has(label));
      const missing = workingPageLabels.filter((label) => !access.includes(label));
      if (extra.length > 0 || missing.length > 0) {
        say("pages_differ", who, `рабочие страницы карточки: ${list(workingPageLabels)}; доступ хаба (${list(active.map((user) => user.username))}): ${list(access)}`
          + (extra.length > 0 ? `; только в доступе: ${list(extra)}` : "")
          + (missing.length > 0 ? `; нет доступа к рабочей: ${list(missing)}` : ""));
      }
    }

    // Models: ledger's (and the tabs') vs the card's working pages.
    if (ledger && ledger.models.length > 0 && workingPageLabels.length > 0) {
      const ledgerModels = [...new Set(ledger.models.map((name) => modelSlugOf(name) ?? `?${name}`))].sort();
      const pageModels = [...new Set(workingPageLabels.map((label) => pagesByLabel.get(label)!.modelSlug))].sort();
      if (ledgerModels.join() !== pageModels.join()) {
        say("models_differ", who, `модели в ledger: ${list(ledgerModels)}; по рабочим страницам карточки: ${list(pageModels)}`);
      }
    }

    // The card's rate text vs the tabs (the words stored carry no numbers; the report's detail does).
    const cardPercent = percentOfRate(card?.rate);
    for (const tab of tabsOf.get(who) ?? []) {
      if (cardPercent !== null && tab.shareBasisPoints !== null && cardPercent !== tab.shareBasisPoints) {
        say("rate_differs", who, `ставка в тексте карточки не совпадает с «Ставка %» вкладки «${tab.name}» таблицы ${tab.model}`,
          `карточка: ${cardPercent / 100}%, вкладка: ${tab.shareBasisPoints / 100}%`);
      }
    }

    const body: AdminPersonCreateBody = {
      code: who,
      kind: "human",
      displayName: (card?.title ?? ledger?.name ?? who).replace(/^["']|["']$/g, "").trim() || who,
      role,
      state,
      ...(leftOn ? { leftOn } : {}),
      telegram: { userId: telegramUserId, handle, reportTag },
      ...(workingPageLabels.length > 0 ? { workingPageLabels } : {}),
      ...(schedule ? { schedule } : {}),
      ...loginsBody(who),
    };
    draftOf({ code: who, body, pageSlots: pageSlotsOf.get(who) ?? [], payTerms: termsOf.get(who) ?? [], sources });
  }

  // The owner.
  if (args.owner) {
    const owner = args.owner;
    draftOf({
      code: owner.code,
      body: {
        code: owner.code, kind: "human", displayName: owner.displayName, role: "owner", state: "working",
        telegram: { userId: owner.telegramUserId ?? null, handle: owner.telegramHandle?.replace(/^@/, "") ?? null, reportTag: null },
        ...loginsBody(owner.code),
      },
      pageSlots: [], payTerms: [], sources: ["владелец (файл аргументов)"],
    });
  }

  // Agents and their keys.
  const keysByName = new Map(catalog.agentKeys.map((key) => [key.name, key]));
  const claimedKeys = new Set<number>();
  for (const agent of args.agents) {
    const keyIds: number[] = [];
    for (const name of agent.agentKeyNames) {
      const key = keysByName.get(name);
      if (!key) { say("agent_key_missing", agent.code, `ключа агента «${name}» в хабе нет`); continue; }
      if (claimedKeys.has(key.id)) { say("agent_key_twice", agent.code, `ключ «${name}» уже у другого агента`); continue; }
      claimedKeys.add(key.id);
      keyIds.push(key.id);
    }
    draftOf({
      code: agent.code,
      body: {
        code: agent.code, kind: "agent", displayName: agent.displayName, role: "agent", state: "working",
        ...(agent.note ? { note: agent.note } : {}),
        ...(keyIds.length > 0 ? { agentKeys: { add: keyIds } } : {}),
        ...loginsBody(agent.code),
      },
      pageSlots: [], payTerms: [], sources: ["агент (файл аргументов)"],
    });
  }
  const now = Date.now();
  for (const key of catalog.agentKeys) {
    if (key.revokedAt || key.expiresAt.getTime() <= now || claimedKeys.has(key.id)) continue;
    say("agent_key_unlinked", null, `живой ключ агента «${key.name}» ни за каким агентом`);
  }

  // Services.
  for (const service of args.services) {
    draftOf({
      code: service.code,
      body: {
        code: service.code, kind: "service", displayName: service.displayName, role: "service", state: "working",
        ...(service.note ? { note: service.note } : {}),
        ...loginsBody(service.code),
      },
      pageSlots: [], payTerms: [], sources: ["служебный (файл аргументов)"],
    });
  }

  // Logins nobody holds: proposed as service, or listed for the owner.
  const serviceProposals: ServiceProposal[] = [];
  for (const user of catalog.users) {
    if (claims.has(user.id) || catalog.linkedLogins.has(user.id)) continue;
    const reasons: string[] = [];
    if (SERVICE_NAME.test(user.username)) reasons.push("имя служебное или тестовое");
    if (!user.hasPassword) reasons.push("пароля не было никогда");
    if (user.deletedAt) reasons.push(`удалён ${toBusinessDate(user.deletedAt)}`);
    else if (user.disabledAt) reasons.push(`отключён ${toBusinessDate(user.disabledAt)}`);
    if (SERVICE_NAME.test(user.username)) {
      serviceProposals.push({ userId: user.id, username: user.username, why: reasons.join("; ") });
      continue;
    }
    const namesake = allCodes.has(user.username.toLowerCase()) ? user.username.toLowerCase() : null;
    const card = namesake ? cards.get(namesake) : undefined;
    const hint = namesake
      ? `; есть ${card ? "карточка" : "человек"} ${namesake}${card ? ` (статус ${card.status}${card.ended ? `, ушёл ${card.ended}` : ""})` : ""} — тот же человек? Если да, впишите в links`
      : "";
    say("login_without_person", null, `вход ${loginWords(user)} без человека${hint}`);
  }

  // Logins other systems write for a person.
  for (const other of args.otherLogins) {
    const user = usersByName.get(other.username.toLowerCase());
    const theirs = (loginsOf.get(other.code) ?? []).map((id) => usersById.get(id)!.username);
    if (!user) {
      say("other_login_unknown", other.code, `${other.source} пишет вход «${other.username}», в хабе такого нет; у ${other.code} вход(ы): ${list(theirs)}`);
    } else if (claims.get(user.id)?.code !== other.code) {
      say("other_login_differs", other.code, `${other.source} пишет вход «${other.username}», а он ${claims.has(user.id) ? `за ${claims.get(user.id)!.code}` : "ни за кем"}`);
    }
  }

  return { drafts, discrepancies, serviceProposals, skipped };
}

// ── writing it ───────────────────────────────────────────────────────────────

/** Writes every draft in one transaction: the person (origin import, with its notes), a page's own schedule lines,
 *  the pay terms. A code already in the registry was left out by the plan. */
export async function applyPeopleImport(app: AppContext, plan: ImportPlan, audit: AuditContext) {
  return withAuditTransaction(app, async (db) => {
    const created: string[] = [];
    for (const draft of plan.drafts) {
      if (await findPersonRowByCode(db, draft.code)) continue;
      const notes: PersonImportNoteRow[] = plan.discrepancies
        .filter((one) => one.person === draft.code)
        .map((one) => ({ code: one.code, text: one.text }));
      let { row } = await createPersonInTransaction(app, db, draft.body, audit, "import", notes);
      for (const schedule of draft.pageSlots) row = await updatePersonInTransaction(db, draft.code, { schedule }, audit);
      for (const term of draft.payTerms) row = await setPayTermInTransaction(db, row, term, audit);
      created.push(row.code);
    }
    return { created };
  });
}

// ── the owner's report ───────────────────────────────────────────────────────

const GROUPS: { title: string; codes: string[] }[] = [
  { title: "Входы хаба", codes: ["login_without_person", "login_in_two_people", "alias_login_missing", "link_login_missing", "link_person_missing", "left_login_alive", "working_logins_off", "working_without_login", "other_login_unknown", "other_login_differs"] },
  { title: "Рабочие страницы и доступ", codes: ["pages_differ", "page_unknown", "chatter_without_pages", "models_differ"] },
  { title: "Карточки /OS и ledger", codes: ["card_missing", "ledger_missing", "status_differs", "name_differs", "schedule_differs", "status_unknown", "status_rough", "role_guess", "schedule_unreadable", "workdays_unreadable", "page_slot_person_missing", "page_slot_unreadable"] },
  { title: "Telegram и теги отчёта", codes: ["telegram_missing", "telegram_no_id", "telegram_unreadable", "telegram_twice", "tag_twice", "report_author_unknown", "report_author_unreadable"] },
  { title: "Вкладки выплат и условия", codes: ["tab_unmapped", "tab_person_missing", "tab_unreadable", "tab_model_unknown", "tab_no_rate", "tab_fix_unknown", "tab_twice", "rate_differs"] },
  { title: "Ключи агентов", codes: ["agent_key_unlinked", "agent_key_missing", "agent_key_twice"] },
];

/** The plan as a Russian markdown page for the owner (rates only in the detail lines). */
export function renderImportMarkdown(plan: ImportPlan, input: { title: string; preparedAt: string }): string {
  const lines: string[] = [`# ${input.title}`, "", `Собрано ${input.preparedAt}. Ничего не записано, пока импорт не запущен с --apply.`, ""];
  const byKind = (kind: string) => plan.drafts.filter((draft) => (draft.body.kind ?? "human") === kind).length;
  lines.push("## Итог", "",
    `- Черновиков: ${plan.drafts.length} (людей ${byKind("human")}, агентов ${byKind("agent")}, служебных ${byKind("service")}).`,
    `- Уже в реестре, не тронуты: ${plan.skipped.length === 0 ? "—" : plan.skipped.join(", ")}.`,
    `- Расхождений: ${plan.discrepancies.length}.`,
    `- Предлагаю считать служебными (kind service): ${plan.serviceProposals.length} входов.`, "");
  const seen = new Set<string>();
  for (const group of GROUPS) {
    const items = plan.discrepancies.filter((one) => group.codes.includes(one.code));
    items.forEach((one) => seen.add(`${one.code}|${one.person}|${one.text}`));
    if (items.length === 0) continue;
    lines.push(`## ${group.title} (${items.length})`, "");
    for (const one of items) {
      lines.push(`- ${one.person ? `**${one.person}**: ` : ""}${one.text} \`${one.code}\`${one.detail ? ` — ${one.detail}` : ""}`);
    }
    lines.push("");
  }
  const rest = plan.discrepancies.filter((one) => !seen.has(`${one.code}|${one.person}|${one.text}`));
  if (rest.length > 0) {
    lines.push(`## Прочее (${rest.length})`, "");
    for (const one of rest) lines.push(`- ${one.person ? `**${one.person}**: ` : ""}${one.text} \`${one.code}\``);
    lines.push("");
  }
  if (plan.serviceProposals.length > 0) {
    lines.push("## Предлагаю как служебные (kind service)", "",
      "Подтвердите списком в `services` файла аргументов — тогда проверки «вход без человека» и «смена без отчёта» их не тронут.", "");
    for (const one of plan.serviceProposals) lines.push(`- ${one.username} (#${one.userId}): ${one.why}`);
    lines.push("");
  }
  lines.push("## Черновики", "", "| Код | Вид | Роль | Состояние | Входы | Рабочие страницы | График | Telegram id / тег | Условий |", "|---|---|---|---|---|---|---|---|---|");
  for (const draft of plan.drafts) {
    const body = draft.body;
    const slot = body.schedule?.slot ? `${body.schedule.slot.start}-${body.schedule.slot.end}` : "—";
    const pageSlots = draft.pageSlots.map((one) => `${one.pageLabel} ${one.slot?.start}-${one.slot?.end}`);
    lines.push(`| ${draft.code} | ${body.kind ?? "human"} | ${body.role} | ${body.state ?? "invited"} | ${body.logins?.add?.length ?? 0}`
      + ` | ${list(body.workingPageLabels ?? [])} | ${[slot, ...pageSlots].join("; ")} | ${body.telegram?.userId ? "id" : "—"} / ${body.telegram?.reportTag ?? "—"}`
      + ` | ${draft.payTerms.length} |`);
  }
  lines.push("");
  return lines.join("\n");
}
