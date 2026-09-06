import { resolveOfapiCatalogPath } from "@agency_hub_core/shared";
import {
  capturePayloadResponse,
  parseOfapiJsonBytes,
} from "../ofapi-capture-contract.ts";
import {
  normalizeOfapiRead,
  ofapiReadCoverage,
  ofapiReadRecord,
  validateOfapiCatalogResponse,
} from "../ofapi-read-normalization.ts";
import type {
  CanonicalizableObservation,
  CanonicalEventDraft,
} from "./types.ts";
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
        validateOfapiCatalogResponse(
          input.resolved.definition.operation,
          input.parsed.body,
        )),
  );
}
export function canonicalizeOfapiReadObservation(
  observation: CanonicalizableObservation,
): CanonicalEventDraft[] {
  const input = captured(observation);
  if (
    !input ||
    !observation.accountId ||
    input.response.status < 200 ||
    input.response.status >= 300
  )
    return [];
  const { definition: def, pathname, query } = input.resolved;
  const items = normalizeOfapiRead(def, input.parsed.body, pathname),
    coverage = ofapiReadCoverage(def, input.parsed.body, pathname, query);
  return [
    {
      type: "ofapi.read_snapshot_observed",
      occurredAt: observation.receivedAt,
      schemaVersion: 1,
      dedupKey: `ofapi-read:${observation.id}:v1`,
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
