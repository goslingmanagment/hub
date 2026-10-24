/**
 * Agent Read Plane — owner administration of the KEYS themselves.
 *
 * WHY THIS IS NOT IN `routes-agent.ts`: that module is the read plane, and its
 * pins say so — eleven operations, exactly one of them owner-session, an envelope
 * on every 200. Issuing a key is none of those things: it is the owner minting a
 * machine principal, it has no `capture`/`conclusion` to carry, and folding it in
 * would have meant loosening the very pins that make the read plane checkable.
 *
 * WHY IT IS STILL UNDER `/api/v1/agent/`: the plane's `Cache-Control: no-store`
 * hook keys on that prefix, and a response that carries a freshly minted bearer
 * token is the LAST one that may sit in an intermediary. The routes are therefore
 * also registered by the agent-read registrar, after the hook exists.
 *
 * THE ONE RULE THAT SHAPES EVERY SCHEMA HERE: **the raw token is returned once
 * and the digest is never returned at all.** `agentKeyItemSchema` is what a
 * listing may say about a key; there is no code path that widens it.
 *
 * Two validations are DELIBERATELY not restated here:
 *  - the closed capability matrix is derived from `AGENT_CAPABILITIES`, so an
 *    unknown capability is a 400 from the schema and the table CHECK is the
 *    backstop, not a second copy of the rule;
 *  - the 365-day lifetime ceiling is NOT a `.max()` on `expiresInDays`. It lives
 *    in `insertAgentKey` and in the table CHECK; an over-long request travels all
 *    the way there and comes back as that ONE enforcement point's 400. A ceiling
 *    written twice is a ceiling that drifts.
 */

import { z } from "zod";

import { AGENT_CAPABILITIES } from "./agent-read-capabilities.ts";
import { errorResponseSchema, intId } from "./primitives.ts";
import { agentIsoTimestamp } from "./routes-agent.ts";

/** Derived, never hand-listed: the enum IS the closed matrix (spec §8). */
export const agentKeyCapabilityEnum = z.enum(AGENT_CAPABILITIES);

/** The sliding default; the hard ceiling lives with the repository. */
export const AGENT_KEY_DEFAULT_LIFETIME_DAYS = 90;

/**
 * Everything a listing may say about a key. `keyDigest` is absent BY DESIGN:
 * `keyPrefix` identifies a key to a human, the digest would let a leaked listing
 * be checked against a guessed token offline.
 */
export const agentKeyItemSchema = z.object({
  id: intId,
  name: z.string(),
  /** The displayable head of the token, api-key precedent. Not a secret. */
  keyPrefix: z.string(),
  capabilities: z.array(agentKeyCapabilityEnum),
  /** The EXPLICIT grant, resolved back to labels. No wildcard exists: a page
   *  created after issuance is not granted by anything. */
  pageLabels: z.array(z.string()),
  expiresAt: agentIsoTimestamp,
  createdAt: agentIsoTimestamp,
  revokedAt: agentIsoTimestamp.nullable(),
  lastUsedAt: agentIsoTimestamp.nullable(),
  /** Neither revoked nor past its expiry, evaluated when the list was read. */
  isActive: z.boolean(),
}).strict();

export const agentKeyCreateBodySchema = z.object({
  name: z.string().min(1).max(200),
  capabilities: z.array(agentKeyCapabilityEnum).min(1).max(AGENT_CAPABILITIES.length),
  /** At least one: a key granted no page can read nothing, and issuing one would
   *  only produce a credential that fails confusingly at every call. */
  pageLabels: z.array(z.string().min(1).max(200)).min(1).max(200),
  /** Days from issuance. The upper bound here is a sanity rail on the INPUT, far
   *  above the real ceiling; the ceiling itself is enforced once, in the
   *  repository, and reported as a 400 (see the file header). */
  expiresInDays: z.number().int().min(1).max(10_000)
    .default(AGENT_KEY_DEFAULT_LIFETIME_DAYS),
}).strict();

export const agentKeyCreateResponseSchema = z.object({
  /**
   * THE ONLY TIME THIS VALUE EXISTS OUTSIDE THE CALLER'S PROCESS. The hub stores
   * `sha256(token)`; there is no re-read route, and a lost token is re-issued,
   * never recovered.
   */
  token: z.string(),
  key: agentKeyItemSchema,
}).strict();

export const agentKeyParamsSchema = z.object({
  id: z.coerce.number().int().min(1),
}).strict();

/**
 * The WHOLE new capability set of a live key, not a diff: what the owner sees
 * ticked is what the key holds afterwards. Empty is allowed (a key that keeps
 * its pages but may read nothing); a repeated name is a 400 rather than folded,
 * like an unknown one. The page grant is not part of this body: pages are still
 * widened only by issuing a new key.
 */
export const agentKeyUpdateBodySchema = z.object({
  capabilities: z.array(agentKeyCapabilityEnum).max(AGENT_CAPABILITIES.length)
    .refine((values) => new Set(values).size === values.length, "capabilities must be unique"),
}).strict();

export const agentKeyRevokeResponseSchema = z.object({
  id: intId,
  /** False when the key was ALREADY revoked. Idempotent by construction: the
   *  second call does not move the original revocation timestamp. */
  revoked: z.boolean(),
  revokedAt: agentIsoTimestamp.nullable(),
}).strict();

export const agentKeyAdminRouteSchemas = {
  agentKeyCreate: {
    auth: { kind: "owner-session" },
    tags: ["agent"],
    summary: "Issue an agent read-plane key (returns the raw token exactly once)",
    body: agentKeyCreateBodySchema,
    response: {
      200: agentKeyCreateResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  agentKeyList: {
    auth: { kind: "owner-session" },
    tags: ["agent"],
    summary: "List agent read-plane keys (digests are never returned)",
    response: {
      200: z.array(agentKeyItemSchema),
      401: errorResponseSchema,
      403: errorResponseSchema,
    },
  },
  agentKeyUpdate: {
    auth: { kind: "owner-session" },
    tags: ["agent"],
    summary: "Replace a live agent key's capabilities (takes effect on its next request; audited)",
    params: agentKeyParamsSchema,
    body: agentKeyUpdateBodySchema,
    response: {
      200: agentKeyItemSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  },
  agentKeyRevoke: {
    auth: { kind: "owner-session" },
    tags: ["agent"],
    summary: "Revoke an agent read-plane key (idempotent)",
    params: agentKeyParamsSchema,
    response: {
      200: agentKeyRevokeResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  },
} as const;

export type AgentKeyItem = z.infer<typeof agentKeyItemSchema>;
export type AgentKeyCreateBody = z.infer<typeof agentKeyCreateBodySchema>;
export type AgentKeyCreateResponse = z.infer<typeof agentKeyCreateResponseSchema>;
export type AgentKeyUpdateBody = z.infer<typeof agentKeyUpdateBodySchema>;
export type AgentKeyRevokeResponse = z.infer<typeof agentKeyRevokeResponseSchema>;
