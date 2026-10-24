import { createHash } from "node:crypto";

import {
  CLIENT_SEND_ATTRIBUTION_MAX_AGE_DAYS,
  CLIENT_SEND_ATTRIBUTION_MAX_AHEAD_MS,
  type ClientSendAttributionOutcome,
  type ClientSendAttributionSource,
  type ClientSendAttributionsBody,
  type ClientSendAttributionsResponse,
} from "@agency_hub_core/contracts";
import {
  CLIENT_SEND_ATTRIBUTION_STORED_COMPOSED_WITH,
  findPageSummaryByLabel,
  insertObservation,
  recordClientSendAttributions,
  type ClientSendAttributionFactInput,
  type ClientSendAttributionStoredComposedWith,
  type Database,
} from "@agency_hub_core/db";
import type { Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { requireApiKeyUser, type HumanAuthPrincipal } from "./auth.ts";
import { requireClientGrantedPage, type ClientFeatureRequest } from "./client-switches.ts";
import { clientTokenIngestProducer } from "./client-token-profile.ts";
import { BadRequestError, ClientFeatureDisabledError } from "./errors.ts";
import { ingestProducerForClientVersion } from "./ingest-observations.ts";

/**
 * Who sent each outgoing message (`clientSendAttributions`, capability
 * `send-attribution-v1`).
 *
 * The old OnlyFans desktop sent through the hub's OFAPI commands, so the hub
 * knew the chatter of every send (`ofapi_commands.chatter_user_id`). On
 * OnlyMonster ChatSpace the person presses the page's own Send; the chat
 * extension observes that send, and once the page's own response to exactly
 * that send named the platform's message id, reports it here. The table is the
 * record (0286): one row per message of a page, first report wins.
 *
 * WHO MAY REPORT. The route is a client's: a device token (a cookie session is
 * 403), for a page that is an active page granted to the caller (else 409
 * `client_feature_disabled` / `not_granted`, the same answer for a page that
 * does not exist). The person is the token's user, never a field of the body.
 * Like `registerNativeSend`, nothing else refuses it: the send already
 * happened, so no owner switch, flag or minimum version stands between it and
 * its record.
 *
 * WHICH CLIENTS A PLATFORM TAKES. One table (CLIENT_SEND_ATTRIBUTION_ADMISSIONS),
 * so the handler holds no platform branch: OnlyFans takes the extension on
 * ChatSpace, Fansly the extension on fansly.com. A source the page's platform
 * does not take is 409 `client_feature_disabled` / `platform_unsupported`. A
 * source whose chats have ids of their own (Fansly's group) names the chat of
 * every fact; elsewhere the chat is the fan and none is stored.
 *
 * JOURNAL FIRST (Chat Memory week 1). Every fact the body carries — taken or
 * out of range, first report or a conflict — is one `observations` row of kind
 * SEND_ATTRIBUTION_OBSERVATION_KIND under the reporting person, before its
 * row and in the same transaction. The row names its journal entry.
 *
 * Database only: nothing here asks a platform or queues work. No text of a
 * message is read or stored.
 */

/** How a refusal names the route: it has no owner flag of its own. */
export const SEND_ATTRIBUTION_FEATURE = "send-attribution-v1";

export const CLIENT_SEND_ATTRIBUTION_ADMISSIONS: Readonly<Partial<Record<Platform, readonly ClientSendAttributionSource[]>>> = {
  onlyfans: ["chatspace-extension"],
  fansly: ["fansly-extension"],
};

/** The sources whose facts name their chat (`conversationRef`): Fansly's chats have ids of their own. */
export const CLIENT_SEND_ATTRIBUTION_CHAT_SOURCES: ReadonlySet<ClientSendAttributionSource> = new Set(["fansly-extension"]);

/** The capture journal's kind of one reported fact (observation-kinds.ts). */
export const SEND_ATTRIBUTION_OBSERVATION_KIND = "client.send_attribution.v1";

/** How the text was written, as the table stores it: null when the client does not say, `unknown` for a value the hub does not know. Pure. */
export function storedComposedWith(value: string | undefined): ClientSendAttributionStoredComposedWith | null {
  if (value === undefined) return null;
  return (CLIENT_SEND_ATTRIBUTION_STORED_COMPOSED_WITH as readonly string[]).includes(value)
    ? (value as ClientSendAttributionStoredComposedWith)
    : "unknown";
}

/** The source as the table stores it, when the page's platform takes it; null otherwise. Pure. */
export function admitClientSendAttributionSource(platform: Platform, source: string): ClientSendAttributionSource | null {
  const admitted = CLIENT_SEND_ATTRIBUTION_ADMISSIONS[platform] ?? [];
  return (admitted as readonly string[]).includes(source) ? (source as ClientSendAttributionSource) : null;
}

/** A readable `x-client-version` (`chat-extension/0.2.6`), else null: it is kept beside the row, never trusted. */
export function clientVersionOf(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" && /^[A-Za-z0-9._+/-]{1,64}$/.test(value) ? value : null;
}

/** Whether a fact's `observedAt` is inside what the hub takes at `now`. Pure. */
export function sendAttributionObservedInRange(observedAt: Date, now: Date): boolean {
  const at = observedAt.getTime();
  return at <= now.getTime() + CLIENT_SEND_ATTRIBUTION_MAX_AHEAD_MS
    && at >= now.getTime() - CLIENT_SEND_ATTRIBUTION_MAX_AGE_DAYS * 24 * 60 * 60_000;
}

export async function applyClientSendAttributions(
  app: AppContext,
  request: ClientFeatureRequest,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; body: ClientSendAttributionsBody },
): Promise<ClientSendAttributionsResponse> {
  // A cookie session → 403: the route is a client's, not the dashboard's.
  requireApiKeyUser(principal);
  const page = await requireClientGrantedPage(
    app,
    principal,
    await findPageSummaryByLabel(app.db, input.pageLabel),
    SEND_ATTRIBUTION_FEATURE,
  );
  const source = admitClientSendAttributionSource(page.platform, input.body.source);
  if (source === null) {
    throw new ClientFeatureDisabledError(SEND_ATTRIBUTION_FEATURE, "platform_unsupported");
  }

  // Every fact is read before anything is written: a report with a time that is not a time, or a chat
  // missing where the source's chats have ids, is 400 as a whole.
  const namesChat = CLIENT_SEND_ATTRIBUTION_CHAT_SOURCES.has(source);
  const observed = input.body.facts.map((fact, index) => {
    const at = new Date(fact.observedAt);
    if (Number.isNaN(at.getTime())) {
      throw new BadRequestError(`facts[${index}].observedAt is not a time`);
    }
    if (namesChat && fact.conversationRef === undefined) {
      throw new BadRequestError(`facts[${index}].conversationRef is required from ${source}`);
    }
    return at;
  });

  const clientVersion = clientVersionOf(request.headers["x-client-version"]);
  const producer = principal.clientProfile === undefined
    ? ingestProducerForClientVersion(clientVersion ?? "unknown")
    : clientTokenIngestProducer(principal.clientProfile, clientVersion);
  const now = new Date();

  const recorded = await app.db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    const taken: ClientSendAttributionFactInput[] = [];
    for (const [index, fact] of input.body.facts.entries()) {
      const observedAt = observed[index]!;
      const payload = { pageLabel: page.label, source, fact };
      const journaled = await insertObservation(tx, {
        source: "client_capture",
        producer,
        platform: page.platform,
        accountId: page.id,
        kind: SEND_ATTRIBUTION_OBSERVATION_KIND,
        payload,
        payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
        idempotencyKey: `${principal.user.id}:send_attribution:${page.id}:${fact.platformMessageId}`,
        observedAt,
        actorPrincipalId: principal.user.id,
      });
      if (!sendAttributionObservedInRange(observedAt, now)) continue;
      taken.push({
        platformMessageId: fact.platformMessageId,
        fanRef: fact.fanRef,
        conversationRef: namesChat ? fact.conversationRef! : null,
        observedAt,
        priced: fact.priced,
        withMedia: fact.withMedia,
        composedWith: storedComposedWith(fact.composedWith),
        edited: fact.edited ?? null,
        observationId: journaled.observationId,
      });
    }
    return recordClientSendAttributions(tx, {
      platform: page.platform,
      pageId: page.id,
      userId: principal.user.id,
      source,
      clientVersion,
      facts: taken,
    });
  });

  let next = 0;
  const results = input.body.facts.map((fact, index): { platformMessageId: string; outcome: ClientSendAttributionOutcome } => {
    if (!sendAttributionObservedInRange(observed[index]!, now)) {
      return { platformMessageId: fact.platformMessageId, outcome: "out_of_range" };
    }
    const result = recorded[next];
    next += 1;
    return { platformMessageId: fact.platformMessageId, outcome: result!.outcome };
  });

  const conflicts = results.filter((result) => result.outcome === "conflict").length;
  const outOfRange = results.filter((result) => result.outcome === "out_of_range").length;
  if (conflicts > 0 || outOfRange > 0) {
    // One line per report, counts only: a conflict is a message another person (or another fan) claimed first.
    app.logger?.warn(
      { pageId: page.id, userId: principal.user.id, facts: results.length, conflicts, outOfRange },
      "send attributions not recorded: claimed first by another report, or observed out of range",
    );
  }

  return { pageLabel: page.label, results, serverNow: now.toISOString() };
}
