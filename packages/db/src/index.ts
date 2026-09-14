export * from "./client.ts";
export * from "./schema.ts";
export * from "./repositories/creator-raw-media.ts";
export * from "./repositories/vault-album-scans.ts";
export * from "./repositories/ofapi-post-media-replay.ts";
export * from "./repositories/ofapi-credit-receipts.ts";
export * from "./schema-guard.ts";
export * from "./capture-payload-codec.ts";
// G5 slice 3a: pure derivations for the typed queryable columns. No database
// access, no body reads — safe on the barrel, and exported so the historical
// rewrite slice populates the same columns from the same functions.
export * from "./capture-queryable-fields.ts";
// Capture payload catalog: the WRITER and the METADATA, never the body reader.
// `loadPayloadBody` takes a bare (bucket_month, object_id) — an address that
// carries none of the authorization the envelope carries, and one object may be
// shared by several envelopes. On the barrel it would be a public, unauthorized
// read of any body, restricted_ai included, straight past the envelope seam in
// apps/runtime/src/services/payload-reader.ts. It stays repository-internal
// (same law as the agent-read witness mint helpers above); the pointer slice
// reaches it from inside packages/db, not from a runtime caller.
// `tests/capture-payload-barrel.test.ts` pins this export list.
// G5 slice 2 adds `readEnvelopeCapturePayload`: the seam's ONE body read, and
// barrel-safe for the reason the bare reader is not — it cannot be called
// without naming the envelope class the reference was read off, and it refuses
// any representation that envelope class does not store.
export {
  CAPTURE_PAYLOAD_ACCESS_CLASSES,
  CAPTURE_PAYLOAD_ENVELOPE_KINDS,
  CAPTURE_PAYLOAD_ERASURE_DOMAINS,
  CAPTURE_PAYLOAD_LANES,
  CAPTURE_PAYLOAD_STORAGE_TIERS,
  capturePayloadBucketMonth,
  capturePayloadRefFromColumns,
  classifyCapturePayloadScope,
  // G5 slice 3c-2: monthly catalog partitions for HISTORICAL months. Barrel-safe
  // — it is DDL over the catalog's own partitions and returns names, never bytes.
  ensureCapturePayloadCatalogPartitions,
  getPayloadObject,
  putPayloadObject,
  readEnvelopeCapturePayload,
  readEnvelopeCapturePayloadBatch,
} from "./repositories/capture-payloads.ts";
export type {
  CapturePayloadAccessClass,
  CapturePayloadBody,
  CapturePayloadEnvelopeKind,
  CapturePayloadErasureDomain,
  CapturePayloadLane,
  CapturePayloadObjectRow,
  CapturePayloadRef,
  CapturePayloadScope,
  CapturePayloadStorageTier,
  EnvelopeCapturePayloadRead,
  EnvelopeCapturePayloadBatchRead,
  PutPayloadObjectContent,
  PutPayloadObjectInput,
  PutPayloadObjectResult,
} from "./repositories/capture-payloads.ts";
// The parity verifier is barrel-safe: it takes no object id from a caller and
// returns COUNTS and reference ids, never a body. Its own read of the body
// stays inside packages/db, which is exactly the boundary the note above draws.
export * from "./repositories/capture-payload-parity.ts";
// G5 slice 3b — the catalog plane of the Stage 28.4 erasure. Barrel-safe on the
// SAME terms as the parity verifier and for the same reason: every function
// here takes a scope or a reference list and returns METADATA (which objects
// contain the subject, which of them nothing references any more, which ones
// were deleted). NONE of them returns a body — the subject match is decided in
// SQL, inside the database, so the caller never needs the bytes and an
// "erasure needs to read bodies" back door never has to exist. The `Erasure`
// in every name is load-bearing: these are reachable only from
// apps/runtime/src/services/erasure/**, and the deleter among them is
// enumerated in tests/retention-deleters.test.ts.
// `tests/capture-payload-barrel.test.ts` pins this shape.
export * from "./repositories/capture-payload-erasure.ts";
// G5 slice 3c-2 — the historical rewrite's database half. Barrel-safe on the
// same terms as the parity verifier: the sampler reads bodies to compare them,
// but that read never leaves packages/db and what crosses this boundary is a
// census, a verdict and a bounded mismatch report — never a body. The one
// UPDATE it exposes is licensed in the module header and takes a reference,
// never a payload.
export * from "./repositories/capture-rewrite.ts";
export * from "./repositories/agent-keys.ts";
export * from "./repositories/agent-read-audit.ts";
// Agent Read Plane witnesses: the TYPE and NOTHING ELSE. The mint helpers stay
// unexported from the barrel so a runtime handler cannot claim it read a store it
// never queried — the first review round found four handlers doing exactly that.
// `tests/agent-read-witness-barrel.test.ts` pins this export list.
export type { PlaneReadWitness } from "./repositories/agent-read-witness.ts";
export * from "./repositories/agent-dataset-map.ts";
export * from "./repositories/agent-hydration.ts";
export * from "./repositories/agent-read.ts";
export * from "./repositories/agent-transcript.ts";
export * from "./repositories/ai-transcript-union.ts";
export * from "./repositories/erasure-fence.ts";
export * from "./repositories/catalog.ts";
export * from "./repositories/config-settings.ts";
export * from "./repositories/dm-analytics.ts";
export * from "./repositories/dm-material-fingerprint.ts";
export * from "./repositories/dm-message-candidate.ts";
export * from "./repositories/dm-message-archive.ts";
export * from "./repositories/fans.ts";
export * from "./repositories/auth.ts";
export * from "./repositories/fan-page-identity.ts";
export * from "./repositories/fansly-replay-projection.ts";
export * from "./repositories/fan-profiles.ts";
export * from "./repositories/fan-metadata.ts";
export * from "./repositories/ai-usage.ts";
export * from "./repositories/notifications.ts";
export * from "./repositories/notification-outbox.ts";
export * from "./repositories/observations.ts";
export * from "./repositories/ops-metrics.ts";
export * from "./repositories/access-grants.ts";
export * from "./repositories/domain-events.ts";
export * from "./repositories/canonicalize-sweep.ts";
export * from "./repositories/creator-posts.ts";
export * from "./repositories/message-archive.ts";
export * from "./repositories/media-plane.ts";
export * from "./repositories/fansly-engagement.ts";
export * from "./repositories/fan-earnings-refresh.ts";
export * from "./repositories/fan-earnings-receipts.ts";
export * from "./repositories/fansly-transaction-dirty.ts";
export * from "./repositories/fansly-catalog.ts";
export * from "./repositories/fansly-insights.ts";
export * from "./repositories/post-comments.ts";
export * from "./repositories/page-payouts.ts";
export * from "./repositories/fansly-stats.ts";
export * from "./repositories/ai-personas.ts";
export * from "./repositories/ai-restricted.ts";
export * from "./repositories/erasure.ts";
export * from "./repositories/ofapi.ts";
export * from "./repositories/ofapi-capture.ts";
export * from "./repositories/ofapi-message-coverage.ts";
export * from "./repositories/ofapi-certified-history.ts";
export * from "./repositories/ofapi-commands.ts";
export * from "./repositories/ofapi-sync-snapshot.ts";
export * from "./repositories/onlyfans-public-profiles.ts";
export * from "./repositories/telegram-settings.ts";
export * from "./repositories/reporting.ts";
export * from "./repositories/runtime-instances.ts";
export * from "./repositories/page-dm.ts";
export * from "./repositories/fansly-dm-head-debt.ts";
export * from "./repositories/fansly-dm-shadow.ts";
export * from "./repositories/projection-debt.ts";
export * from "./repositories/spenders.ts";
export * from "./repositories/sync-context.ts";
export * from "./repositories/sync.ts";
export * from "./repositories/top-spenders.ts";
export * from "./repositories/transactions.ts";
export * from "./repositories/transaction-tip-contexts.ts";
export * from "./repositories/voice-notes.ts";
export * from "./repositories/voice-profiles.ts";
export * from "./repositories/workboard-v2.ts";

export * from "./repositories/ofapi-bindings.ts";

export * from "./repositories/ofapi-vendor-usage.ts";
export * from "./repositories/ofapi-collection.ts";
export * from "./repositories/ofapi-webhook-recovery.ts";

export * from "./repositories/ofapi-provider-operations.ts";
export * from "./repositories/ofapi-media-token-fences.ts";
export * from "./repositories/ofapi-banned-words.ts";

export * from "./repositories/ofapi-read-collections.ts";

export * from "./repositories/ofapi-typed-exports.ts";
export { saveOfapiChatQueueState, readOfapiContentEvents } from './repositories/ofapi-content-events.ts';
