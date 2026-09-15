import { z } from "zod";
import type { AppConfig } from "@agency_hub_core/shared";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const instant = z.iso.datetime();

const fullProofSchema = z.object({
  startedAt: instant,
  completedAt: instant,
  anchorSlot: count,
}).refine((proof) => Date.parse(proof.startedAt) <= Date.parse(proof.completedAt));

const fullScheduleSchema = z.object({
  anchorSlot: count,
  slotOffsetSeconds: count.max(1799),
  lastCertifiedFull: fullProofSchema.nullable(),
});

export type DmFullSweepSchedule = z.infer<typeof fullScheduleSchema>;

/** Optional on full cursors. Old/disabled writers keep their exact old shape. */
export function parseDmFullSweepSchedule(value: unknown): DmFullSweepSchedule | undefined {
  const result = fullScheduleSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

const boundedSchema = z.object({
  version: z.literal(2),
  mode: z.literal("bounded"),
  completedAt: instant.nullable(),
  // Rollback high-water only. Bounded writes never stamp a membership generation.
  generation: count,
  offset: count,
  observedCount: count,
  pageCount: count,
  unchangedPageStreak: count,
  providerTotalMode: z.enum(["unobserved", "absent", "present"]),
  providerReportedTotal: count.nullable(),
  fullSweepStartedAt: instant,
  lastFullSweepCompletedAt: instant,
  polling: fullScheduleSchema,
  previousTimestampMs: count.nullable(),
  stopInvalidated: z.boolean(),
}).refine((state) => state.polling.lastCertifiedFull !== null &&
  state.lastFullSweepCompletedAt === state.polling.lastCertifiedFull.completedAt &&
  state.polling.anchorSlot === state.polling.lastCertifiedFull.anchorSlot &&
  (state.providerTotalMode === "present") === (state.providerReportedTotal !== null));

export type DmBoundedSweepState = z.infer<typeof boundedSchema> & { kind: "bounded"; diagnostics?: never };

export function parseDmBoundedSweepState(value: unknown): DmBoundedSweepState | null {
  const result = boundedSchema.safeParse(value);
  return result.success ? { ...result.data, kind: "bounded" } : null;
}

export function serializeDmBoundedSweepState(state: DmBoundedSweepState) {
  const { kind: _kind, ...document } = state;
  return document;
}

/** undefined is a legacy/non-A1 cursor; null is missing or invalid A1 proof. */
export function dmFullSweepCompletedAt(value: unknown, now: Date): string | null | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const state = value as Record<string, unknown>;
  if (state.mode !== "bounded" && state.polling === undefined) return undefined;
  if (state.mode === "bounded" && !parseDmBoundedSweepState(value)) return null;
  if (state.mode !== "bounded" && state.mode !== "full_scan" && state.mode !== undefined) return null;
  const proof = parseDmFullSweepSchedule(state.polling)?.lastCertifiedFull;
  if (!proof || proof.completedAt !== state.lastFullSweepCompletedAt ||
    Date.parse(proof.completedAt) > now.getTime()) return null;
  return proof.completedAt;
}

const policySchema = z.object({ fullIntervalMinutes: z.union([
  z.literal(30), z.literal(60), z.literal(180), z.literal(360),
]) }).strict();
export type DmBoundedPolicy = z.infer<typeof policySchema>;

/** Missing/malformed policy falls back to the existing full sweep. */
export function resolveDmBoundedPolicy(config: Pick<AppConfig,
  "fanslyDmBoundedEnabled" | "fanslyDmBoundedPageAllowlist" | "fanslyDmBoundedPolicies"
>, label: string): DmBoundedPolicy | null {
  if (config.fanslyDmBoundedEnabled !== true || !(config.fanslyDmBoundedPageAllowlist ?? "")
    .split(",").map((part) => part.trim()).filter((part) => part !== "none" && part !== "").includes(label)) return null;
  let input: unknown;
  try { input = JSON.parse(config.fanslyDmBoundedPolicies ?? "{}"); } catch { return null; }
  if (!input || typeof input !== "object" || Array.isArray(input) || !Object.hasOwn(input, label)) return null;
  const result = policySchema.safeParse((input as Record<string, unknown>)[label]);
  return result.success ? result.data : null;
}

/** Same 1800-second scheduler slots; completion never moves the full deadline. */
export function dmFullSweepDue(input: {
  policy: DmBoundedPolicy | null;
  schedule: DmFullSweepSchedule | undefined;
  currentSlot: number;
  cadenceSeconds: number;
  slotOffsetSeconds: number;
}) {
  const { policy, schedule, currentSlot } = input;
  return !policy || policy.fullIntervalMinutes === 30 || !schedule?.lastCertifiedFull ||
    input.cadenceSeconds !== 1800 || schedule.slotOffsetSeconds !== input.slotOffsetSeconds || !Number.isSafeInteger(currentSlot) || currentSlot < 0 ||
    currentSlot < schedule.anchorSlot ||
    currentSlot >= schedule.anchorSlot + policy.fullIntervalMinutes / 30;
}

/** A candidate head stop, never whole-list coverage or a stable provider snapshot. */
export function advanceDmBoundedStop(state: DmBoundedSweepState, items: readonly {
  unchanged: boolean; listMessageId: string | null; embeddedMessageId: string | null;
  timestampMs: number | null;
}[]) {
  const boundary = state.polling.lastCertifiedFull;
  let unchanged = items.length > 0 && boundary !== null;
  let previousTimestampMs = state.previousTimestampMs;
  let stopInvalidated = state.stopInvalidated;
  for (const item of items) {
    const at = item.timestampMs;
    const valid = item.listMessageId !== null && item.listMessageId === item.embeddedMessageId &&
      at !== null && Number.isSafeInteger(at) && at > 0;
    // A known order violation remains debt through this walk. Equal times do
    // not establish a boundary, including ties split over adjacent pages.
    if (!valid || (at !== null && previousTimestampMs !== null && at > previousTimestampMs)) {
      stopInvalidated = true;
    }
    unchanged &&= valid && item.unchanged && at !== previousTimestampMs && boundary !== null &&
      at! < Date.parse(boundary.startedAt) - 60_000;
    if (valid) previousTimestampMs = at;
  }
  return {
    previousTimestampMs,
    stopInvalidated,
    unchangedPageStreak: unchanged && !stopInvalidated ? state.unchangedPageStreak + 1 : 0,
  };
}
