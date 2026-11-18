import { resolveOfapiCatalogPath } from "@agency_hub_core/shared";
import {
  capturePayloadResponse,
  parseOfapiJsonBytes,
} from "../ofapi-capture-contract.ts";
import {
  normalizeOfapiRead,
  validateOfapiMarketingAccount,
  ofapiReadCoverage,
  ofapiReadRecord,
  validateOfapiCatalogResponse,
} from "../ofapi-read-normalization.ts";
import type {
  CanonicalizableObservation,
  CanonicalEventDraft,
  CanonicalQuarantine,
} from "./types.ts";

export function ofapiReadSnapshotEventKey(observationId: number): string {
  return `ofapi-read:${observationId}:v1`;
}

function captured(observation: CanonicalizableObservation) {
  const response = capturePayloadResponse(observation.payload);
  const request = ofapiReadRecord(
    ofapiReadRecord(observation.payload)?.request,
  );
  if (!response || !request || typeof request.pathname !== "string")
    return null;
  let resolved;
  try {
    resolved = resolveOfapiCatalogPath(
      request.pathname,
      ofapiReadRecord(request.query) ?? {},
      typeof request.scopeAccountId === "string" ? request.scopeAccountId : null,
    );
  } catch {
    return null;
  }
  if (!resolved) return null;
  const parsed = parseOfapiJsonBytes(response.bodyBytes);
  return { response, resolved, parsed };
}
export function canParseOfapiReadObservation(
  observation: CanonicalizableObservation,
) {
  const input = captured(observation);
  return Boolean(
    input &&
      (input.response.status < 200 ||
        input.response.status >= 300 ||
        !input.parsed.validJson ||
        (validateOfapiMarketingAccount(input.resolved.definition, input.parsed.body, input.resolved.accountId) && validateOfapiCatalogResponse(
          input.resolved.definition.operation,
          input.parsed.body,
        ))),
  );
}
/**
 * The family's terminal-quarantine classifier (the driver asks it only about a
 * row that yielded zero events). A 2xx capture whose body is not JSON (a body
 * the vendor cut mid-response) can never be read by any parser: quarantine it
 * on its first visit instead of re-reading it every sweep and holding the
 * family's backlog-age alert open forever.
 */
export function classifyOfapiReadQuarantine(
  observation: CanonicalizableObservation,
): CanonicalQuarantine | null {
  const input = captured(observation);
  return input &&
    input.response.status >= 200 &&
    input.response.status < 300 &&
    !input.parsed.validJson
    ? { code: "ofapi_read_body_not_json" }
    : null;
}
export function canonicalizeOfapiReadObservation(
  observation: CanonicalizableObservation,
): CanonicalEventDraft[] {
  const input = captured(observation);
  if (
    !input ||
    !observation.accountId ||
    input.response.status < 200 ||
    input.response.status >= 300 ||
    !input.parsed.validJson
  )
    return [];
  const { definition: def, pathname, query } = input.resolved;
  if (!validateOfapiMarketingAccount(def, input.parsed.body, input.resolved.accountId)) throw new Error("Marketing response account does not match captured scope");
  const items = normalizeOfapiRead(def, input.parsed.body, pathname).map(item => {
    const resource = ofapiReadRecord(ofapiReadRecord(item)?.resource);
    return resource ? {...item, resource: {...resource, nativeAccountRef: input.resolved.accountId}} : item;
  }),
    coverage = ofapiReadCoverage(def, input.parsed.body, pathname, query);
  return [
    {
      type: "ofapi.read_snapshot_observed",
      occurredAt: observation.receivedAt,
      schemaVersion: 1,
      dedupKey: ofapiReadSnapshotEventKey(observation.id),
      data: {
        pageId: observation.accountId,
        source: "onlyfansapi",
        operation: def.operation,
        category: def.category,
        pathname,
        query,
        observedAt: observation.receivedAt.toISOString(),
        granularity: def.granularity,
        coverage,
        items,
      },
    },
  ];
}
