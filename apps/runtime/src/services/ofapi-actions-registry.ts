import type { OfapiAction } from "@agency_hub_core/contracts";
import { ofapiCollectionRequest } from "./ofapi-actions-collections.ts";
import type { OfapiActionRequest } from "./ofapi-actions-types.ts";
export function ofapiActionRequest(command: OfapiAction, accountId: string): OfapiActionRequest {
  return ofapiCollectionRequest(command, accountId);
}
