import { ofapiAccountActionSchema, ofapiCollectionActionSchema, ofapiPublishingActionSchema, ofapiPublishingAdmissionIssue, type OfapiAction } from "@agency_hub_core/contracts";
import { ofapiAccountRequest, ofapiAccountResultConfirmed } from "./ofapi-actions-account.ts";
import { ofapiCollectionRequest, ofapiCollectionResultConfirmed } from "./ofapi-actions-collections.ts";
import { ofapiPublishingRequest, ofapiPublishingResultConfirmed } from "./ofapi-actions-publishing.ts";
import { asRecord } from "./ofapi-payloads.ts";
import type { OfapiActionRequest } from "./ofapi-actions-types.ts";
export function ofapiActionRequest(command: OfapiAction, accountId: string): OfapiActionRequest {
  const publishing = ofapiPublishingActionSchema.safeParse(command);
  if (publishing.success) return ofapiPublishingRequest(publishing.data, accountId);
  const account = ofapiAccountActionSchema.safeParse(command);
  if (account.success) return ofapiAccountRequest(account.data, accountId);
  return ofapiCollectionRequest(ofapiCollectionActionSchema.parse(command), accountId);
}
export function ofapiActionResultConfirmed(command: OfapiAction, status: number, body: unknown): boolean {
  const publishing = ofapiPublishingActionSchema.safeParse(command);
  if (publishing.success) return ofapiPublishingResultConfirmed(publishing.data, status, body);
  const account = ofapiAccountActionSchema.safeParse(command);
  if (account.success) return ofapiAccountResultConfirmed(account.data, status, body);
  return status === 200 && ofapiCollectionResultConfirmed(ofapiCollectionActionSchema.parse(command), asRecord(body)?.data);
}
export function ofapiActionAdmissionIssue(command: OfapiAction, now: Date): string | null {
  const publishing = ofapiPublishingActionSchema.safeParse(command);
  return publishing.success ? ofapiPublishingAdmissionIssue(publishing.data, now) : null;
}
