// The people registry (ecosystem plan 2026-11-12, package A), in shadow: the
// one service behind every door — the team's list (a session), the owner's
// card and writes (the owner's session), the agent feed and the agents'
// proposals (an agent key). A change is resolved first (every page, login,
// key and Telegram id looked up, every rule checked) and only then applied, so
// an agent's proposal is checked against the registry when it is made and
// again when the owner accepts it — through the very same edit.
//
// Pay terms are money: they are read here only for the owner's card and for a
// key with read:pay_terms; nothing else of this file carries them.

import {
  PERSON_SLOT_MAX_MINUTES,
  PERSON_SLOT_MIN_MINUTES,
  personProposalChangeSchema,
  type AdminPersonCreateBody,
  type AdminPersonPayTermBody,
  type AdminPersonResponse,
  type AdminPersonUpdateBody,
  type AgentPeopleResponse,
  type AgentPerson,
  type AgentPersonProposalBody,
  type Person,
  type PersonLogin,
  type PersonPayTerm,
  type PersonProposal,
  type PersonProposalChange,
  type PersonScheduleInput,
  type PersonScheduleSlot,
  type TeamPeopleResponse,
} from "@agency_hub_core/contracts";
import {
  countOpenPersonProposals,
  decidePersonProposal as decideProposalRow,
  deletePersonAgentKey,
  deletePersonLogin,
  endPersonScheduleSlot,
  findPersonIdOfAgentKey,
  findPersonIdOfLogin,
  findPersonProposal,
  findPersonRowByCode,
  findPersonRowById,
  findUserById,
  insertPersonAgentKey,
  insertPersonLogin,
  insertPersonProposal,
  insertPersonRow,
  insertPersonScheduleSlot,
  isUniqueViolation,
  listPeopleCatalogAgentKeys,
  listPeopleCatalogModels,
  listPeopleCatalogPages,
  listPersonAgentKeyRows,
  listPersonLoginRows,
  listPersonPayTermRows,
  listPersonProposalRows,
  listPersonRightRows,
  listPersonRows,
  listPersonRowsChangedSince,
  listPersonScheduleSlotRows,
  listPersonWorkingPageRows,
  listUnlinkedLoginRows,
  replacePersonRights,
  replacePersonWorkingPages,
  rewritePersonScheduleSlot,
  updatePersonRow,
  upsertPersonPayTerm,
  type PersonAgentKeyRow,
  type PersonImportNoteRow,
  type PersonLoginRow,
  type PersonPayTermRow,
  type PersonProposalRow,
  type PersonRow,
  type PersonRowOrigin,
  type PersonRowPatch,
  type PersonScheduleSlotRow,
} from "@agency_hub_core/db";
import { millsFromInteger, millsToNumber, toBusinessDate } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { createInvite } from "../account-links.ts";
import { recordAudit, withAuditTransaction, type AuditContext, type HumanAuthPrincipal } from "../auth.ts";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.ts";

type Db = AppContext["db"];

// ── small helpers ────────────────────────────────────────────────────────────

/** `HH:MM` → minute of the day; `24:00` → 1440. */
export function slotMinute(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

/** Minute of the day → `HH:MM`; 1440 → `24:00`. */
export function slotTime(minute: number): string {
  const hours = Math.floor(minute / 60);
  return `${String(hours).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/** How long a slot lasts, minutes (it may end the next day). */
export function slotLength(startMinute: number, endMinute: number): number {
  return (endMinute - startMinute + 1440) % 1440;
}

/** The day before a business date. */
export function dayBefore(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! - 1)).toISOString().slice(0, 10);
}

function loginState(login: Pick<PersonLoginRow, "hasPassword" | "disabledAt" | "deletedAt">): PersonLogin["state"] {
  if (login.deletedAt) return "deleted";
  if (login.disabledAt) return "disabled";
  return login.hasPassword ? "active" : "invited";
}

function keyState(key: Pick<PersonAgentKeyRow, "expiresAt" | "revokedAt">, now: Date): "active" | "expired" | "revoked" {
  if (key.revokedAt) return "revoked";
  return key.expiresAt.getTime() <= now.getTime() ? "expired" : "active";
}

function slotView(slot: PersonScheduleSlotRow): PersonScheduleSlot {
  return {
    id: slot.id,
    personId: slot.personId,
    pageId: slot.pageId,
    pageLabel: slot.pageLabel,
    startMinute: slot.startMinute,
    endMinute: slot.endMinute,
    start: slotTime(slot.startMinute),
    end: slotTime(slot.endMinute),
    weekdays: (slot.weekdays as PersonScheduleSlot["weekdays"]) ?? null,
    validFrom: slot.validFrom,
    validTo: slot.validTo,
  };
}

/** The slot holding on `today`, else the next one to begin; slots come oldest first. */
export function currentSlot<T extends { validFrom: string | null; validTo: string | null }>(slots: readonly T[], today: string): T | null {
  let holding: T | null = null;
  for (const slot of slots) {
    if ((slot.validFrom === null || slot.validFrom <= today) && (slot.validTo === null || slot.validTo >= today)) holding = slot;
  }
  if (holding) return holding;
  return slots.find((slot) => slot.validFrom !== null && slot.validFrom > today) ?? null;
}

function termViews(terms: readonly PersonPayTermRow[]): PersonPayTerm[] {
  return terms.map((term) => {
    const next = terms.find((other) => other.personId === term.personId && other.modelId === term.modelId && other.validFrom > term.validFrom);
    return {
      id: term.id,
      modelSlug: term.modelSlug,
      modelName: term.modelName,
      validFrom: term.validFrom,
      validTo: next ? dayBefore(next.validFrom) : null,
      shareBasisPoints: term.shareBasisPoints,
      fixPerShiftMills: millsToNumber(term.fixPerShiftMills),
      note: term.note,
      updatedAt: term.updatedAt.toISOString(),
    };
  });
}

function groupBy<T extends { personId: number }>(rows: readonly T[]): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const row of rows) {
    const list = map.get(row.personId);
    if (list) list.push(row);
    else map.set(row.personId, [row]);
  }
  return map;
}

// ── views ────────────────────────────────────────────────────────────────────

interface PeopleParts {
  logins: Map<number, PersonLoginRow[]>;
  keys: Map<number, PersonAgentKeyRow[]>;
  pages: Map<number, Awaited<ReturnType<typeof listPersonWorkingPageRows>>>;
  slots: Map<number, PersonScheduleSlotRow[]>;
  rights: Map<number, Awaited<ReturnType<typeof listPersonRightRows>>>;
  openProposals: Map<number, number>;
}

async function loadParts(db: Db, personIds?: readonly number[]): Promise<PeopleParts> {
  // In turn, not Promise.all: inside a transaction they share one connection.
  const logins = await listPersonLoginRows(db, personIds);
  const keys = await listPersonAgentKeyRows(db, personIds);
  const pages = await listPersonWorkingPageRows(db, personIds);
  const slots = await listPersonScheduleSlotRows(db, personIds);
  const rights = await listPersonRightRows(db, personIds);
  const openProposals = await countOpenPersonProposals(db);
  return {
    logins: groupBy(logins),
    keys: groupBy(keys),
    pages: groupBy(pages),
    slots: groupBy(slots),
    rights: groupBy(rights),
    openProposals,
  };
}

function loginView(login: PersonLoginRow): PersonLogin {
  return { userId: login.userId, username: login.username, role: login.role, state: loginState(login) };
}

/** The person's line for every page, and each page's own line, as they hold on `today`. */
function slotsNow(slots: readonly PersonScheduleSlotRow[], today: string) {
  const general = currentSlot(slots.filter((slot) => slot.pageId === null), today);
  const pageIds = [...new Set(slots.flatMap((slot) => (slot.pageId === null ? [] : [slot.pageId])))];
  const pages = pageIds.flatMap((pageId) => {
    const slot = currentSlot(slots.filter((one) => one.pageId === pageId), today);
    return slot ? [slot] : [];
  });
  return { general, pages };
}

function personView(row: PersonRow, parts: PeopleParts, now: Date): Person {
  const today = toBusinessDate(now);
  const slots = parts.slots.get(row.id) ?? [];
  const current = slotsNow(slots, today);
  return {
    id: row.id,
    code: row.code,
    displayName: row.displayName,
    kind: row.kind,
    role: row.role,
    state: row.state,
    leftOn: row.leftOn,
    telegram: { userId: row.telegramUserId, handle: row.telegramHandle, reportTag: row.reportTag },
    logins: (parts.logins.get(row.id) ?? []).map(loginView),
    agentKeys: (parts.keys.get(row.id) ?? []).map((key) => ({ agentKeyId: key.agentKeyId, name: key.name, state: keyState(key, now) })),
    workingPages: (parts.pages.get(row.id) ?? []).map((page) => ({
      pageLabel: page.label, platform: page.platform, modelSlug: page.modelSlug, modelName: page.modelName,
    })),
    schedule: current.general ? slotView(current.general) : null,
    pageSchedules: current.pages.map(slotView),
    rights: (parts.rights.get(row.id) ?? []).map((right) => ({ right: right.right, grantedAt: right.grantedAt.toISOString() })),
    onboarding: row.onboarding.map((step) => ({ step: step.step, doneAt: step.doneAt ?? null, note: step.note ?? null })),
    note: row.note,
    importNotes: row.importNotes,
    origin: row.origin,
    openProposals: parts.openProposals.get(row.id) ?? 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function proposalView(row: PersonProposalRow): PersonProposal {
  const kind = row.change.kind === "create" ? "create" : "update";
  return {
    id: row.id,
    kind,
    personCode: row.personCode,
    change: row.change,
    reason: row.reason,
    requestedBy: row.requestedBy,
    sourceRef: row.sourceRef,
    agentKeyName: row.agentKeyName,
    state: row.state,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
  };
}

/** The team's list (owner and team lead): no money anywhere in it. */
export async function readTeamPeople(app: Pick<AppContext, "db">, principal: HumanAuthPrincipal, now = new Date()): Promise<TeamPeopleResponse> {
  const rows = await listPersonRows(app.db);
  const parts = await loadParts(app.db);
  const unlinked = principal.user.role === "owner" ? await listUnlinkedLoginRows(app.db) : [];
  return {
    people: rows.map((row) => personView(row, parts, now)),
    unlinkedLogins: unlinked.map(loginView),
    serverNow: now.toISOString(),
  };
}

async function personDetail(db: Db, row: PersonRow, now: Date): Promise<AdminPersonResponse> {
  const parts = await loadParts(db, [row.id]);
  const terms = await listPersonPayTermRows(db, [row.id]);
  const proposals = await listPersonProposalRows(db, { personId: row.id });
  return {
    person: personView(row, parts, now),
    scheduleSlots: (parts.slots.get(row.id) ?? []).map(slotView),
    payTerms: termViews(terms),
    proposals: proposals.map(proposalView),
    serverNow: now.toISOString(),
  };
}

async function requirePerson(db: Db, code: string, options: { lock?: boolean } = {}): Promise<PersonRow> {
  const row = await findPersonRowByCode(db, code, options);
  if (!row) throw new NotFoundError(`No person «${code}»`);
  return row;
}

/** The owner's card of one person: everything, pay terms included. */
export async function readPersonForOwner(app: Pick<AppContext, "db">, code: string, now = new Date()): Promise<AdminPersonResponse> {
  return personDetail(app.db, await requirePerson(app.db, code), now);
}

// ── resolving a change ───────────────────────────────────────────────────────

type ChangeFields = Omit<AdminPersonUpdateBody, never>;

interface ResolvedChange {
  patch: PersonRowPatch;
  workingPageIds?: number[];
  workingPageLabels?: string[];
  rights?: string[];
  schedule?: PersonScheduleInput;
  /** The schedule line the change is for: a page's own, or null — every page. */
  schedulePageId?: number | null;
  loginsAdd: number[];
  loginsRemove: number[];
  keysAdd: number[];
  keysRemove: number[];
  /** Field names that change, for the audit. */
  changed: string[];
}

/** The person as it would be: what a change is checked against. */
interface Subject {
  id: number | null;
  kind: PersonRow["kind"];
  role: PersonRow["role"];
  state: PersonRow["state"];
  leftOn: string | null;
}

function normalizeHandle(handle: string | null | undefined) {
  if (handle === undefined) return undefined;
  if (handle === null) return null;
  return handle.trim().replace(/^@/, "");
}

/**
 * Looks everything up and checks every rule of a change, writing nothing. A
 * refusal is a 400 (a broken rule), 404 (a page, login or key that does not
 * exist) or 409 (something another person holds).
 */
async function resolveChange(db: Db, subject: Subject, fields: ChangeFields): Promise<ResolvedChange> {
  const patch: PersonRowPatch = {};
  const changed: string[] = [];
  const resolved: ResolvedChange = { patch, loginsAdd: [], loginsRemove: [], keysAdd: [], keysRemove: [], changed };

  if (fields.displayName !== undefined) { patch.displayName = fields.displayName.trim(); changed.push("displayName"); }
  const role = fields.role ?? subject.role;
  if (fields.role !== undefined) { patch.role = fields.role; changed.push("role"); }
  const roleOfKind = subject.kind === "agent" ? "agent" : subject.kind === "service" ? "service" : null;
  if (roleOfKind !== null ? role !== roleOfKind : role === "agent" || role === "service") {
    throw new BadRequestError(roleOfKind !== null ? `A ${subject.kind}'s role is ${roleOfKind}` : `Only an agent or a service has the role ${role}`);
  }
  const state = fields.state ?? subject.state;
  if (fields.state !== undefined) { patch.state = fields.state; changed.push("state"); }
  if (fields.leftOn !== undefined) {
    if (fields.leftOn !== null && state !== "left") throw new BadRequestError("leftOn is only for a person who left (state left)");
    patch.leftOn = fields.leftOn;
    changed.push("leftOn");
  } else if (state !== "left" && subject.leftOn !== null) {
    patch.leftOn = null;
  }
  if (fields.telegram !== undefined) {
    const { userId, handle, reportTag } = fields.telegram;
    if (userId !== undefined) { patch.telegramUserId = userId; changed.push("telegram.userId"); }
    const normalized = normalizeHandle(handle);
    if (normalized !== undefined) { patch.telegramHandle = normalized; changed.push("telegram.handle"); }
    if (reportTag !== undefined) { patch.reportTag = reportTag === null ? null : reportTag.trim(); changed.push("telegram.reportTag"); }
  }
  if (fields.note !== undefined) { patch.note = fields.note === null || fields.note.trim() === "" ? null : fields.note.trim(); changed.push("note"); }
  if (fields.onboarding !== undefined) {
    patch.onboarding = fields.onboarding.map((step) => ({
      step: step.step.trim(),
      doneAt: step.doneAt ? new Date(step.doneAt).toISOString() : null,
      note: step.note ? step.note.trim() : null,
    }));
    changed.push("onboarding");
  }

  if (fields.workingPageLabels !== undefined) {
    const labels = fields.workingPageLabels;
    if (new Set(labels).size !== labels.length) throw new BadRequestError("A working page is listed twice");
    const pages = await listPeopleCatalogPages(db);
    const byLabel = new Map(pages.map((page) => [page.label, page]));
    const missing = labels.filter((label) => !byLabel.has(label));
    if (missing.length > 0) throw new NotFoundError(`No active page ${missing.map((label) => `«${label}»`).join(", ")}`);
    resolved.workingPageIds = labels.map((label) => byLabel.get(label)!.id);
    resolved.workingPageLabels = [...labels];
    changed.push("workingPages");
  }

  if (fields.rights !== undefined) {
    resolved.rights = [...new Set(fields.rights)];
    changed.push("rights");
  }

  if (fields.schedule !== undefined) {
    const slot = fields.schedule.slot;
    if (slot) {
      const length = slotLength(slotMinute(slot.start), slotMinute(slot.end));
      if (length < PERSON_SLOT_MIN_MINUTES || length > PERSON_SLOT_MAX_MINUTES) {
        throw new BadRequestError(`A shift lasts ${PERSON_SLOT_MIN_MINUTES / 60} to ${PERSON_SLOT_MAX_MINUTES / 60} hours: ${slot.start}-${slot.end} does not`);
      }
    }
    let pageId: number | null = null;
    const pageLabel = fields.schedule.pageLabel ?? null;
    if (pageLabel !== null) {
      const page = (await listPeopleCatalogPages(db)).find((one) => one.label === pageLabel);
      if (!page) throw new NotFoundError(`No active page «${pageLabel}»`);
      pageId = page.id;
    }
    resolved.schedulePageId = pageId;
    if (subject.id !== null) {
      const slots = (await listPersonScheduleSlotRows(db, [subject.id])).filter((one) => one.pageId === pageId);
      const latest = slots.at(-1);
      const from = fields.schedule.from;
      if (from === null && latest) throw new BadRequestError("The person has a schedule: give the day the change begins");
      if (from !== null && latest?.validFrom != null && latest.validFrom > from) {
        throw new BadRequestError(`The schedule has a slot from ${latest.validFrom}: a change begins after it`);
      }
      if (from !== null && latest?.validFrom === from && slot === null) {
        throw new BadRequestError(`A slot begins on ${from}: give the slot itself, or another day`);
      }
    }
    resolved.schedule = fields.schedule;
    changed.push("schedule");
  }

  if (fields.logins !== undefined) {
    const add = [...new Set(fields.logins.add ?? [])];
    const remove = [...new Set(fields.logins.remove ?? [])];
    for (const userId of add) {
      // A deleted login may be linked too (a service's old test login): linking reads it, it never works the account.
      if (!(await findUserById(db, userId))) throw new NotFoundError(`No login ${userId}`);
      const holder = await findPersonIdOfLogin(db, userId);
      if (holder !== null && holder !== subject.id) throw new ConflictError(`Login ${userId} belongs to another person`, { reason: "login_taken" });
      if (holder === null) resolved.loginsAdd.push(userId);
    }
    for (const userId of remove) {
      if (add.includes(userId)) throw new BadRequestError(`Login ${userId} is both added and taken off`);
      const holder = subject.id === null ? null : await findPersonIdOfLogin(db, userId);
      if (holder !== subject.id || holder === null) throw new BadRequestError(`Login ${userId} is not the person's`);
      resolved.loginsRemove.push(userId);
    }
    if (resolved.loginsAdd.length + resolved.loginsRemove.length > 0) changed.push("logins");
  }

  if (fields.agentKeys !== undefined) {
    const add = [...new Set(fields.agentKeys.add ?? [])];
    const remove = [...new Set(fields.agentKeys.remove ?? [])];
    if (add.length > 0 && subject.kind !== "agent") throw new BadRequestError("Only an agent person holds agent keys");
    const keys = add.length > 0 ? new Map((await listPeopleCatalogAgentKeys(db)).map((key) => [key.id, key])) : new Map();
    for (const agentKeyId of add) {
      if (!keys.has(agentKeyId)) throw new NotFoundError(`No agent key ${agentKeyId}`);
      const holder = await findPersonIdOfAgentKey(db, agentKeyId);
      if (holder !== null && holder !== subject.id) throw new ConflictError(`Agent key ${agentKeyId} belongs to another person`, { reason: "key_taken" });
      if (holder === null) resolved.keysAdd.push(agentKeyId);
    }
    for (const agentKeyId of remove) {
      const holder = subject.id === null ? null : await findPersonIdOfAgentKey(db, agentKeyId);
      if (holder !== subject.id || holder === null) throw new BadRequestError(`Agent key ${agentKeyId} is not the person's`);
      resolved.keysRemove.push(agentKeyId);
    }
    if (resolved.keysAdd.length + resolved.keysRemove.length > 0) changed.push("agentKeys");
  }

  return resolved;
}

/** Maps the registry's unique indexes to the 409 the owner can act on. */
function conflictOf(error: unknown): never {
  if (isUniqueViolation(error, "people_code_key")) throw new ConflictError("Another person has this code", { reason: "code_taken" });
  if (isUniqueViolation(error, "people_telegram_user_id_uidx")) {
    throw new ConflictError("Another person has this Telegram id", { reason: "telegram_taken" });
  }
  if (isUniqueViolation(error, "people_report_tag_uidx")) throw new ConflictError("Another person has this report tag", { reason: "tag_taken" });
  if (isUniqueViolation(error, "person_logins_pkey")) throw new ConflictError("The login belongs to another person", { reason: "login_taken" });
  if (isUniqueViolation(error, "person_agent_keys_pkey")) throw new ConflictError("The agent key belongs to another person", { reason: "key_taken" });
  throw error;
}

async function applySchedule(db: Db, personId: number, pageId: number | null, schedule: PersonScheduleInput, byUserId: number | null) {
  const slots = (await listPersonScheduleSlotRows(db, [personId])).filter((one) => one.pageId === pageId);
  const latest = slots.at(-1);
  const { from, slot } = schedule;
  const weekdays = slot?.weekdays ?? null;
  if (latest && from !== null && latest.validFrom === from && slot) {
    await rewritePersonScheduleSlot(db, latest.id, { startMinute: slotMinute(slot.start), endMinute: slotMinute(slot.end), weekdays });
    return;
  }
  if (latest && from !== null && (latest.validTo === null || latest.validTo >= from)) {
    await endPersonScheduleSlot(db, latest.id, dayBefore(from));
  }
  if (slot) {
    await insertPersonScheduleSlot(db, {
      personId, pageId, startMinute: slotMinute(slot.start), endMinute: slotMinute(slot.end), weekdays, validFrom: from, createdByUserId: byUserId,
    });
  }
}

/** Writes a resolved change of an existing person (the row is locked by the caller); moves updated_at. */
async function applyChange(db: Db, person: PersonRow, change: ResolvedChange, audit: AuditContext): Promise<PersonRow> {
  const byUserId = audit.actorUserId ?? null;
  try {
    for (const userId of change.loginsRemove) await deletePersonLogin(db, { personId: person.id, userId });
    for (const userId of change.loginsAdd) await insertPersonLogin(db, { personId: person.id, userId, linkedByUserId: byUserId });
    for (const agentKeyId of change.keysRemove) await deletePersonAgentKey(db, { personId: person.id, agentKeyId });
    for (const agentKeyId of change.keysAdd) await insertPersonAgentKey(db, { personId: person.id, agentKeyId, linkedByUserId: byUserId });
    if (change.workingPageIds) await replacePersonWorkingPages(db, person.id, change.workingPageIds);
    if (change.rights) await replacePersonRights(db, person.id, change.rights, byUserId);
    if (change.schedule) await applySchedule(db, person.id, change.schedulePageId ?? null, change.schedule, byUserId);
    return await updatePersonRow(db, person.id, change.patch);
  } catch (error) {
    return conflictOf(error);
  }
}

function changeMetadata(code: string, change: ResolvedChange): Record<string, unknown> {
  return {
    code,
    changed: change.changed,
    ...(change.patch.state === undefined ? {} : { state: change.patch.state }),
    ...(change.patch.role === undefined ? {} : { role: change.patch.role }),
    ...(change.workingPageLabels === undefined ? {} : { workingPages: change.workingPageLabels }),
    ...(change.rights === undefined ? {} : { rights: change.rights }),
    ...(change.schedule === undefined ? {} : { schedule: change.schedule }),
    ...(change.loginsAdd.length === 0 ? {} : { loginsAdded: change.loginsAdd }),
    ...(change.loginsRemove.length === 0 ? {} : { loginsRemoved: change.loginsRemove }),
    ...(change.keysAdd.length === 0 ? {} : { agentKeysAdded: change.keysAdd }),
    ...(change.keysRemove.length === 0 ? {} : { agentKeysRemoved: change.keysRemove }),
  };
}

function subjectOf(row: PersonRow): Subject {
  return { id: row.id, kind: row.kind, role: row.role, state: row.state, leftOn: row.leftOn };
}

// ── the owner's writes ───────────────────────────────────────────────────────

/** Changes an existing person in the caller's transaction. */
async function updatePersonTx(db: Db, code: string, fields: ChangeFields, audit: AuditContext): Promise<PersonRow> {
  const person = await requirePerson(db, code, { lock: true });
  const change = await resolveChange(db, subjectOf(person), fields);
  const updated = await applyChange(db, person, change, audit);
  await recordAudit({ db }, { ...audit, eventType: "person.updated", metadata: changeMetadata(person.code, change) });
  return updated;
}

export async function updatePerson(app: Pick<AppContext, "db">, code: string, body: AdminPersonUpdateBody, audit: AuditContext, now = new Date()) {
  return withAuditTransaction(app, async (db) => personDetail(db, await updatePersonTx(db, code, body, audit), now));
}

interface CreatedPerson {
  row: PersonRow;
  invite: NonNullable<Awaited<ReturnType<typeof createInvite>>> | null;
}

/** Creates a person (and the invitation, if any) in the caller's transaction. */
async function createPersonTx(
  app: AppContext,
  db: Db,
  body: Omit<AdminPersonCreateBody, "invite"> & { invite?: AdminPersonCreateBody["invite"] },
  audit: AuditContext,
  origin: PersonRowOrigin,
  importNotes: PersonImportNoteRow[] = [],
): Promise<CreatedPerson> {
  const { code, kind: givenKind, invite, ...fields } = body;
  const kind = givenKind ?? "human";
  if (invite && kind !== "human") throw new BadRequestError("Only a human is invited");
  const state = fields.state ?? "invited";
  const subject: Subject = { id: null, kind, role: fields.role, state, leftOn: null };
  const change = await resolveChange(db, subject, fields);
  let row: PersonRow;
  try {
    row = await insertPersonRow(db, {
      code,
      displayName: change.patch.displayName ?? fields.displayName.trim(),
      kind,
      role: fields.role,
      state,
      leftOn: change.patch.leftOn ?? null,
      telegramUserId: change.patch.telegramUserId ?? null,
      telegramHandle: change.patch.telegramHandle ?? null,
      reportTag: change.patch.reportTag ?? null,
      onboarding: change.patch.onboarding ?? [],
      note: change.patch.note ?? null,
      importNotes,
      origin,
      createdByUserId: audit.actorUserId ?? null,
    });
  } catch (error) {
    return conflictOf(error);
  }
  // The record is written; the rest hangs off it through the same edit.
  row = await applyChange(db, row, { ...change, patch: {} }, audit);
  let created: CreatedPerson["invite"] = null;
  if (invite) {
    // createInvite runs in a savepoint of this transaction: a taken login rolls the person back too.
    created = await createInvite({ ...app, db }, {
      username: invite.username,
      role: invite.role,
      pageLabels: invite.pageLabels,
      expiresInHours: invite.expiresInHours,
    }, audit);
    await insertPersonLogin(db, { personId: row.id, userId: created.user.id, linkedByUserId: audit.actorUserId ?? null }).catch(conflictOf);
    row = await updatePersonRow(db, row.id, {});
  }
  await recordAudit({ db }, {
    ...audit,
    eventType: "person.created",
    targetUserId: created?.user.id ?? null,
    metadata: { ...changeMetadata(code, change), kind, origin, ...(created ? { invitedUsername: created.user.username } : {}) },
  });
  return { row, invite: created };
}

export async function createPerson(app: AppContext, body: AdminPersonCreateBody, audit: AuditContext, now = new Date()) {
  return withAuditTransaction(app, async (db) => {
    const created = await createPersonTx(app, db, body, audit, "owner");
    const detail = await personDetail(db, created.row, now);
    return {
      ...detail,
      invite: created.invite
        ? {
          userId: created.invite.user.id,
          username: created.invite.user.username,
          link: {
            id: created.invite.link.id,
            keyPrefix: created.invite.link.keyPrefix,
            token: created.invite.link.token,
            expiresAt: created.invite.link.expiresAt,
          },
        }
        : null,
    };
  });
}

/** Sets a pay term in the caller's transaction (the person's row locked). Money: the owner's only. */
async function setPayTermTx(db: Db, person: PersonRow, body: AdminPersonPayTermBody, audit: AuditContext): Promise<PersonRow> {
  if (person.kind !== "human") throw new BadRequestError(`Only a human has pay terms, not a${person.kind === "agent" ? "n" : ""} ${person.kind}`);
  const models = await listPeopleCatalogModels(db);
  const model = models.find((one) => one.slug === body.modelSlug)
    ?? models.find((one) => one.slug.toLowerCase() === body.modelSlug.toLowerCase());
  if (!model) throw new NotFoundError(`No model «${body.modelSlug}»`);
  const fix = millsFromInteger(body.fixPerShiftMills);
  const note = body.note === undefined || body.note === null || body.note.trim() === "" ? null : body.note.trim();
  const written = await upsertPersonPayTerm(db, {
    personId: person.id,
    modelId: model.id,
    validFrom: body.validFrom,
    shareBasisPoints: body.shareBasisPoints,
    fixPerShiftMills: fix,
    note,
    byUserId: audit.actorUserId ?? null,
  });
  const updated = await updatePersonRow(db, person.id, {});
  await recordAudit({ db }, {
    ...audit,
    eventType: "person.pay_term_set",
    metadata: {
      code: person.code,
      model: model.slug,
      validFrom: body.validFrom,
      before: written.before === null
        ? null
        : { shareBasisPoints: written.before.shareBasisPoints, fixPerShiftMills: written.before.fixPerShiftMills.toString() },
      after: { shareBasisPoints: body.shareBasisPoints, fixPerShiftMills: fix.toString() },
    },
  });
  return updated;
}

/** Sets the pay terms of a person on a model from a day; the same day again corrects them. Money: the owner's only. */
export async function setPersonPayTerm(app: Pick<AppContext, "db">, code: string, body: AdminPersonPayTermBody, audit: AuditContext, now = new Date()) {
  return withAuditTransaction(app, async (db) => {
    const person = await requirePerson(db, code, { lock: true });
    return personDetail(db, await setPayTermTx(db, person, body, audit), now);
  });
}

// ── agents' proposals ────────────────────────────────────────────────────────

function changeOfBody(body: AgentPersonProposalBody): PersonProposalChange {
  return body.kind === "update"
    ? { kind: "update", personCode: body.personCode, change: body.change }
    : { kind: "create", person: body.person };
}

/** Records an agent's proposal after checking it against the registry now; nothing about the person changes. */
export async function createAgentPersonProposal(app: Pick<AppContext, "db">, input: { agentKeyId: number; body: AgentPersonProposalBody }) {
  const { body } = input;
  const change = changeOfBody(body);
  return withAuditTransaction(app, async (db) => {
    let personId: number | null = null;
    let proposedCode: string | null = null;
    if (change.kind === "update") {
      const person = await requirePerson(db, change.personCode);
      await resolveChange(db, subjectOf(person), change.change);
      personId = person.id;
    } else {
      const { code, kind: givenKind, ...fields } = change.person;
      if (await findPersonRowByCode(db, code)) throw new ConflictError("Another person has this code", { reason: "code_taken" });
      await resolveChange(db, { id: null, kind: givenKind ?? "human", role: fields.role, state: fields.state ?? "invited", leftOn: null }, fields);
      proposedCode = code;
    }
    const row = await insertPersonProposal(db, {
      personId,
      proposedCode,
      change: change as unknown as Record<string, unknown>,
      reason: body.reason.trim(),
      requestedBy: body.requestedBy?.trim() ?? null,
      sourceRef: body.sourceRef?.trim() ?? null,
      agentKeyId: input.agentKeyId,
    });
    await recordAudit({ db }, {
      source: "agent_key",
      actorUserId: null,
      actorAgentKeyId: input.agentKeyId,
      eventType: "person.proposal_created",
      metadata: { proposalId: row.id, kind: change.kind, code: row.personCode },
    });
    return row;
  });
}

export function agentProposalView(row: PersonProposalRow) {
  const { agentKeyName: _name, ...rest } = proposalView(row);
  return rest;
}

export async function listAgentPersonProposals(app: Pick<AppContext, "db">, input: { agentKeyId: number; since?: Date }) {
  const rows = await listPersonProposalRows(app.db, { agentKeyId: input.agentKeyId, ...(input.since ? { since: input.since } : {}) });
  return rows.map(agentProposalView);
}

export async function listPeopleProposalsForOwner(app: Pick<AppContext, "db">, query: { state?: PersonProposal["state"] }) {
  const rows = await listPersonProposalRows(app.db, { state: query.state ?? "open" });
  return { proposals: rows.map(proposalView) };
}

/** Accepts (applies through the owner's own edit) or rejects an open proposal. */
export async function decidePersonProposal(
  app: AppContext,
  proposalId: number,
  body: { decision: "accept" | "reject"; note?: string | undefined },
  audit: AuditContext,
  now = new Date(),
) {
  return withAuditTransaction(app, async (db) => {
    const proposal = await findPersonProposal(db, proposalId, { lock: true });
    if (!proposal) throw new NotFoundError(`No proposal ${proposalId}`);
    if (proposal.state !== "open") throw new ConflictError(`The proposal is ${proposal.state} already`, { reason: "proposal_decided" });
    const note = body.note?.trim() || null;
    // Checked when it was proposed; read again through the contract, so a stored change never bypasses it.
    const change: PersonProposalChange = personProposalChangeSchema.parse(proposal.change);
    let person: PersonRow | null = proposal.personId === null ? null : await findPersonRowById(db, proposal.personId);
    let createdId: number | undefined;
    if (body.decision === "accept") {
      if (change.kind === "update") {
        if (!person) throw new NotFoundError("The person of the proposal is gone");
        person = await updatePersonTx(db, person.code, change.change, audit);
      } else {
        const created = await createPersonTx(app, db, change.person, audit, "proposal");
        person = created.row;
        createdId = created.row.id;
      }
    }
    await decideProposalRow(db, {
      id: proposal.id,
      state: body.decision === "accept" ? "accepted" : "rejected",
      decidedByUserId: audit.actorUserId ?? null,
      note,
      ...(createdId === undefined ? {} : { personId: createdId }),
    });
    await recordAudit({ db }, {
      ...audit,
      eventType: "person.proposal_decided",
      metadata: { proposalId: proposal.id, decision: body.decision, code: person?.code ?? proposal.personCode },
    });
    const decided = (await findPersonProposal(db, proposal.id))!;
    const parts = person ? await loadParts(db, [person.id]) : null;
    return { proposal: proposalView(decided), person: person && parts ? personView(person, parts, now) : null };
  });
}

// ── the agent feed ───────────────────────────────────────────────────────────

/** The registry's feed for an agent key: no money unless `includeTerms` (read:pay_terms). */
export async function readAgentPeople(
  app: Pick<AppContext, "db">,
  input: { since?: Date; grantedPageIds: readonly number[]; keyGrantExcludedPages: number; includeTerms: boolean },
  now = new Date(),
): Promise<AgentPeopleResponse> {
  const db = app.db;
  const rows = input.since ? await listPersonRowsChangedSince(db, input.since) : await listPersonRows(db);
  const personIds = rows.map((row) => row.id);
  const parts = await loadParts(db, personIds);
  const terms = input.includeTerms ? termViewsByPerson(await listPersonPayTermRows(db, personIds)) : null;
  const granted = new Set(input.grantedPageIds);
  const today = toBusinessDate(now);
  const people: AgentPerson[] = rows.map((row) => {
    const logins = parts.logins.get(row.id) ?? [];
    const keys = parts.keys.get(row.id) ?? [];
    const slots = (parts.slots.get(row.id) ?? []).filter((slot) => slot.pageId === null || granted.has(slot.pageId));
    const current = slotsNow(slots, today).general;
    const stamps = [row.updatedAt.getTime(), ...logins.map((login) => login.updatedAt.getTime()),
      ...keys.map((key) => key.revokedAt?.getTime() ?? 0)];
    const person: AgentPerson = {
      id: row.id,
      code: row.code,
      displayName: row.displayName,
      kind: row.kind,
      role: row.role,
      state: row.state,
      leftOn: row.leftOn,
      telegram: { userId: row.telegramUserId, handle: row.telegramHandle, reportTag: row.reportTag },
      logins: logins.map((login) => ({ userId: login.userId, username: login.username, active: login.disabledAt === null && login.deletedAt === null })),
      agentKeys: keys.map((key) => ({ name: key.name, active: keyState(key, now) === "active" })),
      workingPages: (parts.pages.get(row.id) ?? [])
        .filter((page) => granted.has(page.pageId))
        .map((page) => ({ pageLabel: page.label, modelSlug: page.modelSlug })),
      schedule: current ? slotView(current) : null,
      scheduleSlots: slots.map(slotView),
      rights: (parts.rights.get(row.id) ?? []).map((right) => right.right),
      updatedAt: new Date(Math.max(...stamps)).toISOString(),
    };
    if (terms) person.payTerms = terms.get(row.id) ?? [];
    return person;
  });
  return {
    people,
    payTermsIncluded: input.includeTerms,
    keyGrantExcludedPages: input.keyGrantExcludedPages,
    serverNow: now.toISOString(),
  };
}

function termViewsByPerson(rows: readonly PersonPayTermRow[]): Map<number, PersonPayTerm[]> {
  const map = new Map<number, PersonPayTerm[]>();
  for (const [personId, list] of groupBy(rows)) map.set(personId, termViews(list));
  return map;
}

// ── for the one-off import ───────────────────────────────────────────────────

export { createPersonTx as createPersonInTransaction, setPayTermTx as setPayTermInTransaction, updatePersonTx as updatePersonInTransaction };
