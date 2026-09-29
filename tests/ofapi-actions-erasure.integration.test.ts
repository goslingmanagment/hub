import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createModel, createOnlyFansPage, insertObservation } from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";
import { executeErasure, planErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { ndjsonToParquet, readParquetIds } from "../apps/runtime/src/services/tiering/index.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

let database: StartedTestDatabase;
let app: ReturnType<typeof createTestAppContext>;
let ownerId: number;
let lakeDir: string;

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Postgres is required for action erasure regressions");
  database = started;
}, 120_000);
afterAll(async () => { await database?.stop(); if (lakeDir) await rm(lakeDir, { recursive: true, force: true }); });
beforeEach(async () => {
  if (lakeDir) await rm(lakeDir, { recursive: true, force: true });
  await resetIntegrationDatabase(database.pool);
  app = createTestAppContext(database);
  lakeDir = await mkdtemp(path.join(tmpdir(), "ofapi-action-erasure-"));
  app.config.lakeDir = lakeDir;
  ownerId = Number((await database.pool.query<{ id: string }>(
    "insert into users(username,role) values('action-erasure-owner','owner') returning id::text",
  )).rows[0]!.id);
});

async function page(slug: string) {
  const model = await createModel(database.db, { slug, name: slug });
  const created = await createOnlyFansPage(database.db, { modelId: model!.id, label: `${slug}-page` });
  if (!created) throw new Error("Expected OnlyFans page");
  return created;
}

async function seedAction(pageId: number, subjectRefs: string[], prepared = false, responseData?: unknown) {
  const id = randomUUID();
  const secret = { notes: "Private native note without any plaintext subject identifier" };
  const command = subjectRefs.length > 1 ? { action: "user_list_add_users", pageId, listId: "456", ids: subjectRefs }
    : subjectRefs.length ? { action: "fan_notes_update", pageId, fanId: subjectRefs[0], notes: secret.notes }
      : { action: "user_list_clear", pageId, listId: "456" };
  const frozen = { command, accountId: `acct_${pageId}`, generation: 1, credential: "synthetic", pageLabel: "Test page" };
  const cipher = JSON.stringify(encryptJson(frozen, app.config.encryptionKey, app.config.encryptionKeyVersion));
  const encryptedBody = encryptJson({ frozen, actorUserId: ownerId, headers: {},
    bodyBase64: Buffer.from(JSON.stringify({ data: responseData ?? { id: "456", notes: secret.notes } })).toString("base64"),
  }, app.config.encryptionKey, app.config.encryptionKeyVersion);
  await database.pool.query(
    `insert into ofapi_action_intents(id,page_id,actor_user_id,action,body_hash,body_encrypted,
       state,estimated_credits,result_encrypted,subject_refs)
     values($1,$2,$3,$4,$5,$6,$7,1,$8,$9::text[])`,
    [id, pageId, ownerId, command.action,
      createHash("sha256").update(cipher).digest("hex"), cipher, prepared ? "prepared" : "confirmed",
      prepared ? null : cipher, subjectRefs],
  );
  let observationId: number | null = null;
  if (!prepared) {
    const receipt = await insertObservation(database.db, {
      source: "operator", producer: "ofapi:actions", platform: "onlyfans", accountId: pageId,
      kind: "ofapi.action_response.v1", idempotencyKey: `ofapi-action:${id}`,
      payload: { intentId: id, status: 200, subjectRefs, encryptedBody },
      payloadHash: createHash("sha256").update(cipher).digest(),
    });
    observationId = receipt.observationId;
    await database.pool.query("update ofapi_action_intents set response_observation_id=$2 where id=$1", [id, observationId]);
  }
  return { id, observationId };
}

async function retainedIds() {
  return (await database.pool.query<{ id: string }>("select id from ofapi_action_intents order by id")).rows.map(row => row.id);
}

describe("OFAPI action erasure", () => {
  it("erases encrypted fan notes, prepared and mixed-list commands and their receipts through explicit subject refs", async () => {
    const selected = await page("action-fan-erasure");
    const fanRef = "71234567";
    const note = await seedAction(selected.id, [fanRef]);
    const prepared = await seedAction(selected.id, [fanRef], true);
    const mixedList = await seedAction(selected.id, [fanRef, "89999999"]);
    const otherFan = await seedAction(selected.id, ["89999999"]);
    const prefixOnly = await seedAction(selected.id, [`${fanRef}8`]);
    const unrelated = await seedAction(selected.id, []);
    const scope = { scopeType: "fan", platform: "onlyfans", fanRef } as const;

    // The fan ID is visible only in explicit routing metadata, not encrypted content.
    const stored = (await database.pool.query<{ body_encrypted: string; result_encrypted: string }>(
      "select body_encrypted,result_encrypted from ofapi_action_intents where id=$1", [note.id],
    )).rows[0]!;
    expect(stored.body_encrypted).not.toContain(fanRef);
    expect(stored.result_encrypted).not.toContain(fanRef);
    const plan = await planErasure(app, scope);
    expect(plan.targets.find(target => target.target === "ofapi_action_intents")).toMatchObject({ plane: "hot", action: "delete", rows: 3 });
    expect(await retainedIds()).toHaveLength(6);

    await executeErasure(app, scope, { initiatedBy: ownerId });
    expect(await retainedIds()).toEqual([otherFan.id, prefixOnly.id, unrelated.id].sort());
    const removed = [note, prepared, mixedList].map(item => item.id);
    expect((await database.pool.query("select 1 from ofapi_action_intents where id=any($1::uuid[])", [removed])).rows).toEqual([]);
    expect((await database.pool.query("select 1 from observations where id=any($1::bigint[])", [[note.observationId, mixedList.observationId]])).rows).toEqual([]);
    expect((await database.pool.query("select id from observations where id=any($1::bigint[])", [[otherFan.observationId, prefixOnly.observationId, unrelated.observationId]])).rows).toHaveLength(3);

    // Repeating the procedure cannot resurrect a source receipt or a command.
    const again = await planErasure(app, scope);
    expect(again.targets.find(target => target.target === "ofapi_action_intents")?.rows).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("page erasure reaches actions with no fan index and preserves actions from other pages", async () => {
    const selected = await page("action-page-erasure");
    const other = await page("action-other-page");
    const erased = await seedAction(selected.id, []);
    const prepared = await seedAction(selected.id, ["71234567"], true);
    const kept = await seedAction(other.id, ["71234567"]);
    const scope = { scopeType: "page", pageLabel: selected.label } as const;
    const plan = await planErasure(app, scope);
    expect(plan.targets.find(target => target.target === "ofapi_action_intents")).toMatchObject({ rows: 2, action: "delete" });

    await executeErasure(app, scope, { initiatedBy: ownerId });
    expect(await retainedIds()).toEqual([kept.id]);
    expect((await database.pool.query("select 1 from observations where id=$1", [erased.observationId])).rows).toEqual([]);
    expect((await database.pool.query("select 1 from observations where id=$1", [kept.observationId])).rows).toHaveLength(1);
    expect((await database.pool.query("select 1 from pages where id=$1", [selected.id])).rows).toHaveLength(1);
    expect((await database.pool.query("select 1 from ofapi_action_intents where id=$1", [prepared.id])).rows).toEqual([]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("erases a fan appearing only in a returned list, including a crash before subject indexing", async () => {
    const selected = await page("action-returned-fan");
    const fanRef = "77889911";
    const response = { list: { id: "456", users: [{ id: fanRef, username: "Returned fan" }] } };
    const indexed = await seedAction(selected.id, ["11122233"], false, response);
    await database.pool.query("update ofapi_action_intents set subject_refs=$2::text[] where id=$1", [indexed.id, ["11122233", fanRef]]);
    const crashed = await seedAction(selected.id, ["11122233"], false, response);
    // The raw receipt committed, but neither receipt pointer nor response
    // subject index made it into the intent before process termination.
    await database.pool.query("update ofapi_action_intents set response_observation_id=null where id=$1", [crashed.id]);
    const bystander = await seedAction(selected.id, ["11122233"], false, { users: [{ id: `${fanRef}8` }] });
    const original = (await database.pool.query<{ payload: unknown }>("select payload from observations where id=$1", [crashed.observationId])).rows[0]!.payload;
    expect(JSON.stringify(original)).not.toContain(fanRef);
    const scope = { scopeType: "fan", platform: "onlyfans", fanRef } as const;

    const plan = await planErasure(app, scope);
    expect(plan.targets.find(target => target.target === "ofapi_action_intents")?.rows).toBe(2);
    expect((await database.pool.query<{ payload: unknown }>("select payload from observations where id=$1", [crashed.observationId])).rows[0]!.payload).toEqual(original);
    await executeErasure(app, scope, { initiatedBy: ownerId });
    expect(await retainedIds()).toEqual([bystander.id]);
    expect((await database.pool.query("select 1 from observations where id=any($1::bigint[])", [[indexed.observationId, crashed.observationId]])).rows).toEqual([]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rediscovers encrypted parked and lake receipts after their hot intents are already gone", async () => {
    const selected = await page("action-parked-returned-fan");
    const fanRef = "77889911";
    const target = await seedAction(selected.id, ["11122233"], false, { users: [{ id: fanRef }] });
    const bystander = await seedAction(selected.id, ["11122233"], false, { users: [{ id: "99887766" }] });
    const ids = [target.observationId!, bystander.observationId!];
    const receipts = (await database.pool.query<{ id: string; account_id: string; kind: string; payload: unknown }>(
      "select id::text,account_id::text,kind,payload from observations where id=any($1::bigint[]) order by id", [ids],
    )).rows;
    await database.pool.query("create schema if not exists tiered_pending_drop");
    await database.pool.query("create table tiered_pending_drop.observations_ofapi_action_test (like observations including all)");
    await database.pool.query("insert into tiered_pending_drop.observations_ofapi_action_test overriding system value select * from observations where id=any($1::bigint[])", [ids]);
    const dir = path.join(lakeDir, "capture", "observations", "2024");
    await mkdir(dir, { recursive: true });
    const ndjson = path.join(dir, "01.ndjson");
    const parquet = path.join(dir, "01.parquet");
    await writeFile(ndjson, receipts.map(row => JSON.stringify({ ...row, id: Number(row.id), account_id: Number(row.account_id) })).join("\n") + "\n");
    await ndjsonToParquet(ndjson, parquet, { id: "BIGINT", account_id: "BIGINT", kind: "VARCHAR", payload: "JSON" });
    await writeFile(path.join(dir, "01.manifest.json"), JSON.stringify({ table: "observations", partition: "observations_2024_01", rowCount: 2, restrictedRowCount: 0,
      minId: Math.min(...ids), maxId: Math.max(...ids), sha256: createHash("sha256").update(await readFile(parquet)).digest("hex"), restrictedSha256: null, exportedAt: "2024-02-01T00:00:00Z" }));
    // Simulate a prior partial erasure that committed hot deletion before the
    // parked/lake stage could complete. No intent index remains to consult.
    await database.pool.query("delete from ofapi_action_intents where page_id=$1", [selected.id]);
    await database.pool.query("delete from observations where id=any($1::bigint[])", [ids]);
    const scope = { scopeType: "fan", platform: "onlyfans", fanRef } as const;
    const plan = await planErasure(app, scope);
    expect(plan.targets.some(entry => entry.plane === "lake" && entry.rows === 1)).toBe(true);

    await executeErasure(app, scope, { initiatedBy: ownerId });
    expect((await database.pool.query<{ id: string }>("select id::text from tiered_pending_drop.observations_ofapi_action_test")).rows.map(row => Number(row.id))).toEqual([bystander.observationId]);
    expect(await readParquetIds(parquet)).toEqual([bystander.observationId]);
    expect((await planErasure(app, scope)).targets.filter(entry => entry.plane === "lake")).toEqual([]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("waits for a currently dispatched owner action before freezing receipt lineage", async () => {
    const selected = await page("action-planning-race");
    const fanRef = "77889911";
    const connection = await database.pool.connect();
    let released = false;
    let erasing: ReturnType<typeof executeErasure> | null = null;
    try {
      await connection.query("begin");
      await connection.query("select pg_advisory_xact_lock(9003011,1)");
      erasing = executeErasure(app, { scopeType: "fan", platform: "onlyfans", fanRef }, { initiatedBy: ownerId });
      let waiting = false;
      for (let poll = 0; poll < 100 && !waiting; poll++) {
        waiting = (await database.pool.query(
          "select 1 from pg_locks where locktype='advisory' and classid=9003011 and objid=1 and not granted",
        )).rows.length > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      // The response arrives while the action still owns its dispatch lock.
      const late = await seedAction(selected.id, ["11122233"], false, { users: [{ id: fanRef }] });
      await connection.query("commit");
      released = true;
      await erasing;
      expect((await database.pool.query("select 1 from observations where id=$1", [late.observationId])).rows).toEqual([]);
      expect(await retainedIds()).toEqual([]);
    } finally {
      if (!released) await connection.query("rollback");
      connection.release();
      await erasing?.catch(() => undefined);
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
