import { userRoles } from "@agency_hub_core/shared";
import { z } from "zod";

import { businessDate, intId, isoDateTime, isoTimestamp, mills, platformEnum } from "./primitives.ts";

/**
 * The people registry (ecosystem plan 2026-11-12, package A), in shadow: one
 * record per person of the agency — a human and an agent are the same kind of
 * record, and so is the holder of service and test logins (kind `service`).
 * A login is not a person: one person holds any number of Hub logins
 * (the owner: a console login and a chatter login), an agent person holds agent keys,
 * and a model or a contractor holds none. The code is the one ledger and /OS
 * already use (the card's file name), a field of its own: nothing here ever
 * renames or changes a login (`users.username`) — scripts match chatters by it.
 *
 * Working pages are what a person works, in order (the first is the main
 * one): NOT access. Who may open a page stays the logins' page assignments.
 *
 * Pay terms are money: only the owner writes them, only the owner's session
 * reads them (`adminPerson`), and an agent key reads them only with
 * `read:pay_terms`. The team's list (`teamPeople`) has no field for them.
 *
 * An agent key never changes a person: it proposes (`agentPersonProposalCreate`,
 * needs `propose:people`) and the proposal waits for the owner, who accepts it
 * (the change goes through the same edit as the owner's own) or rejects it.
 */

/** human; agent (an agent key's holder); service — a server-side or test login with no person behind it, so that
 *  checks about people («a sign-in without a person», «a shift without a report») never raise anything on it. */
export const PERSON_KINDS = ["human", "agent", "service"] as const;
/** An agent's only role is `agent`, a service's only role is `service`, and only they have them. */
export const PERSON_ROLES = ["owner", "team_lead", "chatter", "content_manager", "contractor", "agent", "service"] as const;
/** invited → set_up (оформлен) → working → left. */
export const PERSON_STATES = ["invited", "set_up", "working", "left"] as const;
/**
 * Narrow rights beside the role. customs_lead — «ведёт кастомы»; records_customs — «записывает кастомы в
 * системе»: the person gets the custom checks' matters (an unrecorded custom, «отдайте фану»), off by default.
 */
export const PERSON_RIGHTS = ["customs_lead", "records_customs"] as const;
export const PERSON_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
/** Where a record came from: the owner's screen, the one-off import, an agent's accepted proposal. */
export const PERSON_ORIGINS = ["owner", "import", "proposal"] as const;
export const PERSON_PROPOSAL_STATES = ["open", "accepted", "rejected", "withdrawn"] as const;
/** A person's code: lowercase latin letters, digits and dashes, as ledger and the /OS card file name. */
export const PERSON_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A slot's edge by Moscow time: `HH:MM`; an end may be `24:00`. */
export const PERSON_SLOT_TIME_PATTERN = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;
/** A shift lasts an hour to sixteen hours (as /OS scripts/people_roster.py reads it). */
export const PERSON_SLOT_MIN_MINUTES = 60;
export const PERSON_SLOT_MAX_MINUTES = 16 * 60;

export const personKindEnum = z.enum(PERSON_KINDS);
export const personRoleEnum = z.enum(PERSON_ROLES);
export const personStateEnum = z.enum(PERSON_STATES);
export const personRightEnum = z.enum(PERSON_RIGHTS);
export const personWeekdayEnum = z.enum(PERSON_WEEKDAYS);
export const personOriginEnum = z.enum(PERSON_ORIGINS);
export const personProposalStateEnum = z.enum(PERSON_PROPOSAL_STATES);
const loginRoleEnum = z.enum(userRoles);

export const personCodeSchema = z.string().regex(
  PERSON_CODE_PATTERN,
  "a person's code is lowercase latin letters, digits and dashes, starting with a letter or a digit (at most 63)",
);
export const personCodeParamsSchema = z.object({ code: personCodeSchema });
const slotTime = z.string().regex(PERSON_SLOT_TIME_PATTERN, "a time is HH:MM by Moscow time (an end may be 24:00)");
const telegramHandle = z.string().trim().regex(/^@?[A-Za-z0-9_]{3,64}$/, "a Telegram handle is latin letters, digits and _");
const reportTag = z.string().trim().regex(/^#[^\s#]{1,63}$/, "a report tag is # and one word, e.g. #alex");

// ── what a person is ─────────────────────────────────────────────────────────

/**
 * A schedule slot: person × page (null — every page of the person; a page's own line overrides it on that page)
 * × start and end minute of the Moscow day (end before start — the slot crosses midnight) × valid from / to.
 * One of the inputs of the «whose sale» rule at a shift junction (owner 2026-11-12): the shift whose slot runs.
 */
export const personScheduleSlotSchema = z.object({
  id: intId,
  /** The person's registry id (`id` of the person). */
  personId: intId,
  /** The page this line is for (Hub's page id); null — every page of the person. */
  pageId: intId.nullable(),
  /** That page's label; null — every page of the person. */
  pageLabel: z.string().nullable(),
  /** Minute of the Moscow day, 0…1439. */
  startMinute: z.number().int().min(0).max(1439),
  /** Minute of the Moscow day, 0…1440 (0 is written 00:00, 1440 is 24:00); before `startMinute` — the next day. */
  endMinute: z.number().int().min(0).max(1440),
  /** `startMinute` as `HH:MM`. */
  start: z.string(),
  /** `endMinute` as `HH:MM`. */
  end: z.string(),
  /** The days it holds; null — not set. A night slot is dated by the evening it begins. */
  weekdays: z.array(personWeekdayEnum).nullable(),
  /** The first day (Moscow); null — not known. */
  validFrom: businessDate.nullable(),
  /** The last day; null — it holds on. */
  validTo: businessDate.nullable(),
});

export const personLoginSchema = z.object({
  userId: intId,
  username: z.string(),
  role: loginRoleEnum,
  /** active — signs in; invited — the invite link is not used yet; disabled; deleted. */
  state: z.enum(["active", "invited", "disabled", "deleted"]),
  /** The login's latest use: a device sign-in (the extension, the app) or a web session, whichever is later; null — never. */
  lastSeenAt: isoTimestamp.nullable(),
});

export const personAgentKeySchema = z.object({
  agentKeyId: intId,
  name: z.string(),
  state: z.enum(["active", "expired", "revoked"]),
});

export const personWorkingPageSchema = z.object({
  pageLabel: z.string(),
  platform: platformEnum,
  modelSlug: z.string(),
  modelName: z.string(),
});

export const personRightSchema = z.object({
  right: personRightEnum,
  grantedAt: isoTimestamp,
});

export const personOnboardingStepSchema = z.object({
  step: z.string(),
  doneAt: isoTimestamp.nullable(),
  note: z.string().nullable(),
});

/** One disagreement the import found between the sources about this person. */
export const personImportNoteSchema = z.object({
  /** A closed code of the kind of disagreement (`pages_differ`, `telegram_missing`, …). */
  code: z.string(),
  /** It in words, for the owner. */
  text: z.string(),
  /** When the owner marked it «Сверено» (looked into, nothing more to do); null — not yet. */
  settledAt: isoTimestamp.nullable(),
});

export const personTelegramSchema = z.object({
  userId: z.number().int().positive().nullable(),
  /** Without the @. */
  handle: z.string().nullable(),
  /** The tag of the person's shift report post, e.g. `#alex`. */
  reportTag: z.string().nullable(),
});

export const personSchema = z.object({
  id: intId,
  code: z.string(),
  displayName: z.string(),
  kind: personKindEnum,
  role: personRoleEnum,
  state: personStateEnum,
  /** The day the person left; null — still here, or the day is not known. */
  leftOn: businessDate.nullable(),
  telegram: personTelegramSchema,
  logins: z.array(personLoginSchema),
  agentKeys: z.array(personAgentKeySchema),
  workingPages: z.array(personWorkingPageSchema),
  /** The person's slot (every page) that holds today (Moscow), else the next one to begin; null — no schedule. */
  schedule: personScheduleSlotSchema.nullable(),
  /** Pages with a slot of their own holding today (or next to begin), by page. */
  pageSchedules: z.array(personScheduleSlotSchema),
  rights: z.array(personRightSchema),
  onboarding: z.array(personOnboardingStepSchema),
  note: z.string().nullable(),
  importNotes: z.array(personImportNoteSchema),
  origin: personOriginEnum,
  /** Agents' proposals about the person waiting for the owner. */
  openProposals: z.number().int().nonnegative(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});

export const personPayTermSchema = z.object({
  id: intId,
  modelSlug: z.string(),
  modelName: z.string(),
  /** The first day (Moscow) it holds. */
  validFrom: businessDate,
  /** The day before the person's next term of the same model; null — it holds now. */
  validTo: businessDate.nullable(),
  /** The share of the model's money in hundredths of a percent: 2500 is 25 %. */
  shareBasisPoints: z.number().int().min(0).max(10_000),
  /** The fixed sum per day with a shift, mills; 0 — none. */
  fixPerShiftMills: mills,
  note: z.string().nullable(),
  updatedAt: isoTimestamp,
});

// ── changes (the owner's, and the shape an agent proposes) ───────────────────

export const personScheduleInputSchema = z.object({
  /** Whose line: a page's own (its label), or the person's line for every page (null or absent). */
  pageLabel: z.string().min(1).nullable().optional(),
  /** The first day of the new arrangement (Moscow): the line's slot holding then ends the day before. Null — not
   *  known (only while the line has no slot yet). */
  from: businessDate.nullable(),
  /** The new slot; null — no slot on this line from `from`. */
  slot: z.object({
    start: slotTime,
    end: slotTime,
    weekdays: z.array(personWeekdayEnum).max(7).nullable().optional(),
  }).nullable(),
});

export const personTelegramInputSchema = z.object({
  userId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  handle: telegramHandle.nullable().optional(),
  reportTag: reportTag.nullable().optional(),
});

const idChanges = z.object({
  add: z.array(intId).max(20).optional(),
  remove: z.array(intId).max(20).optional(),
});

const personFields = {
  displayName: z.string().trim().min(1).max(200),
  role: personRoleEnum,
  state: personStateEnum,
  leftOn: businessDate.nullable(),
  telegram: personTelegramInputSchema,
  /** The whole list, in order (the first is the main one). */
  workingPageLabels: z.array(z.string().min(1)).max(20),
  schedule: personScheduleInputSchema,
  /** The whole set. */
  rights: z.array(personRightEnum).max(PERSON_RIGHTS.length),
  /** The whole list. */
  onboarding: z.array(z.object({
    step: z.string().trim().min(1).max(200),
    doneAt: isoDateTime({ offset: true }).nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })).max(50),
  note: z.string().trim().max(2000).nullable(),
  /** Hub logins to link to the person, or to take off it. */
  logins: idChanges,
  /** Agent keys to link (an agent person only), or to take off. */
  agentKeys: idChanges,
};

/** An invitation made with the person in the same call: the login (no password yet), its pages, the link. */
export const personInviteInputSchema = z.object({
  username: z.string().trim().min(1).max(100).regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "username may contain latin letters, digits, dots, underscores and dashes",
  ),
  role: z.enum(["chatter", "team_lead"]).optional(),
  /** The pages the login may open (access), which may be wider than the working pages. */
  pageLabels: z.array(z.string().min(1)).max(100),
  expiresInHours: z.number().int().min(1).max(720).optional(),
});

export const adminPersonPayTermBodySchema = z.object({
  modelSlug: z.string().min(1),
  validFrom: businessDate,
  shareBasisPoints: z.number().int().min(0).max(10_000),
  fixPerShiftMills: mills.min(0).max(Number.MAX_SAFE_INTEGER),
  note: z.string().trim().max(500).nullable().optional(),
});

export const adminPersonCreateBodySchema = z.object({
  code: personCodeSchema,
  kind: personKindEnum.optional(),
  ...personFields,
  state: personStateEnum.optional(),
  leftOn: personFields.leftOn.optional(),
  telegram: personFields.telegram.optional(),
  workingPageLabels: personFields.workingPageLabels.optional(),
  schedule: personFields.schedule.optional(),
  rights: personFields.rights.optional(),
  onboarding: personFields.onboarding.optional(),
  note: personFields.note.optional(),
  logins: personFields.logins.optional(),
  agentKeys: personFields.agentKeys.optional(),
  /** Invite a login for the person in the same transaction (a human only). */
  invite: personInviteInputSchema.optional(),
  /** Pay terms set in the same transaction (a human only; one per model). Money: the owner's only — never in a proposal. */
  payTerms: z.array(adminPersonPayTermBodySchema).max(20).optional(),
});

export const adminPersonUpdateBodySchema = z.object({
  displayName: personFields.displayName.optional(),
  role: personFields.role.optional(),
  state: personFields.state.optional(),
  leftOn: personFields.leftOn.optional(),
  telegram: personFields.telegram.optional(),
  workingPageLabels: personFields.workingPageLabels.optional(),
  schedule: personFields.schedule.optional(),
  rights: personFields.rights.optional(),
  onboarding: personFields.onboarding.optional(),
  note: personFields.note.optional(),
  logins: personFields.logins.optional(),
  agentKeys: personFields.agentKeys.optional(),
}).refine((body) => Object.values(body).some((value) => value !== undefined), "nothing to change");

/** «Сверено» on one import note of a person (or taken back): the note by its place in the list and its code. */
export const adminPersonImportNoteSettleBodySchema = z.object({
  index: z.number().int().min(0).max(1_000),
  code: z.string().min(1).max(100),
  settled: z.boolean(),
});

// ── agents' proposals ────────────────────────────────────────────────────────

const proposalWords = {
  /** Why, in the agent's words; a person's own words go in as a quote, with `sourceRef`. */
  reason: z.string().trim().min(1).max(2000),
  /** Who asked the agent: a Hub login or a person's code. */
  requestedBy: z.string().trim().min(1).max(100).optional(),
  /** Where it was said: a message link or id. */
  sourceRef: z.string().trim().min(1).max(500).optional(),
};

const proposalUpdate = z.object({ kind: z.literal("update"), personCode: personCodeSchema, change: adminPersonUpdateBodySchema });
const proposalCreate = z.object({ kind: z.literal("create"), person: adminPersonCreateBodySchema.omit({ invite: true, payTerms: true }) });

/** What a proposal changes: the owner's edit of an existing person, or a new person (never an invitation, never pay terms). */
export const personProposalChangeSchema = z.discriminatedUnion("kind", [proposalUpdate, proposalCreate]);

export const agentPersonProposalBodySchema = z.discriminatedUnion("kind", [
  proposalUpdate.extend(proposalWords),
  proposalCreate.extend(proposalWords),
]);

export const personProposalSchema = z.object({
  id: intId,
  kind: z.enum(["update", "create"]),
  /** The person it is about, or the code of the proposed new person. */
  personCode: z.string(),
  change: z.record(z.string(), z.unknown()),
  reason: z.string(),
  requestedBy: z.string().nullable(),
  sourceRef: z.string().nullable(),
  /** The agent key that proposed it. */
  agentKeyName: z.string(),
  state: personProposalStateEnum,
  createdAt: isoTimestamp,
  decidedAt: isoTimestamp.nullable(),
  decisionNote: z.string().nullable(),
});

export const adminPeopleProposalsQuerySchema = z.object({
  state: personProposalStateEnum.optional(),
});

export const adminPersonProposalParamsSchema = z.object({
  proposalId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const adminPersonProposalDecideBodySchema = z.object({
  decision: z.enum(["accept", "reject"]),
  note: z.string().trim().max(2000).optional(),
});

// ── responses ────────────────────────────────────────────────────────────────

export const teamPeopleResponseSchema = z.object({
  people: z.array(personSchema),
  /** Hub logins no person holds yet (the owner's view only; empty for a team lead). */
  unlinkedLogins: z.array(personLoginSchema),
  serverNow: isoTimestamp,
});

export const adminPersonResponseSchema = z.object({
  person: personSchema,
  /** Every slot, oldest first. */
  scheduleSlots: z.array(personScheduleSlotSchema),
  /** By model, oldest first. Money: the owner's only. */
  payTerms: z.array(personPayTermSchema),
  /** The person's proposals, newest first. */
  proposals: z.array(personProposalSchema),
  serverNow: isoTimestamp,
});

export const adminPersonCreateResponseSchema = adminPersonResponseSchema.extend({
  /** The invitation made with the person; the raw link token is returned this once. */
  invite: z.object({
    userId: intId,
    username: z.string(),
    link: z.object({ id: intId, keyPrefix: z.string(), token: z.string(), expiresAt: isoTimestamp }),
  }).nullable(),
});

export const adminPeopleProposalsResponseSchema = z.object({
  proposals: z.array(personProposalSchema),
});

export const adminPersonProposalDecideResponseSchema = z.object({
  proposal: personProposalSchema,
  /** The person after the change (accepted), or as it is (rejected); null — a rejected new person. */
  person: personSchema.nullable(),
});

export const agentPeopleQuerySchema = z.object({
  /** Only people changed at or after this instant (their record, logins, keys, pages, schedule, rights or terms).
   *  Keep the answer's greatest `updatedAt` and ask again from it minus an overlap. */
  since: isoDateTime({ offset: true }).optional(),
});

export const agentPersonSchema = z.object({
  /** The registry's id of the person (a slot's `personId`). */
  id: intId,
  code: z.string(),
  displayName: z.string(),
  kind: personKindEnum,
  role: personRoleEnum,
  state: personStateEnum,
  leftOn: businessDate.nullable(),
  telegram: personTelegramSchema,
  /** The person's Hub logins; `active` — signs in (not disabled, not deleted). */
  logins: z.array(z.object({ userId: intId, username: z.string(), active: z.boolean() })),
  agentKeys: z.array(z.object({ name: z.string(), active: z.boolean() })),
  /** In order; pages outside the key's grant are left out. */
  workingPages: z.array(z.object({ pageLabel: z.string(), modelSlug: z.string() })),
  /** The person's slot for every page that holds today (else the next one); null — none. */
  schedule: personScheduleSlotSchema.nullable(),
  /** Every slot line, oldest first: person × page (null — every page) × minutes × valid from / to. A page's own
   *  line outside the key's grant is left out. */
  scheduleSlots: z.array(personScheduleSlotSchema),
  rights: z.array(personRightEnum),
  /** The latest change of the person's record or anything that hangs off it. */
  updatedAt: isoTimestamp,
  /** Only for a key with read:pay_terms. */
  payTerms: z.array(personPayTermSchema).optional(),
});

export const agentPeopleResponseSchema = z.object({
  people: z.array(agentPersonSchema),
  /** Whether `payTerms` is in each person (the key has read:pay_terms). */
  payTermsIncluded: z.boolean(),
  /** Pages of the agency outside the key's grant: no working page there is shown. */
  keyGrantExcludedPages: z.number().int().nonnegative(),
  serverNow: isoTimestamp,
});

export const agentPersonProposalSchema = personProposalSchema.omit({ agentKeyName: true });

export const agentPersonProposalResponseSchema = z.object({ proposal: agentPersonProposalSchema });

export const agentPersonProposalsQuerySchema = z.object({
  /** Only the key's proposals created or decided at or after this instant. */
  since: isoDateTime({ offset: true }).optional(),
});

export const agentPersonProposalsResponseSchema = z.object({
  proposals: z.array(agentPersonProposalSchema),
});

export type PersonKind = z.infer<typeof personKindEnum>;
export type PersonRole = z.infer<typeof personRoleEnum>;
export type PersonState = z.infer<typeof personStateEnum>;
export type PersonRight = z.infer<typeof personRightEnum>;
export type PersonWeekday = z.infer<typeof personWeekdayEnum>;
export type Person = z.infer<typeof personSchema>;
export type PersonLogin = z.infer<typeof personLoginSchema>;
export type PersonScheduleSlot = z.infer<typeof personScheduleSlotSchema>;
export type PersonPayTerm = z.infer<typeof personPayTermSchema>;
export type PersonProposal = z.infer<typeof personProposalSchema>;
export type PersonScheduleInput = z.infer<typeof personScheduleInputSchema>;
export type AdminPersonCreateBody = z.infer<typeof adminPersonCreateBodySchema>;
export type AdminPersonUpdateBody = z.infer<typeof adminPersonUpdateBodySchema>;
export type AdminPersonPayTermBody = z.infer<typeof adminPersonPayTermBodySchema>;
export type AdminPersonImportNoteSettleBody = z.infer<typeof adminPersonImportNoteSettleBodySchema>;
export type PersonImportNote = z.infer<typeof personImportNoteSchema>;
export type PersonProposalChange = z.infer<typeof personProposalChangeSchema>;
export type AgentPersonProposalBody = z.infer<typeof agentPersonProposalBodySchema>;
export type AgentPerson = z.infer<typeof agentPersonSchema>;
export type TeamPeopleResponse = z.infer<typeof teamPeopleResponseSchema>;
export type AdminPersonResponse = z.infer<typeof adminPersonResponseSchema>;
export type AgentPeopleResponse = z.infer<typeof agentPeopleResponseSchema>;
