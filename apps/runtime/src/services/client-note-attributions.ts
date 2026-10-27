import { createHash } from "node:crypto";

import {
  CLIENT_NOTE_ATTRIBUTION_MAX_AGE_DAYS,
  CLIENT_NOTE_ATTRIBUTION_MAX_AHEAD_MS,
  type ClientNoteAttributionOutcome,
  type ClientNoteAttributionSource,
  type ClientNoteAttributionsBody,
  type ClientNoteAttributionsResponse,
} from "@agency_hub_core/contracts";
import {
  CLIENT_NOTE_ATTRIBUTION_STORED_ACTIONS,
  CLIENT_NOTE_ATTRIBUTION_STORED_NOTE_KINDS,
  CLIENT_NOTE_ATTRIBUTION_STORED_ORIGINS,
  findPageSummaryByLabel,
  insertObservation,
  recordClientNoteAttributions,
  type ClientNoteAttributionFactInput,
  type ClientNoteAttributionStoredAction,
  type ClientNoteAttributionStoredNoteKind,
  type ClientNoteAttributionStoredOrigin,
  type Database,
} from "@agency_hub_core/db";
import type { Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { requireApiKeyUser, type HumanAuthPrincipal } from "./auth.ts";
import { clientVersionOf } from "./client-send-attributions.ts";
import { requireClientGrantedPage, type ClientFeatureRequest } from "./client-switches.ts";
import { clientTokenIngestProducer } from "./client-token-profile.ts";
import { BadRequestError, ClientFeatureDisabledError } from "./errors.ts";
import { ingestProducerForClientVersion } from "./ingest-observations.ts";

/**
 * Who wrote each Fansly note (`clientNoteAttributions`, capability
 * `note-attribution-v1`).
 *
 * Fansly notes live on Fansly, and the hub's sync reads them
 * (page_fan_external_notes), but nothing said who wrote one. The chat
 * extension writes them through the page's own session; once Fansly confirmed
 * a write, it reports it here. The table is the record (0324): one row per
 * write event of a page (the client's `eventId`), first report wins.
 *
 * WHO MAY REPORT: the same as send attribution (services/client-send-attributions.ts).
 * A device token (a cookie session is 403), a page granted to the caller (else
 * 409 `client_feature_disabled` / `not_granted`). The writer is the token's
 * user, never a field of the body. No owner switch: the write already happened
 * on Fansly.
 *
 * WHICH CLIENTS A PLATFORM TAKES: CLIENT_NOTE_ATTRIBUTION_ADMISSIONS; another
 * source is 409 `platform_unsupported`.
 *
 * JOURNAL FIRST. Every fact the body carries is one `observations` row of
 * kind NOTE_ATTRIBUTION_OBSERVATION_KIND under the reporting person, before
 * its row and in the same transaction.
 *
 * Database only. No title or text of a note is read or stored.
 */

/** How a refusal names the route: it has no owner flag of its own. */
export const NOTE_ATTRIBUTION_FEATURE = "note-attribution-v1";

export const CLIENT_NOTE_ATTRIBUTION_ADMISSIONS: Readonly<Partial<Record<Platform, readonly ClientNoteAttributionSource[]>>> = {
  fansly: ["fansly-extension"],
};

/** The capture journal's kind of one reported fact (observation-kinds.ts). */
export const NOTE_ATTRIBUTION_OBSERVATION_KIND = "client.note_attribution.v1";

/** The source as the table stores it, when the page's platform takes it; null otherwise. Pure. */
export function admitClientNoteAttributionSource(platform: Platform, source: string): ClientNoteAttributionSource | null {
  const admitted = CLIENT_NOTE_ATTRIBUTION_ADMISSIONS[platform] ?? [];
  return (admitted as readonly string[]).includes(source) ? (source as ClientNoteAttributionSource) : null;
}

/** The origin as the table stores it: null when the client does not say or names one the hub does not know. Pure. */
export function storedNoteOrigin(value: string | undefined): ClientNoteAttributionStoredOrigin | null {
  return value !== undefined && (CLIENT_NOTE_ATTRIBUTION_STORED_ORIGINS as readonly string[]).includes(value)
    ? (value as ClientNoteAttributionStoredOrigin)
    : null;
}

/** Whether a fact's `observedAt` is inside what the hub takes at `now`. Pure. */
export function noteAttributionObservedInRange(observedAt: Date, now: Date): boolean {
  const at = observedAt.getTime();
  return at <= now.getTime() + CLIENT_NOTE_ATTRIBUTION_MAX_AHEAD_MS
    && at >= now.getTime() - CLIENT_NOTE_ATTRIBUTION_MAX_AGE_DAYS * 24 * 60 * 60_000;
}

export async function applyClientNoteAttributions(
  app: AppContext,
  request: ClientFeatureRequest,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; body: ClientNoteAttributionsBody },
): Promise<ClientNoteAttributionsResponse> {
  requireApiKeyUser(principal);
  const page = await requireClientGrantedPage(
    app,
    principal,
    await findPageSummaryByLabel(app.db, input.pageLabel),
    NOTE_ATTRIBUTION_FEATURE,
  );
  const source = admitClientNoteAttributionSource(page.platform, input.body.source);
  if (source === null) {
    throw new ClientFeatureDisabledError(NOTE_ATTRIBUTION_FEATURE, "platform_unsupported");
  }

  // Every fact is read before anything is written: a time that is not a time, or a kind or action the
  // hub does not know, is 400 as a whole.
  const read = input.body.facts.map((fact, index) => {
    const at = new Date(fact.observedAt);
    if (Number.isNaN(at.getTime())) {
      throw new BadRequestError(`facts[${index}].observedAt is not a time`);
    }
    if (!(CLIENT_NOTE_ATTRIBUTION_STORED_NOTE_KINDS as readonly string[]).includes(fact.noteKind)) {
      throw new BadRequestError(`facts[${index}].noteKind is not known`);
    }
    if (!(CLIENT_NOTE_ATTRIBUTION_STORED_ACTIONS as readonly string[]).includes(fact.action)) {
      throw new BadRequestError(`facts[${index}].action is not known`);
    }
    return {
      at,
      noteKind: fact.noteKind as ClientNoteAttributionStoredNoteKind,
      action: fact.action as ClientNoteAttributionStoredAction,
    };
  });

  const clientVersion = clientVersionOf(request.headers["x-client-version"]);
  const producer = principal.clientProfile === undefined
    ? ingestProducerForClientVersion(clientVersion ?? "unknown")
    : clientTokenIngestProducer(principal.clientProfile, clientVersion);
  const now = new Date();

  const recorded = await app.db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    const taken: ClientNoteAttributionFactInput[] = [];
    for (const [index, fact] of input.body.facts.entries()) {
      const { at, noteKind, action } = read[index]!;
      const payload = { pageLabel: page.label, source, fact };
      const journaled = await insertObservation(tx, {
        source: "client_capture",
        producer,
        platform: page.platform,
        accountId: page.id,
        kind: NOTE_ATTRIBUTION_OBSERVATION_KIND,
        payload,
        payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
        idempotencyKey: `${principal.user.id}:note_attribution:${page.id}:${fact.eventId.toLowerCase()}`,
        observedAt: at,
        actorPrincipalId: principal.user.id,
      });
      if (!noteAttributionObservedInRange(at, now)) continue;
      taken.push({
        eventId: fact.eventId,
        fanRef: fact.fanRef,
        noteRef: fact.noteRef,
        noteKind,
        action,
        origin: storedNoteOrigin(fact.origin),
        fields: fact.fields ?? null,
        observedAt: at,
        observationId: journaled.observationId,
      });
    }
    return recordClientNoteAttributions(tx, {
      platform: page.platform,
      pageId: page.id,
      userId: principal.user.id,
      source,
      clientVersion,
      facts: taken,
    });
  });

  let next = 0;
  const results = input.body.facts.map((fact, index): { eventId: string; outcome: ClientNoteAttributionOutcome } => {
    if (!noteAttributionObservedInRange(read[index]!.at, now)) {
      return { eventId: fact.eventId, outcome: "out_of_range" };
    }
    const result = recorded[next];
    next += 1;
    return { eventId: fact.eventId, outcome: result!.outcome };
  });

  const conflicts = results.filter((result) => result.outcome === "conflict").length;
  const outOfRange = results.filter((result) => result.outcome === "out_of_range").length;
  if (conflicts > 0 || outOfRange > 0) {
    app.logger?.warn(
      { pageId: page.id, userId: principal.user.id, facts: results.length, conflicts, outOfRange },
      "note attributions not recorded: the event was reported otherwise first, or observed out of range",
    );
  }

  return { pageLabel: page.label, results, serverNow: now.toISOString() };
}
