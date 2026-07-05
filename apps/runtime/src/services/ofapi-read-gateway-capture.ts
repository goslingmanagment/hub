// Read-gateway capture tee (Stage 9, producer 4). Every successful proxied
// response is journaled ASYNCHRONOUSLY — enqueue is O(1) on the chatter's
// latency path, a single drainer inserts observations afterwards. Fail-open
// is acceptable HERE ONLY (proxied reads recur; webhook/pull/command/operator
// producers stay fail-closed): a full queue or a failed insert increments the
// dropped counter and raises an incident once the drops accumulate, so the
// gap is visible, never silent.

import { createHash, randomUUID } from "node:crypto";

import { insertObservation } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { notifyOfapiGlobalIncident } from "./notification-incidents.ts";

type TeeApp = Pick<AppContext, "db" | "logger" | "config">;

export interface ReadGatewayCaptureEntry {
  app: TeeApp;
  principalUserId: number;
  pageId: number;
  /** The allowlisted path-template operation — the observation kind. */
  operation: string;
  status: number;
  body: unknown;
}

const DEFAULT_QUEUE_CAP = 500;
const DEFAULT_DROP_INCIDENT_THRESHOLD = 25;

let queueCap = DEFAULT_QUEUE_CAP;
let dropIncidentThreshold = DEFAULT_DROP_INCIDENT_THRESHOLD;
const queue: ReadGatewayCaptureEntry[] = [];
let drainPromise: Promise<void> | null = null;
let droppedCaptures = 0;
let incidentRaised = false;

export function getReadGatewayCaptureDroppedCount() {
  return droppedCaptures;
}

/** Test seam: shrink the cap/threshold and reset counters between cases. */
export function configureReadGatewayCaptureForTests(input?: {
  queueCap?: number;
  dropIncidentThreshold?: number;
}) {
  queueCap = input?.queueCap ?? DEFAULT_QUEUE_CAP;
  dropIncidentThreshold = input?.dropIncidentThreshold ?? DEFAULT_DROP_INCIDENT_THRESHOLD;
  queue.length = 0;
  droppedCaptures = 0;
  incidentRaised = false;
}

function recordDrop(app: TeeApp) {
  droppedCaptures += 1;
  if (droppedCaptures >= dropIncidentThreshold && !incidentRaised) {
    incidentRaised = true;
    void notifyOfapiGlobalIncident(app, {
      kind: "read_gateway_capture",
      errorSummary:
        `Read-gateway capture tee dropped ${droppedCaptures} responses (queue cap ${queueCap})`,
    }).catch(() => {
      // Incident delivery is itself best-effort; the counter remains.
      incidentRaised = false;
    });
  }
}

/**
 * O(1) enqueue, called after the reply is already on its way to the chatter.
 * Returns false when the entry was dropped (queue full).
 */
export function enqueueReadGatewayCapture(entry: ReadGatewayCaptureEntry): boolean {
  if (queue.length >= queueCap) {
    recordDrop(entry.app);
    return false;
  }
  queue.push(entry);
  void drainReadGatewayCaptureQueue();
  return true;
}

/** Awaiting joins the in-flight drain, so tests observe a settled queue. */
export function drainReadGatewayCaptureQueue(): Promise<void> {
  if (!drainPromise) {
    drainPromise = (async () => {
      try {
        while (queue.length > 0) {
          const entry = queue.shift()!;
          try {
            await insertObservation(entry.app.db, {
              source: "readthrough",
              producer: "read-gateway",
              platform: "onlyfans",
              accountId: entry.pageId,
              kind: entry.operation,
              // The response body verbatim — the fact a credit was spent on.
              payload: entry.body ?? null,
              payloadHash: createHash("sha256")
                .update(JSON.stringify(entry.body ?? null))
                .digest(),
              // Each proxied response is its own fact (no natural idempotency
              // key); retries of the CHATTER'S request are distinct spends.
              idempotencyKey: `rg:${randomUUID()}`,
              actorPrincipalId: entry.principalUserId,
            });
          } catch (error) {
            entry.app.logger.warn(
              { err: error, operation: entry.operation, pageId: entry.pageId },
              "Read-gateway capture insert failed; response served, capture dropped",
            );
            recordDrop(entry.app);
          }
        }
      } finally {
        drainPromise = null;
        // An enqueue that raced the loop's empty-check would otherwise sit
        // until the next request; re-kick for it.
        if (queue.length > 0) {
          void drainReadGatewayCaptureQueue();
        }
      }
    })();
  }
  return drainPromise;
}
