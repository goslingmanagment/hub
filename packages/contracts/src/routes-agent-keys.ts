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

import { AGENT_CAPABILITIES, type AgentCapability } from "./agent-read-capabilities.ts";
import { personCodeSchema, personStateEnum } from "./people.ts";
import { errorResponseSchema, intId } from "./primitives.ts";
import { agentIsoTimestamp, agentSha256Hex } from "./routes-agent.ts";

/** Derived, never hand-listed: the enum IS the closed matrix (spec §8). */
export const agentKeyCapabilityEnum = z.enum(AGENT_CAPABILITIES);

/** The sliding default; the hard ceiling lives with the repository. */
export const AGENT_KEY_DEFAULT_LIFETIME_DAYS = 90;

/**
 * A service's own capabilities: a server's key that signs people in or asks
 * who an agent's key is, and reads and writes nothing of the agency. A key of
 * these alone is the one key that may have no agent (ecosystem plan §3.3:
 * «сервисные ключи — не агентские»); every other key belongs to an agent.
 */
export const AGENT_KEY_SERVICE_CAPABILITIES = [
  "signin:contentops",
  "signin:taskindex",
  "signin:monitor",
  "introspect:agent_keys",
] as const satisfies readonly AgentCapability[];

/** Whether a key of these capabilities is a service's own (it may then have no agent). */
export function isServiceKeyCapabilities(capabilities: readonly string[]): boolean {
  const service: ReadonlySet<string> = new Set(AGENT_KEY_SERVICE_CAPABILITIES);
  return capabilities.length > 0 && capabilities.every((capability) => service.has(capability));
}

/** The agent person a key belongs to (the people registry's `person_agent_keys`). */
export const agentKeyAgentSchema = z.object({
  code: z.string(),
  displayName: z.string(),
  state: personStateEnum,
}).strict();

/** The key's newest call, as the plane's audit recorded it. */
export const agentKeyLastCallSchema = z.object({
  at: agentIsoTimestamp,
  /** The operation's name (`agentDatasetQuery`, `agentTeamSales`, …). */
  operation: z.string(),
}).strict();

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
  /** The agent the key belongs to; null — none (a service's own key, or one issued before the registry). */
  agent: agentKeyAgentSchema.nullable(),
  /** The key's newest audited call; null — none recorded. */
  lastCall: agentKeyLastCallSchema.nullable(),
}).strict();

export const agentKeyCreateBodySchema = z.object({
  name: z.string().min(1).max(200),
  /**
   * The agent the key belongs to: a person of kind agent of the people
   * registry, not gone. Required, but for a service's own key
   * (`AGENT_KEY_SERVICE_CAPABILITIES` only), which may have none.
   */
  agentCode: personCodeSchema.optional(),
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

/**
 * «Кто этот ключ» for another service (ecosystem plan §3.3, M1.2).
 *
 * THE EXCHANGE: an agent sends the service (ledger, ContentOps, TaskIndex) its
 * hub key as the bearer. The service computes `sha256(key)` (lowercase hex, the
 * digest Hub stores) and sends ONLY that, as the bearer of its OWN key holding
 * `introspect:agent_keys`. Hub never receives the agent's key from the service
 * and never returns a key, a digest, a prefix, a capability or a page: only the
 * agent's code and name, whether the key works, and when it stops.
 *
 * An answer holds AGENT_KEY_INTROSPECT_CACHE_SECONDS; when Hub cannot be reached
 * (a deploy, an outage) the service keeps its last ACTIVE answer for
 * AGENT_KEY_INTROSPECT_STALE_SECONDS after it was fetched and refuses after
 * that. An inactive answer is never extended.
 */
export const AGENT_KEY_INTROSPECT_CACHE_SECONDS = 60;
export const AGENT_KEY_INTROSPECT_STALE_SECONDS = 3600;

export const agentKeyIntrospectBodySchema = z.object({
  /** sha256 of the key the agent showed the service, lowercase hex. Never the key itself: a raw key is a 400. */
  keyDigest: agentSha256Hex,
}).strict();

const introspectCache = {
  /** How long this answer may be used as it is. */
  cacheSeconds: z.literal(AGENT_KEY_INTROSPECT_CACHE_SECONDS),
  /** How long an ACTIVE answer may still be used while Hub cannot be reached, counted from when it was fetched. */
  staleSeconds: z.literal(AGENT_KEY_INTROSPECT_STALE_SECONDS),
};

export const agentKeyIntrospectResponseSchema = z.discriminatedUnion("active", [
  z.object({
    active: z.literal(true),
    /** The agent the key belongs to: map `code` to the service's own rights. */
    agent: z.object({ code: z.string(), displayName: z.string() }).strict(),
    expiresAt: agentIsoTimestamp,
    ...introspectCache,
  }).strict(),
  /**
   * Not a working agent key: unknown, revoked, expired, a key no agent holds (a
   * service's own), or its agent is gone. Which of them is not said.
   */
  z.object({ active: z.literal(false), ...introspectCache }).strict(),
]);

export const agentKeyIntrospectRouteSchemas = {
  agentKeyIntrospect: {
    auth: { kind: "agentKey" },
    tags: ["agent"],
    summary: "Another service asks who an agent's hub key is (needs introspect:agent_keys): the agent's code, active or not, expiry",
    description: "The service sends the sha256 of the key an agent showed it, as the bearer of its own key; never the "
      + "agent's key. The answer carries no key material, no capabilities and no pages; it holds 60 s, and an active "
      + "one may be kept up to an hour while Hub cannot be reached.",
    body: agentKeyIntrospectBodySchema,
    response: {
      200: agentKeyIntrospectResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      429: errorResponseSchema,
    },
  },
} as const;

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
export type AgentKeyAgent = z.infer<typeof agentKeyAgentSchema>;
export type AgentKeyIntrospectBody = z.infer<typeof agentKeyIntrospectBodySchema>;
export type AgentKeyIntrospectResponse = z.infer<typeof agentKeyIntrospectResponseSchema>;
