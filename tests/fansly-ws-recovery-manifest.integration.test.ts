import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { insertObservation, routeFanslyWsHintEvent } from "@agency_hub_core/db";
import { FANSLY_WS_CAPTURE_KIND } from "@agency_hub_core/shared";
import { buildFanslyWsRecoveryManifest } from "../apps/runtime/src/services/fansly-ws-recovery-manifest.ts";
import { resetIntegrationDatabase, seedFanslyPage, startTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let db: Awaited<ReturnType<typeof startTestDatabase>>;
beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
afterAll(async () => { await db?.stop(); });
beforeEach(async () => { await resetIntegrationDatabase(db.pool); });
const privateText = "retained private text must never appear in diagnostic output";

// A minute-old message, sent as the frame carries it: epoch seconds, usually
// fractional (prod service-5 frames, 2026-09-28).
async function fixture(createdAtMs = Date.now() - 60_000, createdAt = createdAtMs / 1000) {
  const app = createTestAppContext(db);
  const { page } = await seedFanslyPage(app.db, app.config.encryptionKey);
  if (!page) throw new Error("missing page");
  await db.pool.query("update pages set external_page_id='999' where id=$1", [page.id]);
  const generation = "a".repeat(64);
  const frame = JSON.stringify({ t: 10001, d: [JSON.stringify({ t: 10000, d: {
    serviceId: 5, event: { type: 1, message: { id: "150", groupId: "100", senderId: "111",
      createdAt, content: privateText } },
  } })] });
  const receivedAt = new Date();
  const captured = await insertObservation(db.db, { source: "fansly_ws", producer: "fansly:b0", platform: "fansly",
    accountId: page.id, nativeAccountRef: "999", kind: FANSLY_WS_CAPTURE_KIND,
    payload: { codec: FANSLY_WS_CAPTURE_KIND, frame, generation },
    payloadHash: createHash("sha256").update(frame).digest(), idempotencyKey: "manifest-fixture", receivedAt });
  await routeFanslyWsHintEvent(db.db, { id: 1, pageId: page.id, observationId: captured.observationId,
    receivedAt: captured.receivedAt, generation,
    node: { path: [0], outcome: "hint", hint: { type: "message_created", groupRef: "100", messageRef: "150" } },
  }, null);
  const request = { pageLabel: page.label, targets: [{ observationId: captured.observationId, groupRef: "100", messageRef: "150" }] };
  const manifest = () => buildFanslyWsRecoveryManifest(app, request);
  const counts = async () => (await db.pool.query(`select
    (select count(*) from observations) as observations,
    (select count(*) from page_dm_threads) as threads,
    (select count(*) from message_archive) as archive,
    (select count(*) from fansly_ws_hint_receipts) as receipts,
    (select count(*) from config_audit_log) as audits`)).rows[0];
  return { app, page, generation, request, manifest, counts, createdAtMs };
}

describe("bounded read-only WS recovery manifest", () => {
  it("checks nested retained raw and reader absence without printing text or inventing membership", async () => {
    const f = await fixture(); const before = await f.counts();
    const result = await f.manifest();
    expect(result).toMatchObject({ mode: "read_only", recoveryApplied: false, items: [{
      reader: { state: "missing" }, membership: null, sourcePath: [0],
      textLength: privateText.length, createdAt: new Date(f.createdAtMs).toISOString(),
      custodyProof: "stored_expected_identity_only", blockers: ["ws_archive_projector_not_enabled"],
    }] });
    expect(JSON.stringify(result)).not.toContain(privateText);
    expect(result.items[0]).not.toHaveProperty("textSha256");
    expect(await f.counts()).toEqual(before);
  });
  it("reports wrong addresses and missing receipts as unknown instead of raw recovery", async () => {
    const f = await fixture(); f.request.targets[0]!.groupRef = "200";
    expect((await f.manifest()).items[0]).toMatchObject({ blockers: ["receipt_missing"] });
  });
  it("keeps later source deletion separate from actual reader materialization", async () => {
    const f = await fixture();
    await routeFanslyWsHintEvent(db.db, { id: 2, pageId: f.page.id, observationId: 999,
      receivedAt: new Date(), generation: f.generation,
      node: { path: [], outcome: "mutation_debt", mutation: { messageRef: "150", groupRef: "100", bulk: false, correlationRef: null } },
    }, null);
    expect((await f.manifest()).items[0]).toMatchObject({ reader: { state: "missing" },
      laterMutations: [{ same_group: true, same_generation: true }] });
  });
  it("uses canonical reader precedence for materialized and tombstoned messages", async () => {
    const f = await fixture();
    await db.pool.query(`insert into message_archive(account_id,platform,conversation_ref,message_ref,occurred_at,content_pending)
      values ($1,'fansly','100','150',now(),false)`, [f.page.id]);
    expect((await f.manifest()).items[0]).toMatchObject({ reader: { state: "materialized", source: "message_archive" } });
    await db.pool.query("update message_archive set deleted_at=now() where account_id=$1", [f.page.id]);
    expect((await f.manifest()).items[0]).toMatchObject({ reader: { state: "deleted" } });
  });
  it("suppresses raw-derived metadata under an owner erasure fence", async () => {
    const f = await fixture();
    const user = (await db.pool.query("insert into users(username,role) values ('manifest-owner','owner') returning id")).rows[0];
    await db.pool.query(`insert into erasure_log(scope_type,scope_ref,initiated_by,dry_run,plan)
      values ('fan','fan:fansly:111',$1,false,$2)`, [user.id, JSON.stringify({ resolvedFanGroupIds: ["100"] })]);
    const result = await f.manifest();
    expect(result.items[0]).toMatchObject({ blockers: ["owner_erased"] });
    expect(result.items[0]).not.toHaveProperty("textSha256");
  });
  it("fences whole-second material at its own time, not at a 1970 instant", async () => {
    const createdAtMs = Math.floor((Date.now() - 60_000) / 1000) * 1000;
    const f = await fixture(createdAtMs, createdAtMs / 1000);
    const user = (await db.pool.query("insert into users(username,role) values ('manifest-owner','owner') returning id")).rows[0];
    // An erasure that finished before this message existed does not cover it.
    await db.pool.query(`insert into erasure_log(scope_type,scope_ref,initiated_by,dry_run,plan,started_at)
      values ('fan','fan:fansly:111',$1,false,$2,now() - interval '1 hour')`,
    [user.id, JSON.stringify({ resolvedFanGroupIds: ["100"] })]);
    expect((await f.manifest()).items[0]).toMatchObject({
      createdAt: new Date(createdAtMs).toISOString(), blockers: ["ws_archive_projector_not_enabled"],
    });
  });
  it("enforces the exact bounded input", async () => {
    const f = await fixture();
    await expect(buildFanslyWsRecoveryManifest(f.app, { ...f.request, targets: Array(21).fill(f.request.targets[0]) })).rejects.toThrow();
    await expect(buildFanslyWsRecoveryManifest(f.app, { ...f.request, execute: true })).rejects.toThrow();
  });
});
