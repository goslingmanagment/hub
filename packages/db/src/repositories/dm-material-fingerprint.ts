// Wave 2 corrections — the material fingerprint (build spec, Wave 2 section).
// sha256("dm-material-v1\0" + canonicalJson(material)) over the M3 13-field
// material tuple ONLY: provenance, retention, deleted_at, raw_shape_version
// and updated_at are excluded by definition, so a stale-REST re-observation
// or a changedAt-only touch produces the SAME fingerprint (no-op), while any
// real material change produces a new one. The fingerprint is stored as
// bytea; the HEX form appears only inside superseding-event dedup keys
// (msg:<dir>:<id>:<fpHex>) and event data.
//
// Amendment 8: the OF fingerprint is computed from the REDUCED HEAD (the
// dm_message_archive row after the candidate merge) — never from raw inputs.
// The Fansly repair computes it over the corrected canonical fact (the
// reduced head of a single-source platform IS the fact — design note §2).

import { createHash } from "node:crypto";

const FINGERPRINT_DOMAIN = "dm-material-v1\0";

/** The M3 material tuple as plain JS values. Timestamps as epoch ms; bigints
 * as decimal strings; media as the raw jsonb array SORTED BY id (array order
 * is significant in jsonb compares, so the fingerprint normalizes it the
 * same way the reducer's change guard does). */
export interface DmMaterialTuple {
  senderPlatformUserId: string | null;
  senderRole: string;
  isSentByMe: boolean;
  messageCreatedAt: Date | null;
  textPlain: string;
  priceMills: bigint | null;
  isOpened: boolean | null;
  isTip: boolean;
  tipAmountMills: bigint;
  inReplyToMessageId: string | null;
  platformConversationId: string | null;
  fanPlatformUserId: string | null;
  mediaMetadata: Array<Record<string, unknown>>;
}

/** Deep key-sorted copy — same discipline as the earnings dedup hash: a
 * replacer-array stringify would whitelist keys recursively and silently
 * drop nested fields from the hash. */
export function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonicalJson(record[key])]),
    );
  }
  return value;
}

function sortedMediaById(
  media: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return [...media].sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
}

/** sha256 over the domain-separated canonical JSON of the material tuple. */
export function computeDmMaterialFingerprint(material: DmMaterialTuple): Buffer {
  const canonical = canonicalJson({
    senderPlatformUserId: material.senderPlatformUserId,
    senderRole: material.senderRole,
    isSentByMe: material.isSentByMe,
    messageCreatedAt: material.messageCreatedAt === null
      ? null
      : material.messageCreatedAt.getTime(),
    textPlain: material.textPlain,
    priceMills: material.priceMills === null ? null : material.priceMills.toString(),
    isOpened: material.isOpened,
    isTip: material.isTip,
    tipAmountMills: material.tipAmountMills.toString(),
    inReplyToMessageId: material.inReplyToMessageId,
    platformConversationId: material.platformConversationId,
    fanPlatformUserId: material.fanPlatformUserId,
    mediaMetadata: sortedMediaById(material.mediaMetadata),
  });
  return createHash("sha256")
    .update(FINGERPRINT_DOMAIN)
    .update(JSON.stringify(canonical))
    .digest();
}

/** Hex form — ONLY for dedup keys and event data, never storage. */
export function fingerprintHex(fingerprint: Buffer): string {
  return fingerprint.toString("hex");
}

/** Superseding-event dedup key (spec: msg:<dir>:<id>:<fpHex>). First events
 * keep the canonical msg:<dir>:<id> key — design note §1. */
export function supersedingDedupKey(
  direction: "received" | "sent",
  messageRef: string,
  fingerprint: Buffer,
): string {
  return `msg:${direction}:${messageRef}:${fingerprintHex(fingerprint)}`;
}

/** The generic corrections fingerprint for non-OF facts (the Fansly repair):
 * same domain separation, over an arbitrary canonicalized fact object. */
export function computeFactFingerprint(fact: Record<string, unknown>): Buffer {
  return createHash("sha256")
    .update(FINGERPRINT_DOMAIN)
    .update(JSON.stringify(canonicalJson(fact)))
    .digest();
}
