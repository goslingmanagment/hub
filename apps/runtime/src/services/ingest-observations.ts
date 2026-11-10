// Client-capture lane (core side). The desktop's spool-backed
// uploader posts batches of device-held facts; each event becomes ONE
// observation (source 'client_capture') through the key protocol —
// dedup on <principal>:<clientEventId>, so resend-until-2xx is free. Unknown
// kinds are journaled under desktop.unknown:<kind>, never dropped
// (capture-first). Whole-batch atomic: a failure rolls back every claim, so
// the client resends the whole batch (3c contract). The one kind that is never
// journaled is the chat extension's `client_health` (see ingestClientObservations).

import { createHash } from "node:crypto";

import {
  findPageByLabel,
  insertObservation,
} from "@agency_hub_core/db";

import type {
  IngestObservationsBody,
  IngestObservationsResponse,
} from "../../../../packages/contracts/src/routes.ts";
import { CLIENT_HEALTH_INGEST_KIND, type ClientTokenProfile } from "@agency_hub_core/contracts";

import type { AppContext } from "../bootstrap.ts";
import type { HumanAuthPrincipal } from "./auth.ts";
import { clientHealthIngestEnabled, intakeClientHealthReports } from "./client-health-intake.ts";
import { clientTokenIngestKinds, clientTokenIngestProducer } from "./client-token-profile.ts";
import { stampOnlyParseVersion } from "./canonicalize/index.ts";

// Canonicalizer-backed desktop kinds. Everything else journals as
// desktop.unknown:<kind>.
export const INGEST_KIND_ALLOWLIST: ReadonlySet<string> = new Set([
  "ai_acceptance",
  "guard_audit",
  "send_audit",
  "ai_spend",
  "credit_spend",
  "data_purge_notice",
]);

// The OnlyMonster chat-extension sends x-client-version 'chat-extension/<v>'
// and journals as its own producer 'chat-extension@<v>', so its facts are
// attributable apart from the desktop's. Only the producer differs: its kinds
// stay in the desktop.<kind> namespace the canonicalizers and the acceptance
// projection key on. Every other header keeps the desktop@ stamp, including
// the Fansly extension's 'chatgoose-extension/<v>'.
const CHAT_EXTENSION_CLIENT_VERSION = /^chat-extension\/(.+)$/;

export function ingestProducerForClientVersion(clientVersion: string) {
  const chatExtension = CHAT_EXTENSION_CLIENT_VERSION.exec(clientVersion);
  return chatExtension
    ? `chat-extension@${chatExtension[1]}`
    : `desktop@${clientVersion}`;
}

/**
 * The producer a client route's captures journal under: a narrow token's by its
 * profile (`clientTokenIngestProducer`), a full token's by the header
 * (`ingestProducerForClientVersion`, `unknown` without one). `clientVersion` is
 * the header as the caller reads it.
 */
export function clientCaptureProducer(principal: HumanAuthPrincipal, clientVersion: string | null): string {
  return principal.clientProfile === undefined
    ? ingestProducerForClientVersion(clientVersion ?? "unknown")
    : clientTokenIngestProducer(principal.clientProfile, clientVersion);
}

// A harvest.* kind from any client falls into the unknown bucket like every
// other kind outside the allowlist — captured, never canonicalized.
function ingestKindFor(kind: string) {
  if (INGEST_KIND_ALLOWLIST.has(kind)) {
    return `desktop.${kind}`;
  }
  return `desktop.unknown:${kind}`;
}

export class InvalidIngestEventError extends Error {
  constructor(
    readonly index: number,
    readonly reason: string,
  ) {
    super(`Invalid ingest event at index ${index}: ${reason}`);
    this.name = "InvalidIngestEventError";
  }
}

function parseObservedAt(value: string, index: number): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidIngestEventError(index, "unparseable observedAt");
  }
  return parsed;
}

export async function ingestClientObservations(
  app: AppContext,
  input: {
    principalUserId: number;
    /**
     * Page ids the authenticated key may attribute observations to; null =
     * unrestricted (owner). A reference outside this scope resolves like an
     * unknown label: the fact still journals, but with a NULL account — it
     * can never canonicalize, so a key can't mint events for pages it isn't
     * assigned to, and a stale assignment can't wedge the uploader either.
     */
    allowedPageIds: readonly number[] | null;
    clientVersion: string;
    /**
     * chat-extension H-3: the narrow token's profile, from the token row. Set,
     * it admits only the profile's kinds and decides the producer; the header
     * then names only the version.
     */
    clientProfile?: ClientTokenProfile | null;
    events: IngestObservationsBody["events"];
  },
): Promise<IngestObservationsResponse> {
  // chat-extension H-11b: a `client_health` report is never journaled. The
  // journal keeps the payload and the user forever; this kind is folded into
  // hourly rollups with no user instead (client-health-intake.ts), under the
  // hour the hub received it, so its envelope's observedAt and pageLabel are
  // never read.
  const healthEvents = input.events.filter((event) => event.kind === CLIENT_HEALTH_INGEST_KIND);

  // Validate BEFORE any write so a schema-invalid batch is all-or-nothing 400.
  const observedAts = input.events.map((event, index) =>
    event.kind === CLIENT_HEALTH_INGEST_KIND ? undefined : parseObservedAt(event.observedAt, index));

  const clientProfile = input.clientProfile ?? null;
  if (clientProfile !== null) {
    const kinds = clientTokenIngestKinds(clientProfile);
    for (const [index, event] of input.events.entries()) {
      if (!kinds.includes(event.kind)) {
        throw new InvalidIngestEventError(index, `kind "${event.kind}" is not accepted from this client`);
      }
    }
  }

  const pageScope = input.allowedPageIds === null ? null : new Set(input.allowedPageIds);
  const inScope = (pageId: number) => pageScope === null || pageScope.has(pageId);

  const producer = clientProfile !== null
    ? clientTokenIngestProducer(clientProfile, input.clientVersion)
    : ingestProducerForClientVersion(input.clientVersion);

  // Resolve page labels once per batch. An unknown or out-of-scope label
  // journals with a null account (capture-first) — the fact is not lost over
  // a label typo, and it is never attributed beyond the key's page scope.
  const labels = Array.from(new Set(
    input.events.flatMap((event) => (event.pageLabel ? [event.pageLabel] : [])),
  ));
  const pageByLabel = new Map<string, { id: number; platform: string } | null>();
  for (const label of labels) {
    const stored = await findPageByLabel(app.db, label);
    pageByLabel.set(
      label,
      stored && inScope(stored.page.id)
        ? { id: stored.page.id, platform: stored.page.platform }
        : null,
    );
  }

  // The owner's switch, read only for a batch that carries a health report.
  const healthEnabled = healthEvents.length > 0 && await clientHealthIngestEnabled(app);

  return app.db.transaction(async (tx) => {
    let accepted = 0;
    let duplicates = 0;
    for (const [index, event] of input.events.entries()) {
      if (event.kind === CLIENT_HEALTH_INGEST_KIND) {
        continue;
      }
      const page = event.pageLabel ? pageByLabel.get(event.pageLabel) ?? null : null;
      const kind = ingestKindFor(event.kind);
      const result = await insertObservation(tx, {
        source: "client_capture",
        producer,
        platform: page?.platform ?? null,
        accountId: page?.id ?? null,
        kind,
        parseVersion: stampOnlyParseVersion("client_capture", kind),
        payload: event.payload,
        payloadHash: createHash("sha256").update(JSON.stringify(event.payload)).digest(),
        idempotencyKey: `${input.principalUserId}:${event.clientEventId}`,
        ...(observedAts[index] === undefined ? {} : { observedAt: observedAts[index] }),
        actorPrincipalId: input.principalUserId,
      });
      if (result.inserted) {
        accepted += 1;
      } else {
        duplicates += 1;
      }
    }
    // Last, so the rollup rows are locked only for the moment before the commit.
    const health = await intakeClientHealthReports(app, tx, { events: healthEvents, enabled: healthEnabled });
    return { accepted: accepted + health.accepted, duplicates: duplicates + health.duplicates };
  });
}
