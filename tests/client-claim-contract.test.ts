import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import * as contracts from "@agency_hub_core/contracts";
import {
  CLIENT_CUSTODY_STATES,
  CLIENT_GREETING_SOURCES,
  CLIENT_TOKEN_PROFILES,
  clientFanClaimBodySchema,
  clientFanClaimResponseSchema,
  clientOpenToken,
  clientPageFanParamsSchema,
  clientPreviewSendRateLimitedResponseSchema,
  clientSendCustodyItemSchema,
  clientSendCustodyParamsSchema,
  clientSendCustodyResolveBodySchema,
  errorResponseSchema,
  routeSchemas,
} from "@agency_hub_core/contracts";
import {
  CLIENT_FAN_LEASE_TTL_MS,
  CLIENT_PREVIEW_SEND_RATE_LIMIT,
  CLIENT_SEND_TICKET_TTL_MS,
} from "@agency_hub_core/db";

import { SERVED_CLIENT_CAPABILITIES } from "../apps/runtime/src/services/client-capabilities.ts";
import { clientFeatureExistsOn, evaluateClientFeature } from "../apps/runtime/src/services/client-features.ts";
import { CLIENT_BOOTSTRAP_LIMITS } from "../apps/runtime/src/services/client-limits.ts";
import {
  CLIENT_CLAIM_REFUSAL_MESSAGES,
  ClientClaimRefusedError,
  ClientPreviewSendRateLimitedError,
  type ClientClaimRefusalCode,
} from "../apps/runtime/src/services/errors.ts";
import * as sdk from "../packages/sdk/src/index.ts";
import {
  frozenClaimBodySchema as frozenBody,
  frozenClaimStateSchema as frozenState,
  frozenErrorBodySchema,
} from "./helpers/client-claim-frozen.ts";

// chat-extension H-7b: the greeting lease and send custody routes
// (`clientFanClaim`, `clientFanClaimStatus`, `clientSendCustodyResolve`). Their
// behaviour over real rows is tests/client-claim-routes.integration.test.ts;
// the rules themselves are tests/client-claim-transition.test.ts and
// tests/client-claim.integration.test.ts (H-7a). This file holds the shapes,
// against the client's frozen ones (tests/helpers/client-claim-frozen.ts).

const LEASE = "0b0e7c0e-6f0a-4a43-9d5c-2f1d7c9d1a11";
const INSTANCE = "5d3c1c0a-7a7e-4c0b-9a55-0c8f6e1b2d33";
const ATTEMPT = "9f1b2c3d-4e5f-4a6b-8c7d-0123456789ab";
const GENERATION = "3c2b1a09-8f7e-4d6c-b5a4-fedcba987654";
const GROUP = { generationRef: GENERATION, variant: 0, partCount: 3 };

describe("claim and custody contract", () => {
  it("declares two device-token routes on one path and a cabinet route, each with every status it answers", () => {
    const routes = routeSchemas as unknown as Record<string, {
      auth: { kind: string; scope?: string };
      tags: readonly string[];
      params: unknown;
      querystring?: unknown;
      body?: unknown;
      response: Record<number, unknown>;
    }>;
    expect(routes.clientFanClaim!.auth).toEqual({ kind: "apiKey", scope: "page" });
    expect(routes.clientFanClaimStatus!.auth).toEqual({ kind: "apiKey", scope: "page" });
    // Owner and team leads, by cookie, on a page they reach.
    expect(routes.clientSendCustodyResolve!.auth).toEqual({ kind: "session", scope: "page" });
    for (const key of ["clientFanClaim", "clientFanClaimStatus", "clientSendCustodyResolve"]) {
      expect(routes[key]!.tags, key).toEqual(["client"]);
      expect(routes[key]!.querystring, key).toBeUndefined();
    }
    expect(Object.keys(routes.clientFanClaim!.response).sort()).toEqual(["200", "400", "401", "403", "404", "409", "429"]);
    expect(Object.keys(routes.clientFanClaimStatus!.response).sort()).toEqual(["200", "400", "401", "403", "404", "409"]);
    expect(Object.keys(routes.clientSendCustodyResolve!.response).sort()).toEqual(["200", "400", "401", "403", "404", "409"]);
    // The status is a read: no body; both client routes answer one shape.
    expect(routes.clientFanClaimStatus!.body).toBeUndefined();
    expect(routes.clientFanClaimStatus!.response[200]).toBe(routes.clientFanClaim!.response[200]);
    expect(routes.clientFanClaim!.params).toBe(clientPageFanParamsSchema);
    expect(routes.clientFanClaimStatus!.params).toBe(clientPageFanParamsSchema);
    expect(routes.clientSendCustodyResolve!.params).toBe(clientSendCustodyParamsSchema);

    expect(sdk.kernelOperations.clientFanClaim).toEqual({
      method: "POST",
      path: "/api/v1/client/pages/:pageLabel/fans/:fanRef/claim",
    });
    expect(sdk.kernelOperations.clientFanClaimStatus).toEqual({
      method: "GET",
      path: "/api/v1/client/pages/:pageLabel/fans/:fanRef/claim",
    });
    expect(sdk.kernelOperations.clientSendCustodyResolve).toEqual({
      method: "POST",
      path: "/api/v1/pages/:pageLabel/client-send-custody/:attemptId/resolve",
    });
  });

  it("takes every body the client's frozen schema lets out", () => {
    const bodies = [
      { action: "claim", leaseToken: LEASE, instanceId: INSTANCE },
      { action: "renew", leaseToken: LEASE, instanceId: INSTANCE },
      { action: "release", leaseToken: LEASE, instanceId: INSTANCE },
      // The client's id form is any 8-4-4-4-12 hex, in any case: wider than an RFC UUID.
      { action: "claim", leaseToken: "11111111-1111-1111-1111-111111111111", instanceId: INSTANCE.toUpperCase() },
      {
        action: "dispatch", attemptId: ATTEMPT, instanceId: INSTANCE, purpose: "greeting", group: GROUP,
        partIndex: 0, textRevision: 0, leaseToken: LEASE, flagRevision: 0,
      },
      // A reply from the Spenders preview carries no lease; the last part of the largest group.
      {
        action: "dispatch", attemptId: ATTEMPT, instanceId: INSTANCE, purpose: "preview-reply",
        group: { generationRef: GENERATION, variant: 2, partCount: 10 }, partIndex: 9, textRevision: 41, flagRevision: 139,
      },
      { action: "sent", attemptId: ATTEMPT, instanceId: INSTANCE, platformMessageId: "7001", evidence: "receipt+echo" },
      { action: "sent", attemptId: ATTEMPT, instanceId: INSTANCE, platformMessageId: "9".repeat(30), evidence: "receipt+echo" },
      { action: "failed", attemptId: ATTEMPT, instanceId: INSTANCE, reason: "not_enqueued" },
      { action: "failed", attemptId: ATTEMPT, instanceId: INSTANCE, reason: "native_rejected", httpStatus: 400 },
      { action: "failed", attemptId: ATTEMPT, instanceId: INSTANCE, reason: "native_rejected", httpStatus: 403 },
      { action: "failed", attemptId: ATTEMPT, instanceId: INSTANCE, reason: "native_rejected", httpStatus: 499 },
      {
        action: "registerNativeSend", attemptId: ATTEMPT, instanceId: INSTANCE, purpose: "greeting",
        group: { ...GROUP, partCount: 1 }, partIndex: 0, platformMessageId: "8001",
      },
    ];
    for (const body of bodies) {
      expect(frozenBody.safeParse(body).success, JSON.stringify(body)).toBe(true);
      expect(clientFanClaimBodySchema.parse(body), JSON.stringify(body)).toEqual(body);
    }
  });

  it("refuses what the client's schema refuses: a foreign key, a part outside its group, a failure without proof", () => {
    const dispatch = {
      action: "dispatch", attemptId: ATTEMPT, instanceId: INSTANCE, purpose: "greeting", group: GROUP,
      partIndex: 0, textRevision: 1, leaseToken: LEASE, flagRevision: 3,
    };
    const refused: unknown[] = [
      {},
      { action: "resolve", attemptId: ATTEMPT },
      { action: "claim", leaseToken: LEASE },
      { action: "claim", leaseToken: "not-a-uuid", instanceId: INSTANCE },
      // The caller, the page and the fan are never the client's to send.
      { action: "claim", leaseToken: LEASE, instanceId: INSTANCE, userId: 7 },
      { action: "claim", leaseToken: LEASE, instanceId: INSTANCE, fanRef: "777000888" },
      { ...dispatch, partIndex: 3 },
      { ...dispatch, partIndex: -1 },
      { ...dispatch, group: { ...GROUP, variant: 3 } },
      { ...dispatch, group: { ...GROUP, partCount: 11 } },
      { ...dispatch, group: { ...GROUP, text: "the part's text never travels" } },
      { ...dispatch, purpose: "broadcast" },
      { ...dispatch, flagRevision: undefined },
      { ...dispatch, textRevision: 1.5 },
      { ...dispatch, text: "hi" },
      // Critic 12: the report names the install; a 401 proves nothing about the send.
      { action: "sent", attemptId: ATTEMPT, platformMessageId: "7001", evidence: "receipt+echo" },
      { action: "sent", attemptId: ATTEMPT, instanceId: INSTANCE, platformMessageId: "7001" },
      { action: "sent", attemptId: ATTEMPT, instanceId: INSTANCE, platformMessageId: "7001", evidence: "receipt" },
      { action: "sent", attemptId: ATTEMPT, instanceId: INSTANCE, platformMessageId: "0701", evidence: "receipt+echo" },
      { action: "sent", attemptId: ATTEMPT, instanceId: INSTANCE, platformMessageId: 7001, evidence: "receipt+echo" },
      { action: "failed", attemptId: ATTEMPT, reason: "not_enqueued" },
      { action: "failed", attemptId: ATTEMPT, instanceId: INSTANCE, reason: "not_enqueued", httpStatus: 400 },
      { action: "failed", attemptId: ATTEMPT, instanceId: INSTANCE, reason: "native_rejected" },
      { action: "failed", attemptId: ATTEMPT, instanceId: INSTANCE, reason: "native_rejected", httpStatus: 401 },
      { action: "failed", attemptId: ATTEMPT, instanceId: INSTANCE, reason: "native_rejected", httpStatus: 500 },
      { action: "failed", attemptId: ATTEMPT, instanceId: INSTANCE, reason: "native_rejected", httpStatus: 200 },
      { action: "failed", attemptId: ATTEMPT, instanceId: INSTANCE, reason: "timeout" },
      {
        action: "registerNativeSend", attemptId: ATTEMPT, instanceId: INSTANCE, purpose: "greeting",
        group: { ...GROUP, partCount: 1 }, partIndex: 1, platformMessageId: "8001",
      },
    ];
    for (const body of refused) {
      expect(frozenBody.safeParse(body).success, JSON.stringify(body)).toBe(false);
      expect(clientFanClaimBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
    // Wider than the client on one field: a stored generation ref is any text up to 100 characters.
    expect(clientFanClaimBodySchema.safeParse({ ...dispatch, group: { ...GROUP, generationRef: "g".repeat(100) } }).success).toBe(true);
    expect(clientFanClaimBodySchema.safeParse({ ...dispatch, group: { ...GROUP, generationRef: "g".repeat(101) } }).success).toBe(false);
    // Narrower on two: the revisions are kept in 32-bit columns. A bootstrap's
    // configRevision is an audit row id and a text revision a small counter.
    for (const field of ["textRevision", "flagRevision"]) {
      expect(clientFanClaimBodySchema.safeParse({ ...dispatch, [field]: 2_147_483_647 }).success, field).toBe(true);
      expect(clientFanClaimBodySchema.safeParse({ ...dispatch, [field]: 2_147_483_648 }).success, field).toBe(false);
    }
  });

  it("answers a state the client's frozen schema reads, and an installed SDK keeps reading", () => {
    const none = {
      greeting: { state: "none", at: null, messageRef: null, source: null },
      lease: { state: "none", leaseToken: null, expiresAt: null, heldBy: null },
      group: null,
      custody: null,
      serverNow: "2026-10-04T12:00:00.000Z",
      flagRevision: 0,
    };
    const answers = [
      none,
      {
        greeting: { state: "confirmed", at: "2026-10-04T11:59:58.123Z", messageRef: "7001", source: "preview-send" },
        lease: { state: "owned", leaseToken: LEASE, expiresAt: "2026-10-04T12:02:00.000Z", heldBy: null },
        group: { ...GROUP, sentParts: [0], heldParts: [1] },
        custody: { attemptId: ATTEMPT, state: "dispatching", ticket: "t".repeat(43), ticketExpiresAt: "2026-10-04T12:00:10.000Z" },
        serverNow: "2026-10-04T12:00:00.000Z",
        flagRevision: 139,
      },
      {
        // The desktop greeted the fan; someone else holds the lease; a send of theirs is not resolved.
        greeting: { state: "confirmed", at: "2026-09-21T10:00:00.000Z", messageRef: null, source: "desktop-outbox" },
        lease: { state: "held", leaseToken: null, expiresAt: "2026-10-04T12:02:00.000Z", heldBy: "someone-else" },
        group: { ...GROUP, sentParts: [], heldParts: [0] },
        custody: { attemptId: ATTEMPT, state: "uncertain-held", ticket: null, ticketExpiresAt: "2026-10-04T11:00:10.000Z" },
        serverNow: "2026-10-04T12:00:00.000Z",
        flagRevision: 139,
      },
    ];
    for (const answer of answers) {
      expect(clientFanClaimResponseSchema.parse(answer)).toEqual(answer);
      expect(frozenState.parse(answer)).toEqual(answer);
    }
    for (const state of CLIENT_CUSTODY_STATES) {
      const answer = { ...none, custody: { attemptId: ATTEMPT, state, ticket: null, ticketExpiresAt: null } };
      expect(clientFanClaimResponseSchema.safeParse(answer).success, state).toBe(true);
      expect(frozenState.safeParse(answer).success, state).toBe(true);
    }
    // Not strict: a key a later hub adds is stripped, never a failed parse.
    expect(clientFanClaimResponseSchema.parse({ ...none, laterKey: 1, lease: { ...none.lease, holderName: "never sent" } }))
      .toEqual(none);
    // The automata are closed: a state the client does not know is a new route version, not a new value.
    for (const broken of [
      { ...none, greeting: { ...none.greeting, state: "pending" } },
      { ...none, lease: { ...none.lease, state: "stolen" } },
      { ...none, lease: { ...none.lease, heldBy: "grisha" } },
      { ...none, custody: { attemptId: ATTEMPT, state: "resolved_sent", ticket: null, ticketExpiresAt: null } },
      { ...none, flagRevision: undefined },
    ]) {
      expect(clientFanClaimResponseSchema.safeParse(broken).success, JSON.stringify(broken)).toBe(false);
      expect(frozenState.safeParse(broken).success, JSON.stringify(broken)).toBe(false);
    }
    // The greeting's source is the one growing vocabulary of the answer.
    for (const source of CLIENT_GREETING_SOURCES) {
      expect(clientOpenToken.safeParse(source).success, source).toBe(true);
    }
    expect(CLIENT_GREETING_SOURCES).toContain("desktop-outbox");
  });

  it("the manual resolve takes an outcome and a note; a message id is proof of a send only", () => {
    expect(clientSendCustodyParamsSchema.safeParse({ pageLabel: "lora-of", attemptId: ATTEMPT }).success).toBe(true);
    expect(clientSendCustodyParamsSchema.safeParse({ pageLabel: "lora-of", attemptId: "17" }).success).toBe(false);
    expect(clientSendCustodyResolveBodySchema.parse({ outcome: "sent", platformMessageId: "7001", note: "  seen in the chat  " }))
      .toEqual({ outcome: "sent", platformMessageId: "7001", note: "seen in the chat" });
    expect(clientSendCustodyResolveBodySchema.safeParse({ outcome: "sent", note: "the chatter confirms" }).success).toBe(true);
    expect(clientSendCustodyResolveBodySchema.safeParse({ outcome: "not_sent", note: "not in the chat" }).success).toBe(true);
    for (const body of [
      { outcome: "sent" },
      { outcome: "sent", note: "   " },
      { outcome: "sent", note: "x".repeat(501) },
      { outcome: "maybe", note: "x" },
      { outcome: "not_sent", platformMessageId: "7001", note: "pasted by mistake" },
      { outcome: "sent", platformMessageId: "0701", note: "x" },
      { outcome: "sent", note: "x", resolvedByUserId: 1 },
    ]) {
      expect(clientSendCustodyResolveBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
    const item = {
      attemptId: ATTEMPT, fanRef: "777000777", userId: 7, purpose: "greeting", state: "resolved-sent",
      generationRef: GENERATION, partIndex: 0, partCount: 3,
      createdAt: "2026-10-04T12:00:00.000Z", ticketExpiresAt: "2026-10-04T12:00:10.000Z",
    };
    expect(clientSendCustodyItemSchema.parse({ ...item, resolutionNote: "never sent" })).toEqual(item);
    // A registered native send has no ticket.
    expect(clientSendCustodyItemSchema.safeParse({ ...item, ticketExpiresAt: null }).success).toBe(true);
  });

  it("serves the capability, lists both client routes for the narrow token and exports the states through the SDK", () => {
    expect(SERVED_CLIENT_CAPABILITIES).toContain("preview-send-custody-v1");
    const operations: readonly string[] = CLIENT_TOKEN_PROFILES["chat-extension"].operations;
    expect(operations).toEqual(expect.arrayContaining(["clientFanClaim", "clientFanClaimStatus"]));
    // The resolve is the cabinet's; the Fansly outreach route stays off the list.
    expect(operations).not.toContain("clientSendCustodyResolve");
    expect(operations).not.toContain("followerOutreachAttempt");

    const on = {
      enabled: true,
      features: { "*": { previewSend: true, newcomers: true } },
      hostBindings: {},
    };
    const page = { label: "lora-of", platform: "onlyfans" as const, platformAccountId: "100000001" };
    // With this route the hub serves all of `previewSend`: the owner's switch decides from here on.
    expect(evaluateClientFeature({ settings: on, page, flag: "previewSend", served: SERVED_CLIENT_CAPABILITIES }))
      .toEqual({ available: true });
    // `newcomers` needs this capability and the list's (`audience-new-v1`, H-7c):
    // the hub serves both, so claim, renew and a greeting's dispatch wait only
    // for the owner's switch. Without either capability they would answer
    // `hub_not_ready`.
    expect(evaluateClientFeature({ settings: on, page, flag: "newcomers", served: SERVED_CLIENT_CAPABILITIES }))
      .toEqual({ available: true });
    for (const missing of ["audience-new-v1", "preview-send-custody-v1"]) {
      expect(evaluateClientFeature({
        settings: on, page, flag: "newcomers",
        served: SERVED_CLIENT_CAPABILITIES.filter((capability) => capability !== missing),
      }), missing).toEqual({ available: false, reason: "hub_not_ready" });
    }

    // The flag-less status and native record exist where sending from the preview does.
    expect(clientFeatureExistsOn("previewSend", "onlyfans")).toBe(true);
    expect(clientFeatureExistsOn("previewSend", "fansly")).toBe(false);

    expect(contracts.CLIENT_CLAIM_ACTIONS).toEqual([
      "claim", "renew", "release", "dispatch", "sent", "failed", "registerNativeSend",
    ]);
    expect(contracts.CLIENT_CUSTODY_STATES).toEqual([
      "dispatching", "sent", "failed", "uncertain-held", "resolved-sent", "resolved-not-sent",
    ]);
    expect(contracts.CLIENT_LEASE_STATES).toEqual(["none", "owned", "held", "expired", "released"]);
    expect(contracts.CLIENT_LEASE_HOLDERS).toEqual(["you-elsewhere", "someone-else"]);
    expect(contracts.CLIENT_GREETING_SOURCES).toEqual(["preview-send", "native-register", "resolve", "desktop-outbox"]);
    for (const name of [
      "CLIENT_CLAIM_ACTIONS", "CLIENT_CLAIM_MAX_PARTS", "CLIENT_CLAIM_MAX_VARIANTS", "CLIENT_CUSTODY_STATES",
      "CLIENT_GREETING_SOURCES", "CLIENT_GREETING_STATES", "CLIENT_LEASE_HOLDERS", "CLIENT_LEASE_STATES",
      "CLIENT_SEND_FAILURE_REASONS", "CLIENT_SEND_PURPOSES",
    ] as const) {
      expect(sdk[name], name).toBe(contracts[name]);
    }
  });

  it("the bootstrap announces the limits the repository enforces", () => {
    expect(CLIENT_BOOTSTRAP_LIMITS.claimLeaseSec * 1000).toBe(CLIENT_FAN_LEASE_TTL_MS);
    expect(CLIENT_BOOTSTRAP_LIMITS.dispatchTicketSec * 1000).toBe(CLIENT_SEND_TICKET_TTL_MS);
    expect(CLIENT_BOOTSTRAP_LIMITS.previewSendPerMinute).toBe(CLIENT_PREVIEW_SEND_RATE_LIMIT);
  });

  it("every refusal has its own code and the status the client froze for it; only the rate limit carries advice", () => {
    // The client's HUB_ERROR_STATUSES rows of this route (its hub/error-map.ts).
    const frozenStatuses: Record<ClientClaimRefusalCode, number> = {
      claim_busy: 409,
      claim_expired: 409,
      custody_held: 409,
      greeting_done: 409,
      part_already_sent: 409,
      generation_mismatch: 409,
      attempt_conflict: 409,
      custody_not_owned: 409,
    };
    expect(Object.keys(CLIENT_CLAIM_REFUSAL_MESSAGES).sort()).toEqual(Object.keys(frozenStatuses).sort());
    for (const [code, statusCode] of Object.entries(frozenStatuses) as Array<[ClientClaimRefusalCode, number]>) {
      const error = new ClientClaimRefusedError(code);
      expect([error.statusCode, error.code], code).toEqual([statusCode, code]);
      expect(error).not.toHaveProperty("reason");
      // No message names a person: the holder of a lease or a send is never disclosed.
      expect(error.message).not.toMatch(/user|chatter #|\d/i);
      const envelope = { error: error.code, message: error.message, statusCode };
      expect(errorResponseSchema.parse(envelope)).toEqual(envelope);
      expect(frozenErrorBodySchema.parse(envelope)).toEqual(envelope);
    }
    const limited = new ClientPreviewSendRateLimitedError(41_500);
    expect([limited.statusCode, limited.code, limited.retryAfterMs]).toEqual([429, "preview_send_rate_limited", 41_500]);
    const body = { error: limited.code, message: limited.message, statusCode: 429, retryAfterMs: 41_500 };
    expect(clientPreviewSendRateLimitedResponseSchema.parse(body)).toEqual(body);
    // The client's error body reads it too: the advice is an extra key to it.
    expect(frozenErrorBodySchema.safeParse(body).success).toBe(true);
    expect(routeSchemas.clientFanClaim.response[429]).toBe(clientPreviewSendRateLimitedResponseSchema);
  });

  it("leaves the Fansly outreach route's wire byte for byte as it was", () => {
    // `followerOutreachAttempt` (the desktop's and the Fansly extension's
    // greeting custody) is a separate route this change must not touch: the
    // sha256 of its OpenAPI fragment as it stood on main before H-7b.
    const document = JSON.parse(
      readFileSync(new URL("../reference/agency-hub.openapi.json", import.meta.url), "utf8"),
    ) as { paths: Record<string, unknown> };
    const fragment = document.paths["/api/v1/pages/{pageLabel}/follower-outreach/attempt"];
    expect(fragment).toBeDefined();
    expect(createHash("sha256").update(JSON.stringify(fragment)).digest("hex"))
      .toBe("cb9f2d8ca5d5d11204239108af8f98ab0ff82413c0c8554e6dfc7d4c51b1bf30");
  });
});
