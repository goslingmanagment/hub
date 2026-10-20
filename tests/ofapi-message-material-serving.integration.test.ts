import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createModel, createOnlyFansPage, createUser, DM_ARCHIVE_ERASURE_FENCE_LOCK_NS,
  insertObservation, listAiTranscriptUnionMessages,
} from "@agency_hub_core/db";

import { materializeOfapiCaptureObservation, OFAPI_CAPTURE_MATERIALIZER_VERSION } from "../apps/runtime/src/services/ofapi-capture-materialization.ts";
import { appendOfapiMessageMaterialPage } from "../apps/runtime/src/services/ofapi-message-material.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { resetIntegrationDatabase, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

let testDb: StartedTestDatabase;
beforeAll(async () => { testDb = await startTestDatabase(); }, 120_000);
afterAll(async () => { await testDb?.stop(); });
beforeEach(async () => { await resetIntegrationDatabase(testDb.pool); });

const CHAT = "555001";
const RECEIVED = new Date("2026-07-16T22:55:30Z");
// Same ordering/overlap shape as the incident, with synthetic IDs and text.
const ITEMS = [
  { id: "11470000000001", createdAt: "2026-07-16T22:50:44Z", isSentByMe: true, text: "older model reply" },
  { id: "11470000000002", createdAt: "2026-07-16T22:53:52Z", isSentByMe: false, text: "new fan message" },
  { id: "11470000000003", createdAt: "2026-07-16T22:54:40Z", isSentByMe: false, text: "latest fan message" },
];

async function fixture(input?: { pageId?: number; receivedAt?: Date; items?: typeof ITEMS }) {
  const label = `material-${randomUUID()}`;
  let pageId = input?.pageId;
  if (pageId === undefined) {
    const model = await createModel(testDb.db, { slug: label, name: label });
    if (!model) throw new Error("model seed failed");
    const page = await createOnlyFansPage(testDb.db, { modelId: model.id, label });
    if (!page) throw new Error("page seed failed");
    pageId = page.id;
  }
  const payload = {
    request: { pathname: `/acct_test/chats/${CHAT}/messages`, query: { order: "asc", last_id: ITEMS[0]!.id } },
    response: { status: 200, headers: {}, bodyEncoding: "utf8",
      body: JSON.stringify({ data: input?.items ?? ITEMS, _pagination: { next_page: null } }) },
  };
  const inserted = await insertObservation(testDb.db, {
    source: "ofapi_capture", producer: "ofapi-mirror-interactive", platform: "onlyfans",
    accountId: pageId, nativeAccountRef: "acct_test", kind: "ofapi.interactive_response.v1",
    payload, payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
    idempotencyKey: randomUUID(), receivedAt: input?.receivedAt ?? RECEIVED,
  });
  const app = createTestAppContext(testDb);
  return {
    app, pageId,
    row: { id: inserted.observationId, receivedAt: inserted.receivedAt,
      producer: "ofapi-mirror-interactive", accountId: pageId, payload },
  };
}

async function parseVersion(id: number) {
  return (await testDb.pool.query("select parse_version from observations where id = $1", [id])).rows[0]?.parse_version;
}

async function transcript(pageId: number) {
  return listAiTranscriptUnionMessages(testDb.db, { pageId, conversationRef: CHAT });
}

describe("captured OFAPI material serving", () => {
  it("commits an inclusive ascending tail directly to AI without claiming history coverage or advancing the sweep", async () => {
    const f = await fixture();
    expect(await materializeOfapiCaptureObservation(f.app, f.row)).toMatchObject({
      kind: "materialized", itemCount: 3, dropped: 0,
    });
    expect((await transcript(f.pageId)).map(row => row.textPlain)).toEqual(ITEMS.map(row => row.text).reverse());
    expect(await parseVersion(f.row.id)).toBe(OFAPI_CAPTURE_MATERIALIZER_VERSION);
    const invariant = await testDb.pool.query(`select
      (select count(*)::int from ofapi_message_coverage) as coverage,
      (select count(*)::int from projection_seq_watermarks) as watermarks`);
    expect(invariant.rows).toEqual([{ coverage: 0, watermarks: 0 }]);
  });

  it("projects deduped ledger events after a crash between append and serving; replays never resurrect tombstones", async () => {
    const f = await fixture();
    await appendOfapiMessageMaterialPage(testDb.db, {
      accountId: f.pageId, observationId: f.row.id, observationReceivedAt: RECEIVED,
      chatId: CHAT, originClass: "capture_interactive", items: ITEMS,
    });
    expect(await transcript(f.pageId)).toHaveLength(0);
    expect(await materializeOfapiCaptureObservation(f.app, f.row)).toMatchObject({
      kind: "materialized", appended: 0, deduped: 3,
    });
    expect(await transcript(f.pageId)).toHaveLength(3);
    await testDb.pool.query("update message_archive set deleted_at = now() where message_ref = $1", [ITEMS[2]!.id]);
    await materializeOfapiCaptureObservation(f.app, f.row);
    expect((await transcript(f.pageId)).map(row => row.messageRef)).toEqual(ITEMS.slice(0, 2).map(row => row.id).reverse());
    expect((await testDb.pool.query("select count(*)::int n from domain_events where type = 'message.material_observed'")).rows[0]?.n).toBe(3);
  });

  it("leaves raw capture retryable and rolls back the ledger if serving fails", async () => {
    const f = await fixture();
    await testDb.pool.query(`create function test_reject_material() returns trigger language plpgsql as $$
      begin raise exception 'injected serving failure'; end $$;
      create trigger test_reject_material before insert on message_archive
      for each row execute function test_reject_material()`);
    try {
      await expect(materializeOfapiCaptureObservation(f.app, f.row)).rejects.toThrow();
      expect(await parseVersion(f.row.id)).toBe(0);
      expect((await testDb.pool.query("select count(*)::int n from domain_events")).rows[0]?.n).toBe(0);
    } finally {
      await testDb.pool.query("drop trigger test_reject_material on message_archive; drop function test_reject_material()");
    }
    await materializeOfapiCaptureObservation(f.app, f.row);
    expect(await transcript(f.pageId)).toHaveLength(3);
  });

  it("does not overwrite a newer captured edit when an old ascending tail is repaired later", async () => {
    const old = await fixture();
    const fresh = await fixture({ pageId: old.pageId, receivedAt: new Date("2026-07-16T22:56Z"),
      items: ITEMS.map(item => ({ ...item, text: `edited ${item.text}` })) });
    await materializeOfapiCaptureObservation(fresh.app, fresh.row);
    await materializeOfapiCaptureObservation(old.app, old.row);
    expect((await transcript(old.pageId)).map(row => row.textPlain)).toEqual(
      ITEMS.map(item => `edited ${item.text}`).reverse(),
    );
  });

  it("defers during erasure, drops erased historical material and permits new messages after the fence", async () => {
    const f = await fixture();
    const client = await testDb.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1::int, $2::int)", [DM_ARCHIVE_ERASURE_FENCE_LOCK_NS, f.pageId]);
      expect(await materializeOfapiCaptureObservation(f.app, f.row)).toEqual({ kind: "deferred" });
      expect(await parseVersion(f.row.id)).toBe(0);
    } finally {
      await client.query("rollback");
      client.release();
    }
    const owner = await createUser(testDb.db, { username: "owner", role: "owner", passwordHash: "x" });
    await testDb.pool.query(`insert into erasure_log(scope_type, scope_ref, initiated_by, dry_run, plan, started_at)
      values ('fan', $1, $2, false, '{}', '2026-07-16T23:00Z')`, [`fan:onlyfans:${CHAT}`, owner!.id]);
    expect(await materializeOfapiCaptureObservation(f.app, f.row)).toMatchObject({ kind: "materialized", dropped: 3 });
    expect(await transcript(f.pageId)).toHaveLength(0);
    const fresh = await fixture({ pageId: f.pageId, receivedAt: new Date("2026-07-16T23:10Z"),
      items: [{ id: "11470000000004", createdAt: "2026-07-16T23:09Z", isSentByMe: false, text: "after erasure" }] });
    await materializeOfapiCaptureObservation(f.app, fresh.row);
    expect((await transcript(f.pageId)).map(row => row.textPlain)).toEqual(["after erasure"]);
  });
});
