import { sha256Hex } from "@agency_hub_core/shared";
import { lifecycleTimestamp } from "../ofapi-lifecycle-contract.ts";
import {
  isRecord,
  type CanonicalEventDraft,
  type CanonicalizableObservation,
} from "./types.ts";
export const OFAPI_CONTENT_KINDS = [
  "posts.liked",
  "chat_queue.updated",
  "chat_queue.finished",
] as const;
function exactId(value: unknown): string | null {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return typeof value === "string" && /^[0-9]{1,30}$/.test(value)
    ? value
    : null;
}
/** Only the explicit post placeholder is attributed. Notification/user IDs are different namespaces. */
export function ofapiLikedPostRef(
  payload: Record<string, unknown>,
): string | null {
  const pairs = isRecord(payload.replacePairs) ? payload.replacePairs : {};
  const link = pairs["{POST_LINK}"];
  if (typeof link !== "string" || link.length > 4000) return null;
  const matches = [...link.matchAll(/\bhref\s*=\s*(["'])([^"']+)\1/gi)];
  if (matches.length !== 1) return null;
  try {
    const url = new URL(matches[0]![2]!);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "onlyfans.com" ||
      url.username ||
      url.password ||
      url.port
    )
      return null;
    const match = /^\/([0-9]{1,30})\/[A-Za-z0-9_.-]+\/?$/.exec(url.pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
export function canonicalizeOfapiContentObservation(
  observation: CanonicalizableObservation,
): CanonicalEventDraft[] {
  if (!isRecord(observation.payload) || !isRecord(observation.payload.payload))
    return [];
  const payload = observation.payload.payload;
  const id = exactId(payload.id);
  if (!id) return [];
  const observedAt = observation.receivedAt.toISOString();
  if (observation.kind === "posts.liked") {
    const user = isRecord(payload.user) ? payload.user : {};
    const fanRef = exactId(user.id),
      sourceAt = lifecycleTimestamp(payload.createdAt);
    if (!fanRef || !sourceAt) return [];
    const postRef = ofapiLikedPostRef(payload);
    const data = {
      notificationRef: id,
      postRef,
      likerRef: fanRef,
      sourceAt: sourceAt.toISOString(),
      observedAt,
      attribution: postRef ? "explicit_post_link" : "unattributed",
      source: "onlyfansapi",
      timeBasis: "provider",
      state: "active",
    };
    return [
      {
        type: "ofapi.post_like_observed",
        occurredAt: sourceAt,
        fanIdentityRef: fanRef,
        postRef,
        schemaVersion: 1,
        dedupKey: `ofapi-post-like:${id}`,
        data: { ...data, contentHash: sha256Hex(JSON.stringify(data)) },
      },
    ];
  }
  if (
    observation.kind !== "chat_queue.updated" &&
    observation.kind !== "chat_queue.finished"
  )
    return [];
  const queueDate = lifecycleTimestamp(payload.date);
  const optionalCount = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : null;
  const optionalFlag = (value: unknown) =>
    typeof value === "boolean" ? value : null;
  const data = {
    queueId: id,
    phase: observation.kind === "chat_queue.finished" ? "finished" : "updated",
    queueDate: queueDate?.toISOString() ?? null,
    isDone: optionalFlag(payload.isDone),
    isCanceled: optionalFlag(payload.isCanceled),
    hasError: optionalFlag(payload.hasError),
    isReady: optionalFlag(payload.isReady),
    canUnsend: optionalFlag(payload.canUnsend),
    pending: optionalCount(payload.pending),
    total: optionalCount(payload.total),
    unsendSeconds: optionalCount(payload.unsendSeconds),
    source: "onlyfansapi",
    timeBasis: "receipt",
    observedAt,
  };
  // The provider's queue date describes the queue, not its progress clock. Do not fabricate event order from it.
  const { observedAt: _receipt, ...stable } = data;
  void _receipt;
  const contentHash = sha256Hex(JSON.stringify(stable));
  return [
    {
      type: "ofapi.chat_queue_observed",
      occurredAt: observation.receivedAt,
      schemaVersion: 1,
      dedupKey: `ofapi-queue:${id}:${contentHash}`,
      data: { ...data, contentHash },
    },
  ];
}
