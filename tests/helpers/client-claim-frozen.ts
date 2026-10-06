import { z } from "zod";

/**
 * The claim route's body and answer as the chat extension FROZE them (its
 * contracts, packages/contracts/src/hub/newcomers.ts: `ClaimBodySchema` and
 * `ClaimStateSchema`, with its primitives), restated in this repo's zod. The
 * hub must take every body the client's schema lets out, and answer only what
 * the client's schema reads. Shared by the contract test and the route test of
 * H-7b.
 */
const frozenUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const frozenNativeId = z.string().regex(/^[1-9]\d{0,29}$/);
const frozenCount = z.int().gte(0);
const frozenToken = z.string().min(1).max(64);
const frozenInstant = z.string().max(40)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/);
const frozenPurpose = z.enum(["greeting", "preview-reply"]);
const frozenGroup = z.strictObject({
  generationRef: frozenUuid,
  variant: z.int().gte(0).lte(2),
  partCount: z.int().gte(1).lte(10),
});
const frozenPartIndex = z.int().gte(0).lte(9);
const frozenLeaseAction = <A extends "claim" | "renew" | "release">(action: A) =>
  z.strictObject({ action: z.literal(action), leaseToken: frozenUuid, instanceId: frozenUuid });

export const frozenClaimBodySchema = z.discriminatedUnion("action", [
  frozenLeaseAction("claim"),
  frozenLeaseAction("renew"),
  frozenLeaseAction("release"),
  z.strictObject({
    action: z.literal("dispatch"),
    attemptId: frozenUuid,
    instanceId: frozenUuid,
    purpose: frozenPurpose,
    group: frozenGroup,
    partIndex: frozenPartIndex,
    textRevision: frozenCount,
    leaseToken: frozenUuid.optional(),
    flagRevision: frozenCount,
  }),
  z.strictObject({
    action: z.literal("sent"),
    attemptId: frozenUuid,
    instanceId: frozenUuid,
    platformMessageId: frozenNativeId,
    evidence: z.literal("receipt+echo"),
  }),
  z.strictObject({
    action: z.literal("failed"),
    attemptId: frozenUuid,
    instanceId: frozenUuid,
    reason: z.enum(["not_enqueued", "native_rejected"]),
    httpStatus: z.int().gte(100).lte(599).optional(),
  }),
  z.strictObject({
    action: z.literal("registerNativeSend"),
    attemptId: frozenUuid,
    instanceId: frozenUuid,
    purpose: frozenPurpose,
    group: frozenGroup,
    partIndex: frozenPartIndex,
    platformMessageId: frozenNativeId,
  }),
]).refine((body) => !("group" in body) || body.partIndex < body.group.partCount)
  .refine((body) => body.action !== "failed" || (body.reason === "native_rejected"
    ? body.httpStatus !== undefined && body.httpStatus >= 400 && body.httpStatus <= 499 && body.httpStatus !== 401
    : body.httpStatus === undefined));

export const frozenClaimStateSchema = z.object({
  greeting: z.object({
    state: z.enum(["none", "confirmed"]),
    at: frozenInstant.nullable(),
    messageRef: z.string().nullable(),
    source: frozenToken.nullable(),
  }),
  lease: z.object({
    state: z.enum(["none", "owned", "held", "expired", "released"]),
    leaseToken: z.string().nullable(),
    expiresAt: frozenInstant.nullable(),
    heldBy: z.enum(["you-elsewhere", "someone-else"]).nullable(),
  }),
  group: z.object({
    generationRef: z.string(),
    variant: frozenCount,
    partCount: z.int().gte(1),
    sentParts: z.array(frozenCount),
    heldParts: z.array(frozenCount),
  }).nullable(),
  custody: z.object({
    attemptId: frozenUuid,
    state: z.enum(["dispatching", "sent", "failed", "uncertain-held", "resolved-sent", "resolved-not-sent"]),
    ticket: z.string().nullable(),
    ticketExpiresAt: frozenInstant.nullable(),
  }).nullable(),
  serverNow: frozenInstant,
  flagRevision: frozenCount,
});

/** The client's error body (`HubErrorBodySchema`); an extra key is dropped, never a failed parse. */
export const frozenErrorBodySchema = z.object({
  error: z.string(),
  message: z.string(),
  statusCode: z.int(),
  reason: z.string().optional(),
  statusUrl: z.string().optional(),
});
