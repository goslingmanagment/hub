import { z } from "zod";

import { intId, isoTimestamp, mills } from "./primitives.ts";
import {
  clientConversationRefSchema,
  clientFanRefSchema,
  clientOnlineItemSchema,
  clientOnlineTemplateSchema,
  clientOpenToken,
  clientPageParamsSchema,
} from "./routes-client.ts";

// Fan queues (docs/plans/2026-10-29-fan-queues/spec.md). A queue is the fans
// of one page gathered on someone's word — by a rule Hub evaluates (§5) or a
// list — and handed out to the page's chatters in portions of up to 10. An
// agent (Gengar) previews, creates, changes and reads queues with
// `write:fan_queues`, always on the word of the person who asked
// (`requestedBy`); the extension lists a person's queues, takes a portion and
// reports each fan's outcome. Hub sends nothing to a fan.

const count = z.number().int().nonnegative();
const username = z.string().trim().min(1).max(64);

/** Fans one queue holds at most, and one preview or append names at most. */
export const FAN_QUEUE_MAX_ITEMS = 20_000;
/** Fans one portion holds at most. */
export const FAN_QUEUE_PORTION_MAX = 10;
/** How long a portion stays a person's without a touch. */
export const FAN_QUEUE_LEASE_MINUTES = 30;

export const FAN_QUEUE_KINDS = ["campaign", "standing"] as const;
export const FAN_QUEUE_STATUSES = ["active", "paused", "done"] as const;
export const FAN_QUEUE_DISTRIBUTIONS = ["pool", "people"] as const;
export const FAN_QUEUE_AUDIENCES = ["followers", "subscribers", "expired", "any"] as const;
export const FAN_QUEUE_ORDERS = ["spend", "seen", "followed_new", "followed_old", "fan_message", "random"] as const;
/** What a queue writes with: `auto` is «Онлайн»'s choice (Ping from 10 messages, else the guide's A, B to a fan who never wrote, Hi to a new subscriber). */
export const FAN_QUEUE_ACTIONS = ["auto", "hi", "ping", "reply", "template", "own"] as const;
/** `one`: a click per message; `batch`: «Отправить всем» over a portion, template queues only. */
export const FAN_QUEUE_SEND_MODES = ["one", "batch"] as const;
/** What a sent message was written with. */
export const FAN_QUEUE_SENT_ACTS = ["reply", "hi", "ping", "template", "own"] as const;
/** «Не подходит», «Позже» (back in 3 days), «Уже общаемся», «Не предлагать» (the team's mark, as in «Онлайн»). */
export const FAN_QUEUE_SKIP_REASONS = ["not_fit", "later", "talking", "dismiss"] as const;
/** Why an item left its queue without a send. Open on the wire. */
export const FAN_QUEUE_DROP_REASONS = [
  "unreachable", "dismissed", "fan_wrote", "messaged", "bought", "no_longer_fits", "queue_done", "not_fit", "talking", "removed",
] as const;
/** Why a take handed out nothing more. Open on the wire. */
export const FAN_QUEUE_STOPS = ["paused", "done", "portion_done", "limit_reached", "empty"] as const;

export type FanQueueKind = (typeof FAN_QUEUE_KINDS)[number];
export type FanQueueStatus = (typeof FAN_QUEUE_STATUSES)[number];
export type FanQueueDistribution = (typeof FAN_QUEUE_DISTRIBUTIONS)[number];
export type FanQueueAction = (typeof FAN_QUEUE_ACTIONS)[number];
export type FanQueueSkipReason = (typeof FAN_QUEUE_SKIP_REASONS)[number];
export type FanQueueDropReason = (typeof FAN_QUEUE_DROP_REASONS)[number];
export type FanQueueStop = (typeof FAN_QUEUE_STOPS)[number];

// ── the rule (spec §5) ──────────────────────────────────────────────────────

const days = z.number().int().min(0).max(3650);
const someDays = z.number().int().min(1).max(3650);
/** `olderThanDays`: at least this many days ago (or never, where the field allows it); `withinDays`: at most. */
export const fanQueueDayRangeSchema = z.strictObject({
  olderThanDays: days.optional(),
  withinDays: someDays.optional(),
}).refine((value) => value.olderThanDays !== undefined || value.withinDays !== undefined, {
  message: "olderThanDays or withinDays",
});
const dollars = z.number().min(0).max(1_000_000);
/** Dollars, gross (what the fan paid). */
export const fanQueueSpendRangeSchema = z.strictObject({
  min: dollars.optional(),
  max: dollars.optional(),
}).refine((value) => value.min !== undefined || value.max !== undefined, { message: "min or max" });
const marker = z.string().trim().min(1).max(40);

/** Every field optional; the fields AND together. Hub always leaves out a fan it cannot reach, one marked «Не предлагать», one already in an open queue of the page, and (unless `markers.exclude` says otherwise) the marks 💩 and «бомж». */
export const fanQueueRuleSchema = z.strictObject({
  /** `followers`: Fansly followers; `subscribers`: a current subscription; `expired`: had one, none now; `any`: every fan of the page. */
  audience: z.enum(FAN_QUEUE_AUDIENCES).optional(),
  /** The fan wrote in any chat of the page: never, or at least once. */
  fanWrote: z.enum(["never", "ever"]).optional(),
  fanLastMessage: fanQueueDayRangeSchema.optional(),
  /** The page's last personal message (no mass message): never, or its age. */
  pagePersonal: z.union([z.literal("never"), fanQueueDayRangeSchema]).optional(),
  lifetimeSpend: fanQueueSpendRangeSchema.optional(),
  spend30d: fanQueueSpendRangeSchema.optional(),
  /** The last purchase; `olderThanDays` also takes a fan who never bought. */
  lastPurchase: fanQueueDayRangeSchema.optional(),
  followed: fanQueueDayRangeSchema.optional(),
  subscribed: fanQueueDayRangeSchema.optional(),
  subscriptionEnds: z.strictObject({ withinDays: z.number().int().min(0).max(365) }).optional(),
  autoRenew: z.boolean().optional(),
  /** The platform saw the fan within / not within this many days (`page_fans.external_presence_at`). */
  seen: z.union([
    z.strictObject({ withinDays: someDays }),
    z.strictObject({ notWithinDays: someDays }),
  ]).optional(),
  /** What the fan paid the model's other pages of the same platform. */
  otherPagesSpend: fanQueueSpendRangeSchema.optional(),
  /** Text in the page's name for the fan or its active notes, case-insensitive. */
  markers: z.strictObject({
    include: z.array(marker).min(1).max(20).optional(),
    exclude: z.array(marker).max(20).optional(),
  }).optional(),
  order: z.enum(FAN_QUEUE_ORDERS).optional(),
  limit: z.number().int().min(1).max(FAN_QUEUE_MAX_ITEMS).optional(),
});
export type FanQueueRule = z.infer<typeof fanQueueRuleSchema>;

/** A list instead of a rule: a platform id or a username, and why the fan is in the queue. */
export const fanQueueFansSchema = z.array(z.strictObject({
  ref: z.string().trim().min(1).max(120),
  why: z.string().trim().min(1).max(300).optional(),
})).min(1).max(FAN_QUEUE_MAX_ITEMS);

// ── the scenario (spec §6) ──────────────────────────────────────────────────

export const fanQueueScenarioSchema = z.strictObject({
  action: z.enum(FAN_QUEUE_ACTIONS),
  sendMode: z.enum(FAN_QUEUE_SEND_MODES).default("one"),
  /** With `template`: the team guide's texts, A (talked before) or B (never wrote). */
  templates: z.enum(["a", "b"]).optional(),
  /** With `template`: the asker's own texts instead; «love» or `{name}` takes the fan's name. */
  texts: z.array(z.string().trim().min(1).max(1000)).min(1).max(20).optional(),
  /** A hint for the AI's Hi and Ping (kept now, read by them in the next step). */
  hint: z.string().trim().min(1).max(600).optional(),
}).superRefine((value, ctx) => {
  if (value.sendMode === "batch" && value.action !== "template") {
    ctx.addIssue({ code: "custom", path: ["sendMode"], message: "batch sends templates only" });
  }
  if (value.action === "template" && value.templates === undefined && value.texts === undefined) {
    ctx.addIssue({ code: "custom", path: ["templates"], message: "template needs templates or texts" });
  }
  if (value.action !== "template" && (value.templates !== undefined || value.texts !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["action"], message: "templates and texts go with action template" });
  }
});
export type FanQueueScenario = z.infer<typeof fanQueueScenarioSchema>;

/** The scenario as Hub answers it: open tokens. */
export const fanQueueScenarioWireSchema = z.object({
  action: clientOpenToken,
  sendMode: clientOpenToken,
  templates: clientOpenToken.nullable(),
  texts: z.array(z.string()).nullable(),
  hint: z.string().nullable(),
});

// ── agent routes ────────────────────────────────────────────────────────────

export const agentFanQueuePageParamsSchema = z.object({ pageLabel: z.string().min(1).max(120) });
export const agentFanQueueParamsSchema = z.object({ queueId: z.coerce.number().int().positive() });

const ruleOrFans = <T extends { rule?: unknown; fans?: unknown }>(value: T, ctx: z.RefinementCtx) => {
  if ((value.rule === undefined) === (value.fans === undefined)) {
    ctx.addIssue({ code: "custom", path: ["rule"], message: "exactly one of rule and fans" });
  }
};

export const agentFanQueuePreviewBodySchema = z.strictObject({
  rule: fanQueueRuleSchema.optional(),
  fans: fanQueueFansSchema.optional(),
  /** The planned limit of the page per day: the answer says how many days the queue lasts. */
  dailyLimit: z.number().int().min(1).max(20_000).optional(),
}).superRefine(ruleOrFans);

export const fanQueueExcludedSchema = z.object({
  /** Deleted, blocked or not reachable. */
  unreachable: count,
  /** Marked «Не предлагать» by the team. */
  dismissed: count,
  /** Already in an open queue of the page. */
  inOtherQueues: count,
  /** Left out by a mark (💩, «бомж» or the rule's own). */
  markers: count,
  /** A listed ref Hub does not know as a fan of the page. */
  notFound: count,
  /** Beyond the rule's limit. */
  overLimit: count,
});

export const agentFanQueuePreviewResponseSchema = z.object({
  pageLabel: z.string(),
  /** Hub's own words for the rule (or the list), one line each: what the asker sees before «да». */
  ruleText: z.array(z.string()),
  /** Fans the queue would hold. */
  count,
  excluded: fanQueueExcludedSchema,
  /** A few fans of the queue, each with why. */
  samples: z.array(z.object({
    fanRef: z.string(),
    username: z.string().nullable(),
    displayName: z.string().nullable(),
    why: z.string(),
  })),
  /** Of the fans, whose chat history Hub does not hold in full: «never wrote» is Hub's word for them. */
  historyIncomplete: count,
  /** Days the queue lasts at `dailyLimit`; null without it. */
  daysAtLimit: z.number().int().nullable(),
});

export const agentFanQueueCreateBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  /** What the chatter reads on the card: the queue's goal in plain words. */
  goal: z.string().trim().min(1).max(600).optional(),
  kind: z.enum(FAN_QUEUE_KINDS).default("campaign"),
  rule: fanQueueRuleSchema.optional(),
  fans: fanQueueFansSchema.optional(),
  scenario: fanQueueScenarioSchema,
  distribution: z.enum(FAN_QUEUE_DISTRIBUTIONS).default("pool"),
  /** Pool: who may work it (none: every chatter of the page). People: whom the fans are split between, in turn. */
  people: z.array(username).min(1).max(50).optional(),
  /** People: how many fans each gets, instead of in turn. */
  split: z.array(z.strictObject({ username, count: z.number().int().min(1).max(FAN_QUEUE_MAX_ITEMS) })).min(1).max(50).optional(),
  /** A person's portion per Moscow day. */
  perPerson: z.number().int().min(1).max(5000).optional(),
  /** The page's sends from the queue per Moscow day. */
  dailyLimit: z.number().int().min(1).max(20_000).optional(),
  endsAt: z.string().datetime({ offset: true }).optional(),
  /** The Hub username of the person who asked: their word is what creates the queue. */
  requestedBy: username,
  idempotencyKey: z.string().min(8).max(120),
}).superRefine((value, ctx) => {
  ruleOrFans(value, ctx);
  if (value.kind === "standing" && value.rule === undefined) {
    ctx.addIssue({ code: "custom", path: ["kind"], message: "a standing queue refills from a rule" });
  }
  if (value.distribution === "people" && value.people === undefined && value.split === undefined) {
    ctx.addIssue({ code: "custom", path: ["people"], message: "people or split for distribution people" });
  }
  if (value.split !== undefined && value.distribution !== "people") {
    ctx.addIssue({ code: "custom", path: ["split"], message: "split goes with distribution people" });
  }
});

export const agentFanQueueUpdateBodySchema = z.strictObject({
  requestedBy: username,
  status: z.enum(FAN_QUEUE_STATUSES).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  goal: z.string().trim().min(1).max(600).nullable().optional(),
  scenario: fanQueueScenarioSchema.optional(),
  perPerson: z.number().int().min(1).max(5000).nullable().optional(),
  dailyLimit: z.number().int().min(1).max(20_000).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  addPeople: z.array(username).min(1).max(50).optional(),
  removePeople: z.array(username).min(1).max(50).optional(),
  /** People: hand a person's untouched fans to another person (`to`), or to the pool (`to: null`). */
  move: z.strictObject({
    from: username,
    to: username.nullable(),
    count: z.number().int().min(1).max(FAN_QUEUE_MAX_ITEMS).optional(),
  }).optional(),
}).refine((value) => Object.keys(value).some((key) => key !== "requestedBy"), { message: "nothing to change" });

export const agentFanQueueAppendBodySchema = z.strictObject({
  requestedBy: username,
  rule: fanQueueRuleSchema.optional(),
  fans: fanQueueFansSchema.optional(),
}).superRefine(ruleOrFans);

export const agentFanQueueListQuerySchema = z.strictObject({
  pageLabel: z.string().min(1).max(120).optional(),
  /** `open` (default): active and paused. */
  status: z.enum(["open", "active", "paused", "done", "all"]).default("open"),
});

export const agentFanQueueGetQuerySchema = z.strictObject({
  /** The results' window over the sends; by default since the queue began. */
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

export const agentFanQueueSchema = z.object({
  queueId: intId,
  pageLabel: z.string(),
  name: z.string(),
  goal: z.string().nullable(),
  kind: clientOpenToken,
  status: clientOpenToken,
  rule: z.record(z.string(), z.unknown()).nullable(),
  ruleText: z.array(z.string()).nullable(),
  scenario: fanQueueScenarioWireSchema,
  distribution: clientOpenToken,
  people: z.array(z.string()),
  perPerson: z.number().int().nullable(),
  dailyLimit: z.number().int().nullable(),
  endsAt: isoTimestamp.nullable(),
  requestedBy: z.string(),
  createdAt: isoTimestamp,
  pausedAt: isoTimestamp.nullable(),
  pausedBy: z.string().nullable(),
  finishedAt: isoTimestamp.nullable(),
  counts: z.object({ pending: count, leased: count, sent: count, skipped: count, dropped: count }),
  /** Today (a Moscow day): the page's sends, and each person's. */
  today: z.object({
    sent: count,
    byPerson: z.array(z.object({ username: z.string(), sent: count, skipped: count })),
  }),
  /** Days the pending fans last at the page's daily limit; null without a limit. */
  daysLeft: z.number().int().nullable(),
});

const resultCounts = {
  sent: count,
  /** Sends 72 hours old or more, and of them the fans who answered within 72 hours. */
  matured72h: count,
  replied72h: count,
  /** Sends 7 days old or more, and of them the fans who bought within 7 days. */
  matured7d: count,
  bought7d: count,
  /** Sends 30 days old or more, and what those fans paid within 30 days. */
  matured30d: count,
  spent30dMills: mills,
};

export const agentFanQueueResultsSchema = z.object({
  from: isoTimestamp,
  to: isoTimestamp,
  ...resultCounts,
  byPerson: z.array(z.object({ username: z.string(), ...resultCounts })),
  /** Skips and drops by reason, over the queue's life. */
  skipped: z.record(z.string(), count),
  dropped: z.record(z.string(), count),
});

export const agentFanQueueDetailSchema = agentFanQueueSchema.extend({
  results: agentFanQueueResultsSchema,
});

export const agentFanQueueListResponseSchema = z.object({ queues: z.array(agentFanQueueSchema) });

export const agentFanQueueAppendResponseSchema = z.object({
  added: count,
  excluded: fanQueueExcludedSchema,
  queue: agentFanQueueSchema,
});

// ── client routes (the extension's «Очереди») ───────────────────────────────

export const clientFanQueueParamsSchema = clientPageParamsSchema.extend({ queueId: z.coerce.number().int().positive() });
export const clientFanQueueItemParamsSchema = clientPageParamsSchema.extend({ itemId: z.coerce.number().int().positive() });

const today = z.object({ mine: count, page: count });

export const clientFanQueueSummarySchema = z.object({
  queueId: intId,
  name: z.string(),
  goal: z.string().nullable(),
  kind: clientOpenToken,
  status: clientOpenToken,
  distribution: clientOpenToken,
  /** People: the caller is its only person (a queue they asked for themselves). */
  mineOnly: z.boolean(),
  scenario: fanQueueScenarioWireSchema,
  /** Hub's own words for who is in it, one line each. */
  ruleText: z.array(z.string()).nullable(),
  requestedBy: z.string(),
  pausedAt: isoTimestamp.nullable(),
  pausedBy: z.string().nullable(),
  perPerson: z.number().int().nullable(),
  dailyLimit: z.number().int().nullable(),
  /** Sent today (a Moscow day): by the caller, by the page. */
  today,
  /** Fans the caller can still be handed: the pool's (or their own share's) pending. */
  pending: count,
  /** Fans in the caller's portion now. */
  leasedToMe: count,
});

/** A fan the caller wrote to from a queue within 72 hours who answered after: on top, with a Reply draft. */
export const clientFanQueueAnsweredSchema = z.object({
  itemId: intId,
  queueId: intId,
  fanRef: clientFanRefSchema,
  conversationRef: clientConversationRefSchema.nullable(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  alias: z.string().nullable(),
  sentAt: isoTimestamp,
  act: clientOpenToken.nullable(),
  templateId: z.string().nullable(),
  answeredAt: isoTimestamp,
  /** The fan's answer, as the archive holds it. */
  answerText: z.string().nullable(),
});

export const clientFanQueuesResponseSchema = z.object({
  pageLabel: z.string(),
  /** Active and paused queues the caller may work, in the order they were made. */
  queues: z.array(clientFanQueueSummarySchema),
  answered: z.array(clientFanQueueAnsweredSchema),
  /** The team guide's texts (group `a`, `b`) and each template queue's own (group `q<queueId>`). */
  templates: z.array(clientOnlineTemplateSchema),
  serverNow: isoTimestamp,
});

export const clientFanQueueTakeBodySchema = z.strictObject({
  count: z.number().int().min(1).max(FAN_QUEUE_PORTION_MAX).default(FAN_QUEUE_PORTION_MAX),
  /** «Ещё 10»: past the caller's portion for the day, while the page's limit allows. */
  more: z.boolean().default(false),
});

export const clientFanQueueItemSchema = clientOnlineItemSchema.extend({
  itemId: intId,
  queueId: intId,
  /** Why the fan is in the queue, as the asker or Hub put it. */
  why: z.string().nullable(),
  leaseUntil: isoTimestamp,
  /** With a template: the text Hub picked for this fan (neighbours get different ones). */
  templateId: z.string().nullable(),
  followedAt: isoTimestamp.nullable(),
  /** Mass messages the fan got from the page in 90 days, and the last one. */
  massLast90d: z.object({ count, lastAt: isoTimestamp.nullable() }),
});

export const clientFanQueueTakeResponseSchema = z.object({
  queueId: intId,
  /** The caller's portion: items kept from before first, then the new ones, in queue order. */
  items: z.array(clientFanQueueItemSchema),
  /** Why nothing more was handed out; open token: FAN_QUEUE_STOPS. */
  stopped: clientOpenToken.nullable(),
  today,
  pending: count,
  /** Fans this take dropped on the re-check (wrote, bought, someone wrote to them, unreachable, «Не предлагать»). */
  dropped: count,
  serverNow: isoTimestamp,
});

export const clientFanQueueItemDoneBodySchema = z.strictObject({
  outcome: z.enum(["sent", "skipped"]),
  act: z.enum(FAN_QUEUE_SENT_ACTS).optional(),
  templateId: z.string().min(1).max(32).optional(),
  skipReason: z.enum(FAN_QUEUE_SKIP_REASONS).optional(),
  /** The send's outcome is not known: it counts as sent and is never sent again. */
  uncertain: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if (value.outcome === "sent" && value.act === undefined) ctx.addIssue({ code: "custom", path: ["act"], message: "a send says its act" });
  if (value.outcome === "skipped" && value.skipReason === undefined) ctx.addIssue({ code: "custom", path: ["skipReason"], message: "a skip says why" });
  if (value.outcome === "skipped" && (value.act !== undefined || value.templateId !== undefined || value.uncertain !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["outcome"], message: "a skip carries no send" });
  }
});

export const clientFanQueueItemDoneResponseSchema = z.object({
  itemId: intId,
  /** Open token: the item's state after the report. */
  state: clientOpenToken,
  today,
  serverNow: isoTimestamp,
});

export const clientFanQueueReleaseBodySchema = z.strictObject({});
export const clientFanQueueReleaseResponseSchema = z.object({ released: count });

export type FanQueueExcluded = z.infer<typeof fanQueueExcludedSchema>;
export type AgentFanQueue = z.infer<typeof agentFanQueueSchema>;
export type AgentFanQueueDetail = z.infer<typeof agentFanQueueDetailSchema>;
export type AgentFanQueueResults = z.infer<typeof agentFanQueueResultsSchema>;
export type AgentFanQueuePreviewBody = z.infer<typeof agentFanQueuePreviewBodySchema>;
export type AgentFanQueuePreviewResponse = z.infer<typeof agentFanQueuePreviewResponseSchema>;
export type AgentFanQueueCreateBody = z.infer<typeof agentFanQueueCreateBodySchema>;
export type AgentFanQueueUpdateBody = z.infer<typeof agentFanQueueUpdateBodySchema>;
export type AgentFanQueueAppendBody = z.infer<typeof agentFanQueueAppendBodySchema>;
export type AgentFanQueueAppendResponse = z.infer<typeof agentFanQueueAppendResponseSchema>;
export type AgentFanQueueListQuery = z.infer<typeof agentFanQueueListQuerySchema>;
export type AgentFanQueueListResponse = z.infer<typeof agentFanQueueListResponseSchema>;
export type AgentFanQueueGetQuery = z.infer<typeof agentFanQueueGetQuerySchema>;
export type ClientFanQueueSummary = z.infer<typeof clientFanQueueSummarySchema>;
export type ClientFanQueueAnswered = z.infer<typeof clientFanQueueAnsweredSchema>;
export type ClientFanQueuesResponse = z.infer<typeof clientFanQueuesResponseSchema>;
export type ClientFanQueueTakeBody = z.infer<typeof clientFanQueueTakeBodySchema>;
export type ClientFanQueueItem = z.infer<typeof clientFanQueueItemSchema>;
export type ClientFanQueueTakeResponse = z.infer<typeof clientFanQueueTakeResponseSchema>;
export type ClientFanQueueItemDoneBody = z.infer<typeof clientFanQueueItemDoneBodySchema>;
export type ClientFanQueueItemDoneResponse = z.infer<typeof clientFanQueueItemDoneResponseSchema>;
export type ClientFanQueueReleaseResponse = z.infer<typeof clientFanQueueReleaseResponseSchema>;
