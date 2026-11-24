/**
 * The owner's agent door (payouts plan 2026-11-24, §1.8, H9): what the owner's own agent does AS the owner, on the
 * owner's word, with a reason on every call. One route, `POST /api/v1/owner-agent/call` (`ownerAgentCall`), takes
 * `{ op, args }` and the reason in the `x-hub-owner-reason` header (1 to 500 characters after trimming, UTF-8 sent
 * percent-encoded as `encodeURIComponent` writes it; never a fan's name). Only an `act:owner` key reaches it, and such a
 * key reaches nothing else.
 *
 * THIS TABLE (`OWNER_AGENT_OPERATION_SCHEMAS`) is every operation the door has: each one's arguments (strict — a field
 * it does not name is a 400) and its answer. What each runs, and the operations the door never has, are the server's
 * (apps/runtime/src/services/owner-agent-door.ts, `OWNER_AGENT_OPERATIONS` and `OWNER_AGENT_NEVER`); a test holds the
 * two tables to the same names. Reads are projections of what is stored; a write goes through the owner's own service.
 */
import { z } from "zod";

import { agentReportSlugSchema } from "./agent-reports.ts";
import {
  customFindingActionBodySchema,
  customFindingActionResponseSchema,
  customFindingsListResponseSchema,
  customOrderActionBodySchema,
  customOrderCardSchema,
  customOrderCodeSchema,
  customOrderDetailResponseSchema,
  customOrdersBoardQuerySchema,
  customOrdersBoardResponseSchema,
  type CustomFindingActionBody,
  type CustomOrderAction,
  type CustomOrderActionBody,
  type CustomOrderCard,
} from "./custom-orders.ts";
import {
  agentMatterCommentResponseSchema,
  agentMatterStateSchema,
  MATTER_CLOSED_HOWS,
  matterKeySchema,
  mattersListQuerySchema,
  mattersListResponseSchema,
} from "./matters.ts";
import {
  personLoginSchema,
  personOnboardingStepSchema,
  personRightSchema,
  personScheduleInputSchema,
  personScheduleSlotSchema,
  personTelegramSchema,
  personWorkingPageSchema,
  personCodeSchema,
  personKindEnum,
  personRoleEnum,
  personStateEnum,
} from "./people.ts";
import { personStartSchema } from "./person-start.ts";
import { businessDate, errorResponseSchema, intId, isoDateTime, isoTimestamp, mills } from "./primitives.ts";
import { learnPageApproveResponseSchema, learnPageResponseSchema, learnPagesResponseSchema } from "./routes-learn.ts";
import {
  POT_INTAKE_REASONS,
  POT_PARTICIPANTS_MODES,
  potCodeSchema,
  potDetailResponseSchema,
  potDistributionPartInputSchema,
  potDistributionPostResponseSchema,
  potDistributionPreviewResponseSchema,
  potDistributionReverseResponseSchema,
  potFormulaSchema,
  potMutateResponseSchema,
  potParticipantPeriodSchema,
  potsListResponseSchema,
} from "./routes-pots.ts";
import { saleDecisionLinkResponseSchema, saleDecisionsUnlinkedResponseSchema } from "./routes-sale-claims.ts";
import { agentSaleDecisionSchema, agentSaleQuestionSchema } from "./routes-sale-decisions.ts";
import {
  shiftReportBodySchema,
  shiftReportShiftSchema,
  shiftReportsListItemSchema,
  shiftReportVersionSummarySchema,
} from "./routes-shift-handins.ts";
import { teamQuestionWriteResponseSchema, teamSwapsResponseSchema } from "./routes-team-questions.ts";
import { shiftReportPhaseEnum } from "./shift-report-board.ts";

/** The header the owner's reason travels in. */
export const OWNER_AGENT_REASON_HEADER = "x-hub-owner-reason";
/** The reason's length after trimming, in characters. */
export const OWNER_AGENT_REASON_MAX = 500;

const id = intId.max(Number.MAX_SAFE_INTEGER);
const note = z.string().trim().min(1).max(2000);

// ── Отчёты смен: what is stored, nothing computed anew ───────────────────────

const shiftReportListArgs = z.object({
  /** The person whose shifts (the people registry's code): every login of theirs. */
  person: personCodeSchema,
  /** Moscow days of the shifts' start, both included, at most 62 days. */
  from: businessDate,
  to: businessDate,
}).strict();

const storedShiftItemSchema = shiftReportsListItemSchema.omit({ draftTotalMills: true, postCopied: true }).extend({
  /** The board's phase as stored; null — no hand-in yet, or no board. */
  phase: shiftReportPhaseEnum.nullable(),
});

const shiftReportListResult = z.object({
  person: z.object({ code: z.string(), displayName: z.string() }),
  shifts: z.array(storedShiftItemSchema),
});

const shiftReportShowArgs = z.object({
  shiftId: id,
  /** A version by its number; absent — the newest (the report). */
  version: z.number().int().positive().max(1_000_000).optional(),
}).strict();

const shiftReportShowResult = z.object({
  shift: shiftReportShiftSchema,
  state: z.enum(["open", "submitted"]),
  phase: shiftReportPhaseEnum.nullable(),
  /** The version shown, whole; null — nothing handed in yet (a draft is never computed here). */
  view: shiftReportBodySchema.nullable(),
  latest: shiftReportVersionSummarySchema.nullable(),
});

const shiftReportVersionsArgs = z.object({ shiftId: id }).strict();

const shiftReportVersionsResult = z.object({
  shiftId: intId,
  state: z.enum(["open", "submitted"]),
  /** Newest first. */
  versions: z.array(shiftReportVersionSummarySchema),
});

// ── Продажа ──────────────────────────────────────────────────────────────────

const saleShowArgs = z.object({ transactionId: id }).strict();

const saleClaimItemSchema = z.object({
  id: intId,
  kind: z.enum(["claim", "double", "imported", "question"]),
  /** owner — waits for the owner; asked — for the other side; agreed; decided; withdrawn. */
  state: z.string(),
  /** Whose word it is, by the people registry's code (or the login's name). */
  claimant: z.string().nullable(),
  side: z.string().nullable(),
  statement: z.enum(["mine", "share"]).nullable(),
  question: z.string().nullable(),
  claimedAt: isoTimestamp,
  decisionId: intId.nullable(),
  closedAt: isoTimestamp.nullable(),
});

const saleShowResult = z.object({
  sale: z.object({
    transactionId: intId,
    pageLabel: z.string(),
    platform: z.string(),
    kind: z.string(),
    occurredAt: isoTimestamp,
    netMills: mills,
    fan: z.object({ fanRef: z.string().nullable(), name: z.string().nullable(), username: z.string().nullable() }),
    /** Whose it is by the rule as `sale_homes` keeps it; null — not computed yet. */
    home: z.object({
      home: z.string(),
      reason: z.string(),
      pot: z.string().nullable(),
      shares: z.array(z.object({ person: z.string().nullable(), mills })),
    }).nullable(),
  }),
  /** Every decision about the sale, oldest first. */
  decisions: z.array(agentSaleDecisionSchema),
  /** Every claim and question about the sale, oldest first. */
  claims: z.array(saleClaimItemSchema),
  /** An open dispute (a claim or a question waiting for a decision): decide it in Workboard, not here. */
  openDispute: z.boolean(),
});

const saleShare = z.object({ person: personCodeSchema, percent: z.number().int().min(1).max(100) }).strict();

const saleDecideArgs = z.object({
  transactionId: id,
  /** owner — the whole sale to one person (one share of 100); split — two or more shares making 100; exclude — nobody's. */
  kind: z.enum(["owner", "split", "exclude"]),
  shares: z.array(saleShare).max(10).default([]),
  /** Why, in the owner's words. */
  note,
  /** The sale's active decision, when it has one: it must be named to be replaced. */
  supersedes: id.optional(),
}).strict();

const saleWriteResult = z.object({
  decision: agentSaleDecisionSchema,
  /** The handed-in reports that got a new version with it. */
  versions: z.array(z.object({ shiftId: intId, version: z.number().int().positive() })),
});

const saleCancelArgs = z.object({ decisionId: id, note }).strict();

const saleCloseArgs = z.object({ questionId: id, note }).strict();

const saleCloseResult = z.object({ question: agentSaleQuestionSchema });

// ── Человек ──────────────────────────────────────────────────────────────────

/**
 * A person as the door reads them: who they are, their logins' names and states, pages, schedule, rights (to read),
 * onboarding and the owner's note. NEVER their pay terms, where they are paid, their agent keys or their proposals —
 * a field added to a person later is not here until it is named.
 */
export const ownerAgentPersonSchema = z.object({
  code: z.string(),
  displayName: z.string(),
  kind: personKindEnum,
  role: personRoleEnum,
  state: personStateEnum,
  leftOn: businessDate.nullable(),
  telegram: personTelegramSchema,
  logins: z.array(personLoginSchema),
  workingPages: z.array(personWorkingPageSchema),
  schedule: personScheduleSlotSchema.nullable(),
  pageSchedules: z.array(personScheduleSlotSchema),
  scheduleSlots: z.array(personScheduleSlotSchema),
  rights: z.array(personRightSchema),
  onboarding: z.array(personOnboardingStepSchema),
  note: z.string().nullable(),
  start: personStartSchema.nullable(),
  updatedAt: isoTimestamp,
});

const peopleShowArgs = z.object({ code: personCodeSchema }).strict();

const peopleResult = z.object({ person: ownerAgentPersonSchema });

/**
 * What the door may change of a person: these fields and nothing else (a field not named — a right, a login, a key, the
 * role, Telegram, pay terms — is a 400). People only, never an agent; the working pages of a person who has a content
 * manager's login are the owner's own (409): they open ContentOps' pages.
 */
const peopleEditArgs = z.object({
  code: personCodeSchema,
  displayName: z.string().trim().min(1).max(200).optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  onboarding: z.array(z.object({
    step: z.string().trim().min(1).max(200),
    doneAt: isoDateTime({ offset: true }).nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  }).strict()).max(50).optional(),
  schedule: personScheduleInputSchema.strict().optional(),
  workingPageLabels: z.array(z.string().min(1)).max(20).optional(),
  state: personStateEnum.optional(),
  leftOn: businessDate.nullable().optional(),
}).strict().refine((body) => Object.entries(body).some(([key, value]) => key !== "code" && value !== undefined), "nothing to change");

// ── Кастомы: the board's own steps, none of money ───────────────────────────

/**
 * The board's steps the door takes, as the owner on the board takes them — and no other: never `payment` or `unpay` (a
 * sale on or off an order), `paid_word` (the owner's word on the payment), `cancel` (a cancelled order gives its sales
 * back), nor the agreed total (`priceMills`) or the card's «Оплата» (`price`) in an edit.
 */
export const OWNER_AGENT_CUSTOM_STEPS = [
  "edit", "deadline", "fan", "card", "checked", "at_model", "partly", "shot", "revision", "refused", "given", "ungive", "retract", "close",
  "hold", "unhold", "issue_clear", "fan_asked_clear", "accepted_by",
] as const satisfies readonly CustomOrderAction[];
type OwnerCustomStepAction = (typeof OWNER_AGENT_CUSTOM_STEPS)[number];

/** The card without its «Оплата» line: the price as the team writes it is the owner's own, on the board. */
type OwnerCustomCard = Omit<CustomOrderCard, "price">;
/** Only the fields that change: a value sets it, `null` empties it, an absent key stays as it is (the price too). */
export type OwnerCustomCardPatch = { [K in keyof OwnerCustomCard]?: Exclude<OwnerCustomCard[K], undefined> | null };
const ownerCustomCardPatchSchema = z.object(Object.fromEntries(
  Object.entries(customOrderCardSchema.omit({ price: true }).shape)
    .map(([key, field]) => [key, (field as z.ZodOptional<z.ZodType>).unwrap().nullable().optional()]),
)).strict().refine((patch) => Object.keys(patch).length > 0, "nothing to change") as unknown as z.ZodType<OwnerCustomCardPatch>;

/** A step of the door: an edit is the card's changed fields (never its price); any other is the board's own body. */
export type OwnerCustomStep =
  | { action: "edit"; card: OwnerCustomCardPatch }
  | Extract<CustomOrderActionBody, { action: Exclude<OwnerCustomStepAction, "edit"> }>;

const CUSTOM_STEP_SET: ReadonlySet<string> = new Set(OWNER_AGENT_CUSTOM_STEPS.filter((step) => step !== "edit"));
const ownerCustomStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("edit"), card: ownerCustomCardPatchSchema }).strict(),
  ...customOrderActionBodySchema.options.filter((option) => CUSTOM_STEP_SET.has(option.shape.action.value)),
] as unknown as [z.ZodObject, ...z.ZodObject[]]) as unknown as z.ZodType<OwnerCustomStep>;

const customShowArgs = z.object({ code: customOrderCodeSchema }).strict();

const customStepArgs = z.object({ code: customOrderCodeSchema, step: ownerCustomStepSchema }).strict();

const customStepResult = z.object({
  /** Whether the step changed the order (the same step again changes nothing). */
  changed: z.boolean(),
  /** The order after it, as the board shows it to the owner. */
  detail: customOrderDetailResponseSchema,
});

/**
 * A finding's answers the door gives: dismiss, reopen (one an agent dismissed), record or link — a finding of no sale.
 * A sale's finding (a sale, a shift report's line) recorded or linked pays the order with its sale: 409
 * `finding_pays`, nothing written — the owner does that in Workboard. Recording names no agreed total and no «Оплата».
 */
export type OwnerCustomFindingStep =
  | (Omit<Extract<CustomFindingActionBody, { action: "record" }>, "priceMills" | "card"> & { card: OwnerCustomCard })
  | Extract<CustomFindingActionBody, { action: "link" | "dismiss" | "reopen" }>;

const ownerCustomFindingStepSchema = z.discriminatedUnion("action", customFindingActionBodySchema.options.map((option) => (
  option.shape.action.value === "record"
    ? (option as z.ZodObject).omit({ priceMills: true }).extend({ card: customOrderCardSchema.omit({ price: true }) }).strict()
    : option
)) as unknown as [z.ZodObject, ...z.ZodObject[]]) as unknown as z.ZodType<OwnerCustomFindingStep>;

const customFindingArgs = z.object({ findingId: id, step: ownerCustomFindingStepSchema }).strict();

// ── Дела: read, closed by their writer, commented ────────────────────────────

const matterCloseArgs = z.object({
  key: matterKeySchema,
  how: z.enum(MATTER_CLOSED_HOWS),
  note: z.string().trim().min(1).max(500).optional(),
}).strict();

const matterCloseResult = z.object({
  matter: agentMatterStateSchema,
  /** closed — now; unchanged — it was closed already. */
  transition: z.enum(["closed", "unchanged"]),
});

const matterCommentArgs = z.object({ key: matterKeySchema, text: z.string().trim().min(1).max(2000) }).strict();

// ── «Обучение» ───────────────────────────────────────────────────────────────

const learnShowArgs = z.object({ slug: agentReportSlugSchema }).strict();

/** `approved: true` — the team reads it; false — the approval taken back (the owner alone reads it again). */
const learnApproveArgs = z.object({ slug: agentReportSlugSchema, approved: z.boolean() }).strict();

// ── Подмены ──────────────────────────────────────────────────────────────────

/** «Можно» to a swap question, with a line; a question of another kind is not this operation's (409). */
const swapApproveArgs = z.object({ questionId: id, text: z.string().trim().max(500).optional() }).strict();

const swapRevokeArgs = z.object({ questionId: id }).strict();

// ── Решения из ledger, привязанные к продаже ─────────────────────────────────

const decisionLinkArgs = z.object({ decisionId: id, transactionId: id }).strict();

// ── Общаки в Workboard (H11) ─────────────────────────────────────────────────

const potListResult = potsListResponseSchema.omit({ legacyArchive: true });
const potCodeArgs = z.object({ code: potCodeSchema }).strict();

const potCreateArgs = z.object({
  code: potCodeSchema,
  name: z.string().trim().min(1).max(160),
  modelSlug: z.string().trim().min(1).max(120),
  pageLabels: z.array(z.string().trim().min(1).max(120)).min(1).max(100),
  intakeReasons: z.array(z.enum(POT_INTAKE_REASONS)).max(2).default([]),
  opensOn: businessDate,
  closesOn: businessDate.nullable().default(null),
  participantsMode: z.enum(POT_PARTICIPANTS_MODES),
  participants: z.array(potParticipantPeriodSchema.strict()).max(200).default([]),
  formula: potFormulaSchema.strict(),
  autoPost: z.boolean().default(false),
}).strict();

const potUpdateArgs = z.object({
  code: potCodeSchema,
  name: z.string().trim().min(1).max(160).optional(),
  pageLabels: z.array(z.string().trim().min(1).max(120)).min(1).max(100).optional(),
  intakeReasons: z.array(z.enum(POT_INTAKE_REASONS)).max(2).optional(),
  opensOn: businessDate.optional(),
  closesOn: businessDate.nullable().optional(),
  participantsMode: z.enum(POT_PARTICIPANTS_MODES).optional(),
  participants: z.array(potParticipantPeriodSchema.strict()).max(200).optional(),
  formula: potFormulaSchema.strict().optional(),
  autoPost: z.boolean().optional(),
}).strict().refine((body) => Object.entries(body).some(([key, value]) => key !== "code" && value !== undefined), "nothing to change");

const potDistributionArgs = z.object({
  code: potCodeSchema,
  day: businessDate.optional(),
  formula: potFormulaSchema.strict().optional(),
  parts: z.array(potDistributionPartInputSchema.strict()).max(1000).optional(),
}).strict();

const potReverseArgs = z.object({
  distributionId: id,
  reason: z.string().trim().min(1).max(500),
}).strict();

const none = z.object({}).strict();

// ── The table ────────────────────────────────────────────────────────────────

export const OWNER_AGENT_OPERATION_SCHEMAS = {
  "shiftReport.list": { args: shiftReportListArgs, result: shiftReportListResult, writes: false },
  "shiftReport.show": { args: shiftReportShowArgs, result: shiftReportShowResult, writes: false },
  "shiftReport.versions": { args: shiftReportVersionsArgs, result: shiftReportVersionsResult, writes: false },
  "sale.show": { args: saleShowArgs, result: saleShowResult, writes: false },
  "sale.decide": { args: saleDecideArgs, result: saleWriteResult, writes: true },
  "sale.cancel": { args: saleCancelArgs, result: saleWriteResult, writes: true },
  "sale.close": { args: saleCloseArgs, result: saleCloseResult, writes: true },
  "people.show": { args: peopleShowArgs, result: peopleResult, writes: false },
  "people.edit": { args: peopleEditArgs, result: peopleResult, writes: true },
  // Part 2 (H10).
  "custom.board": { args: customOrdersBoardQuerySchema, result: customOrdersBoardResponseSchema, writes: false },
  "custom.show": { args: customShowArgs, result: customOrderDetailResponseSchema, writes: false },
  "custom.step": { args: customStepArgs, result: customStepResult, writes: true },
  "customFinding.list": { args: none, result: customFindingsListResponseSchema, writes: false },
  "customFinding.answer": { args: customFindingArgs, result: customFindingActionResponseSchema, writes: true },
  "matter.list": { args: mattersListQuerySchema, result: mattersListResponseSchema, writes: false },
  "matter.close": { args: matterCloseArgs, result: matterCloseResult, writes: true },
  "matter.comment": { args: matterCommentArgs, result: agentMatterCommentResponseSchema, writes: true },
  "learn.list": { args: none, result: learnPagesResponseSchema, writes: false },
  "learn.show": { args: learnShowArgs, result: learnPageResponseSchema, writes: false },
  "learn.approve": { args: learnApproveArgs, result: learnPageApproveResponseSchema, writes: true },
  "swap.list": { args: none, result: teamSwapsResponseSchema, writes: false },
  "swap.approve": { args: swapApproveArgs, result: teamQuestionWriteResponseSchema, writes: true },
  "swap.revoke": { args: swapRevokeArgs, result: teamQuestionWriteResponseSchema, writes: true },
  "decision.unlinked": { args: none, result: saleDecisionsUnlinkedResponseSchema, writes: false },
  "decision.link": { args: decisionLinkArgs, result: saleDecisionLinkResponseSchema, writes: true },
  // Workboard pots (H11).
  "pot.list": { args: none, result: potListResult, writes: false },
  "pot.show": { args: potCodeArgs, result: potDetailResponseSchema, writes: false },
  "pot.create": { args: potCreateArgs, result: potMutateResponseSchema, writes: true },
  "pot.update": { args: potUpdateArgs, result: potMutateResponseSchema, writes: true },
  "pot.preview": { args: potDistributionArgs, result: potDistributionPreviewResponseSchema, writes: false },
  "pot.post": { args: potDistributionArgs, result: potDistributionPostResponseSchema, writes: true },
  "pot.reverse": { args: potReverseArgs, result: potDistributionReverseResponseSchema, writes: true },
  "pot.close": { args: potCodeArgs, result: potMutateResponseSchema, writes: true },
} as const satisfies Record<string, { args: z.ZodType; result: z.ZodType; writes: boolean }>;

export type OwnerAgentOperation = keyof typeof OWNER_AGENT_OPERATION_SCHEMAS;
export const OWNER_AGENT_OPERATION_NAMES = Object.keys(OWNER_AGENT_OPERATION_SCHEMAS) as OwnerAgentOperation[];
export type OwnerAgentArgs<K extends OwnerAgentOperation> = z.input<(typeof OWNER_AGENT_OPERATION_SCHEMAS)[K]["args"]>;
export type OwnerAgentResult<K extends OwnerAgentOperation> = z.infer<(typeof OWNER_AGENT_OPERATION_SCHEMAS)[K]["result"]>;
export type OwnerAgentPerson = z.infer<typeof ownerAgentPersonSchema>;

// ── The route ────────────────────────────────────────────────────────────────

/**
 * The envelope only: `op` is any name here, so an operation off the table is the door's 403 after the reason is read
 * (never a 400 that says which names exist), and `args` is checked by the operation's own strict schema.
 */
export const ownerAgentCallBodySchema = z.object({
  op: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const ownerAgentCallResponseSchema = z.object({
  op: z.string(),
  /** The operation's answer, by its own schema in `OWNER_AGENT_OPERATION_SCHEMAS`. */
  result: z.unknown(),
  serverNow: isoTimestamp,
});

export const ownerAgentRouteSchemas = {
  ownerAgentCall: {
    auth: { kind: "ownerAgentKey" },
    tags: ["owner-agent"],
    summary: "The owner's agent door: one operation of its table, as the owner, with the owner's reason (x-hub-owner-reason)",
    description: "Only an act:owner key, issued by the server CLI (owner-agent-keys:issue), and nothing else reaches it. "
      + "The reason is required (1 to 500 characters, percent-encoded UTF-8); the call is audited before it runs.",
    body: ownerAgentCallBodySchema,
    response: {
      200: ownerAgentCallResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
      429: errorResponseSchema,
    },
  },
} as const;
