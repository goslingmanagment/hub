import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { capturePayloadRefFromColumns, fanslyDmReaderHeadKey, findPageByLabel,
  isDmArchiveScopeFenced, queryFanslyDmReaderHeads, tryAcquireDmArchiveWriterFenceLock,
  type Database } from "@agency_hub_core/db";
import { extractFanslyWsHints, FANSLY_WS_CAPTURE_KIND, wsJson, wsObject } from "@agency_hub_core/shared";
import type { AppContext } from "../bootstrap.ts";
import { resolveCapturePayloadRow } from "./payload-reader.ts";
import { assertFanslyPage } from "./fansly-page.ts";

const nativeId = z.string().regex(/^[0-9]{1,32}$/);
const requestSchema = z.object({ pageLabel: z.string().min(1), targets: z.array(z.object({
  observationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  groupRef: nativeId, messageRef: nativeId,
}).strict()).min(1).max(20) }).strict();
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** A bounded dry run, never a projector. Absence, detached material and
 * ambiguous custody are explicit blockers, not permission to synthesize a thread. */
export async function buildFanslyWsRecoveryManifest(app: Pick<AppContext, "db" | "logger">, request: unknown) {
  const input = requestSchema.parse(request);
  const stored = await findPageByLabel(app.db, input.pageLabel);
  if (!stored) throw new Error("fansly_ws_manifest_page_missing");
  assertFanslyPage(stored.page, "fansly_ws_manifest_requires_fansly");
  const pageId = stored.page.id;
  return app.db.transaction(async tx => {
    const db = tx as unknown as Database;
    await db.execute(sql`set local statement_timeout = '5s'`);
    if (!await tryAcquireDmArchiveWriterFenceLock(db, pageId)) throw new Error("fansly_ws_manifest_erasure_busy");
    const readers = await queryFanslyDmReaderHeads(db, pageId, input.targets.map(target => ({
      conversationRef: target.groupRef, messageId: target.messageRef,
    })));
    const items = [];
    for (const target of input.targets) {
      const reader = readers.get(fanslyDmReaderHeadKey({ conversationRef: target.groupRef, messageId: target.messageRef })) ?? null;
      const rows = await db.execute<{
        event_id: string; received_at: string; generation: string | null; outcome: string;
        native_account_ref: string | null; payload: unknown; bucket: string | null; object_id: string | null;
        decode_state: string | null;
      }>(sql`select r.event_id::text, r.received_at, r.generation, r.outcome,
        o.native_account_ref, o.payload, to_char(o.payload_bucket_month, 'YYYY-MM-DD') as bucket,
        o.payload_object_id::text as object_id, d.state as decode_state
        from fansly_ws_hint_receipts r left join observations o
          on o.id=r.observation_id and o.received_at=r.received_at and o.account_id=r.page_id
          and o.source='fansly_ws' and o.platform='fansly' and o.kind=${FANSLY_WS_CAPTURE_KIND}
        left join fansly_ws_decode_receipts d on d.observation_id=r.observation_id and d.page_id=r.page_id
        where r.page_id=${pageId} and r.observation_id=${target.observationId}
          and r.group_ref=${target.groupRef} and r.message_ref=${target.messageRef}
          and r.hint_type='message_created' limit 2`);
      const row = rows.rows[0];
      if (rows.rows.length !== 1 || !row) {
        items.push({ ...target, reader, blockers: [row ? "ambiguous_receipt" : "receipt_missing"] }); continue;
      }
      const receivedAt = new Date(row.received_at);
      const membership = await db.execute(sql`select is_visible, fan_id is not null as identity_resolved,
        partner_platform_user_id as partner_ref, metadata->>'messageSyncExcludedReason' as excluded_reason
        from page_dm_threads where platform_account_id=${pageId} and platform_conversation_id=${target.groupRef}`);
      const refs = [target.groupRef, String(membership.rows[0]?.partner_ref ?? "")].filter(Boolean);
      if (await isDmArchiveScopeFenced(db, { pageId, platform: "fansly", refs, materialAt: receivedAt })) {
        items.push({ ...target, reader, blockers: ["owner_erased"] }); continue;
      }
      let payload: unknown;
      try {
        payload = (await resolveCapturePayloadRow({ ...app, db }, "observation", target.observationId, {
          payload: row.payload, payloadRef: capturePayloadRefFromColumns(row.bucket, row.object_id),
        })).payload;
      } catch {
        items.push({ ...target, reader, blockers: ["payload_unavailable"] }); continue;
      }
      const envelope = wsObject(payload);
      const frame = envelope?.codec === FANSLY_WS_CAPTURE_KIND && typeof envelope.frame === "string" ? envelope.frame : null;
      if (!frame) { items.push({ ...target, reader, blockers: ["payload_unavailable"] }); continue; }
      const nodes = extractFanslyWsHints(frame, new Set(["message_created"])).filter(node =>
        node.hint?.groupRef === target.groupRef && node.hint.messageRef === target.messageRef);
      if (nodes.length !== 1) { items.push({ ...target, reader, blockers: ["raw_address_unconfirmed"] }); continue; }
      let encoded: unknown = frame;
      for (const index of nodes[0]!.path) {
        const children = wsJson(wsObject(encoded)?.d);
        encoded = Array.isArray(children) ? children[index] : null;
      }
      const message = wsObject(wsObject(wsObject(wsObject(encoded)?.d)?.event)?.message);
      const senderRef = typeof message?.senderId === "string" && /^[0-9]{1,32}$/.test(message.senderId) ? message.senderId : null;
      const createdAtMs = typeof message?.createdAt === "number" && Number.isSafeInteger(message.createdAt)
        && message.createdAt > 0 && message.createdAt <= 8.64e15 ? message.createdAt : null;
      if (await isDmArchiveScopeFenced(db, { pageId, platform: "fansly", refs: [...refs, senderRef],
        materialAt: new Date(Math.min(receivedAt.getTime(), createdAtMs ?? Infinity)) })) {
        items.push({ ...target, reader, blockers: ["owner_erased"] }); continue;
      }
      const mutations = await db.execute(sql`select event_id::text, observation_id::text, received_at,
        group_ref=${target.groupRef} as same_group, generation=${row.generation} as same_generation
        from fansly_ws_hint_receipts where page_id=${pageId} and message_ref=${target.messageRef}
          and outcome='mutation_debt' and received_at>=${row.received_at}
        order by received_at,event_id limit 21`);
      const content = typeof message?.content === "string" ? message.content : null;
      items.push({ ...target, receivedAt: receivedAt.toISOString(), generation: row.generation,
        sourceEventId: row.event_id, decodeState: row.decode_state, routingOutcome: row.outcome,
        nativeAccountRef: row.native_account_ref, custodyProof: "stored_expected_identity_only",
        reader, membership: membership.rows[0] ?? null, sourcePath: nodes[0]!.path,
        frameSha256: hash(frame), senderRef, createdAt: createdAtMs === null ? null : new Date(createdAtMs).toISOString(),
        textLength: content?.length ?? null,
        laterMutations: mutations.rows.slice(0, 20), mutationsTruncated: mutations.rows.length > 20,
        blockers: ["ws_archive_projector_not_enabled",
          ...(row.native_account_ref !== stored.page.platformAccountId ? ["native_binding_changed"] : []),
          ...(envelope?.generation !== row.generation || row.generation === null ? ["generation_unconfirmed"] : []),
          ...(senderRef === null || createdAtMs === null ? ["normalization_identity_or_time_missing"] : []),
        ],
      });
    }
    return { schemaVersion: 1, generatedAt: new Date().toISOString(), pageId, pageLabel: input.pageLabel,
      mode: "read_only", items, recoveryApplied: false };
  }, { accessMode: "read only" });
}
