// Stage 11: client-capture lane (core side). The desktop's spool-backed
// uploader posts batches of device-held facts; each event becomes ONE
// observation (source 'client_capture') through the Stage 7 key protocol —
// dedup on <principal>:<clientEventId>, so resend-until-2xx is free. Unknown
// kinds are journaled under desktop.unknown:<kind>, never dropped
// (capture-first). Whole-batch atomic: a failure rolls back every claim, so
// the client resends the whole batch (3c contract).

import { createHash } from "node:crypto";

import {
  findPageByLabel,
  hasHarvestObservationClientEvent,
  insertObservation,
  listOfapiMappedPages,
} from "@agency_hub_core/db";

import type {
  IngestObservationsBody,
  IngestObservationsResponse,
} from "../../../../packages/contracts/src/routes.ts";
import type { ClientTokenProfile } from "@agency_hub_core/contracts";

import type { AppContext } from "../bootstrap.ts";
import { clientTokenIngestKinds, clientTokenIngestProducer } from "./client-token-profile.ts";

// Canonicalizer-backed desktop kinds (Stage 11 §2). Everything else journals
// as desktop.unknown:<kind>.
export const INGEST_KIND_ALLOWLIST: ReadonlySet<string> = new Set([
  "ai_acceptance",
  "guard_audit",
  "send_audit",
  "ai_spend",
  "credit_spend",
  "data_purge_notice",
]);

// Stage 12: the one-time local-DB harvest reuses this lane with
// kind='harvest.<table>' journaled VERBATIM (the reconciliation script keys
// on these exact kinds) and x-client-version='harvest-<app version>' →
// producer='desktop-harvest@<version>' (stage-11 §3 fixed this stamp).
export const HARVEST_KIND_ALLOWLIST: ReadonlySet<string> = new Set([
  "harvest.messages",
  "harvest.fan_transactions",
  "harvest.outbox",
  "harvest.message_guard_events",
  "harvest.usage_events",
  "harvest.ai_spend_log",
  "harvest.credit_log",
]);

const HARVEST_VERSION_PREFIX = "harvest-";
const HARVEST_PRODUCER_PREFIX = "desktop-harvest@";

export function isHarvestClientVersion(clientVersion: string) {
  return clientVersion.startsWith(HARVEST_VERSION_PREFIX);
}

export function ingestProducerForClientVersion(clientVersion: string) {
  return isHarvestClientVersion(clientVersion)
    ? `${HARVEST_PRODUCER_PREFIX}${clientVersion.slice(HARVEST_VERSION_PREFIX.length)}`
    : `desktop@${clientVersion}`;
}

export function isHarvestProducer(producer: string) {
  return producer.startsWith(HARVEST_PRODUCER_PREFIX);
}

// The harvest namespace is producer-gated: harvest.<table> kinds canonicalize
// into real domain events, so only the harvest uploader (x-client-version
// 'harvest-*') may journal them verbatim. Any other client sending a
// harvest.* kind falls into the unknown bucket — captured, never trusted.
function ingestKindFor(kind: string, producer: string) {
  if (INGEST_KIND_ALLOWLIST.has(kind)) {
    return `desktop.${kind}`;
  }
  if (HARVEST_KIND_ALLOWLIST.has(kind) && isHarvestProducer(producer)) {
    return kind;
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
    /** Server-derived from the authenticated device-token row, never a header. */
    authorizedHarvestMachineId: string | null;
    /**
     * chat-extension H-3: the narrow token's profile, from the token row. Set,
     * it admits only the profile's kinds and decides the producer; the header
     * then names only the version, and the harvest lane is out of reach.
     */
    clientProfile?: ClientTokenProfile | null;
    events: IngestObservationsBody["events"];
  },
): Promise<IngestObservationsResponse> {
  // Validate BEFORE any write so a schema-invalid batch is all-or-nothing 400.
  const observedAts = input.events.map((event, index) =>
    parseObservedAt(event.observedAt, index));

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
  const harvestProducer = isHarvestProducer(producer);
  if (harvestProducer && !input.authorizedHarvestMachineId) {
    throw new Error("Harvest producer reached ingest without a server-authorized machine");
  }

  // The capability is token + machine bound. A capable token cannot use a
  // second caller-chosen machine id to escape machine-stable deduplication or
  // inflate reconciliation counts.
  if (harvestProducer) {
    for (const [index, event] of input.events.entries()) {
      if (
        HARVEST_KIND_ALLOWLIST.has(event.kind) &&
        event.payload.machineId !== input.authorizedHarvestMachineId
      ) {
        throw new InvalidIngestEventError(index, "machineId does not match the device harvest capability");
      }
    }
  }

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

  // Stage 12: harvest events carry no pageLabel — the desktop knows its OFAPI
  // account id, not core labels. Resolve payload.ofapiAccountId against
  // pages.ofapi_account_id HERE (the sweep never canonicalizes NULL-account
  // observations, so ingest is the resolution point). Unmappable or
  // out-of-scope accounts journal with NULL and surface in reconciliation
  // (spec assumption 4). The map only exists for the harvest producer — the
  // live lane resolves by label alone.
  const hasHarvestEvents = harvestProducer &&
    input.events.some((event) => HARVEST_KIND_ALLOWLIST.has(event.kind));
  const pageByOfapiAccount = new Map<string, { id: number; platform: string }>();
  if (hasHarvestEvents) {
    for (const page of await listOfapiMappedPages(app.db)) {
      if (inScope(page.id)) {
        pageByOfapiAccount.set(page.ofapiAccountId, { id: page.id, platform: page.platform });
      }
    }
  }

  return app.db.transaction(async (tx) => {
    let accepted = 0;
    let duplicates = 0;
    for (const [index, event] of input.events.entries()) {
      const harvestAccountRef = hasHarvestEvents &&
          HARVEST_KIND_ALLOWLIST.has(event.kind) &&
          typeof event.payload.ofapiAccountId === "string"
        ? pageByOfapiAccount.get(event.payload.ofapiAccountId) ?? null
        : null;
      const page = harvestAccountRef ??
        (event.pageLabel ? pageByLabel.get(event.pageLabel) ?? null : null);
      const kind = ingestKindFor(event.kind, producer);
      const trustedHarvestEvent = harvestProducer && HARVEST_KIND_ALLOWLIST.has(event.kind);
      if (trustedHarvestEvent && await hasHarvestObservationClientEvent(tx, {
        machineId: input.authorizedHarvestMachineId!,
        clientEventId: event.clientEventId,
      })) {
        duplicates += 1;
        continue;
      }
      const result = await insertObservation(tx, {
        source: "client_capture",
        producer,
        platform: page?.platform ?? null,
        accountId: page?.id ?? null,
        kind,
        payload: event.payload,
        payloadHash: createHash("sha256").update(JSON.stringify(event.payload)).digest(),
        idempotencyKey: trustedHarvestEvent
          ? `${input.authorizedHarvestMachineId}:${event.clientEventId}`
          : `${input.principalUserId}:${event.clientEventId}`,
        observedAt: observedAts[index],
        actorPrincipalId: input.principalUserId,
      });
      if (result.inserted) {
        accepted += 1;
      } else {
        duplicates += 1;
      }
    }
    return { accepted, duplicates };
  });
}
