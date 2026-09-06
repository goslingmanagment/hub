import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createModel, createOnlyFansPage, createOrGetOfapiCaptureJob, createOrGetOfapiCommand,
  createUser, insertObservation, OfapiProviderOperationRefused, reserveOfapiProviderOperation,
  setPageOfapiAccountId, type Database,
} from "@agency_hub_core/db";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { BadRequestError, ConflictError } from "../apps/runtime/src/services/errors.ts";
import { reserveOfapiActionMedia, validateOfapiActionMedia } from "../apps/runtime/src/services/ofapi-action-media.ts";
import { prepareOfapiAction } from "../apps/runtime/src/services/ofapi-actions.ts";
import { buildOfapiMediaFact, recordOfapiMediaFacts } from "../apps/runtime/src/services/projections/ofapi-media.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

let database: StartedTestDatabase;
let app: AppContext;
let pageId: number;
let otherPageId: number;
let actor: number;
let fetchMock: ReturnType<typeof vi.fn>;
const ACCOUNT = "acct_actionmedia";
const OTHER_ACCOUNT = "acct_otheractionmedia";
const TOKEN = "ofapi_media_owner_action";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest();

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("OFAPI action media regressions require PostgreSQL");
  database = started;
}, 120000);
afterAll(async () => { await database?.stop(); });
afterEach(() => {
  expect(fetchMock).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
beforeEach(async () => {
  await resetIntegrationDatabase(database.pool);
  app = createTestAppContext(database);
  app.config.ofapiApiKey = "synthetic-actions-key";
  actor = (await createUser(app.db, { username: "media-action-owner", passwordHash: "synthetic", role: "owner" }))!.id;
  const model = (await createModel(app.db, { slug: "action-media", name: "Action media" }))!;
  pageId = (await createOnlyFansPage(app.db, { modelId: model.id, label: "Owner media" }))!.id;
  otherPageId = (await createOnlyFansPage(app.db, { modelId: model.id, label: "Other media" }))!.id;
  await setPageOfapiAccountId(app.db, { pageId, ofapiAccountId: ACCOUNT });
  await setPageOfapiAccountId(app.db, { pageId: otherPageId, ofapiAccountId: OTHER_ACCOUNT });
  fetchMock = vi.fn(() => { throw new Error("Media custody must never refresh from the provider implicitly"); });
  vi.stubGlobal("fetch", fetchMock);
});

async function capture(payload: unknown, options: { pageId?: number; accountId?: string; kind?: string } = {}) {
  const receivedAt = new Date();
  const kind = options.kind ?? "ofapi.collection_read_response.v1";
  const saved = await insertObservation(app.db, {
    source: "ofapi_capture", producer: "ofapi-action-media-test", platform: "onlyfans",
    accountId: options.pageId ?? pageId, nativeAccountRef: options.accountId ?? ACCOUNT,
    kind, payload, payloadHash: hash(payload), idempotencyKey: randomUUID(), receivedAt,
  });
  return { observationId: saved.observationId, observedAt: receivedAt, sourceKind: kind };
}
async function vault(ref: string, flags: Record<string, unknown> = { isReady: true }, options: { pageId?: number; accountId?: string } = {}) {
  const media = { id: ref, type: "photo", ...flags };
  const evidence = await capture({ data: [media] }, options);
  await recordOfapiMediaFacts(app.db, options.pageId ?? pageId, [buildOfapiMediaFact(media, {
    ...evidence, accountId: options.accountId ?? ACCOUNT, materialKind: "vault",
  })]);
}
async function upload(token = TOKEN, options: {
  pageId?: number; accountId?: string; state?: "ready" | "complete"; status?: string;
  destination?: "cdn" | "vault"; isReady?: boolean | null; hasError?: boolean | null;
} = {}) {
  const id = randomUUID();
  const uploadPage = options.pageId ?? pageId;
  const accountId = options.accountId ?? ACCOUNT;
  await createOrGetOfapiCaptureJob(app.db, {
    id, pageId: uploadPage, ofapiAccountId: accountId, kind: "media_upload",
    activeSlotKey: `page:${uploadPage}:media-action:${id}`,
    target: { requestId: randomUUID(), sourceId: randomUUID(), destination: options.destination ?? "cdn", maxCredits: 3 },
    budgetScope: "interactive", originPrincipalId: actor, createdBy: "owner", maxCalls: 3, maxCredits: 3,
  });
  const cursor = { mediaRef: token, status: options.status ?? "completed", isReady: options.isReady ?? null, hasError: options.hasError ?? null };
  if (options.state === "ready") {
    await database.pool.query("update ofapi_capture_jobs set cursor=$2::jsonb where id=$1", [id, JSON.stringify(cursor)]);
  } else {
    const evidence = await capture(cursor, { pageId: uploadPage, accountId, kind: "ofapi.media_upload_response.v1" });
    await database.pool.query("update ofapi_capture_jobs set state='complete',cursor=$2::jsonb,terminal_observation_id=$3,terminal_observation_received_at=$4,completed_at=now() where id=$1", [id, JSON.stringify(cursor), evidence.observationId, evidence.observedAt]);
  }
  return id;
}
async function intent() {
  const id = randomUUID();
  await prepareOfapiAction(app, { id, command: { action: "user_list_create", pageId, name: "Media reservation" } }, actor);
  return id;
}
async function chat(token = TOKEN) {
  const id = randomUUID();
  const payload = { text: "Owned media", price: 0, mediaFiles: [token], previews: [] };
  await createOrGetOfapiCommand(app.db, {
    id, clientCommandId: randomUUID(), pageId, chatterUserId: actor, ofapiAccountId: ACCOUNT,
    conversationId: "101", kind: "send_media_message_v1", payload, payloadHash: hash(payload).toString("hex"),
  });
  return id;
}
const reserveChat = (commandId: string, token = TOKEN) => reserveOfapiProviderOperation(app.db, {
  commandId, parentCommandId: null, reuse: false, teamSlug: "synthetic", accountId: ACCOUNT,
  endpoint: `/${ACCOUNT}/chats/101/messages`, bodyHash: hash(token).toString("hex"), tokens: [token],
});
const custody = async () => (await database.pool.query("select account_id,token,operation_id,command_id,action_intent_id from ofapi_media_token_custody order by token")).rows;
const validate = (fields: Record<string, unknown>) => validateOfapiActionMedia(app, { pageId, ...fields }, ACCOUNT);

describe("shared owner-action media custody", () => {
  it("preserves native vault reuse and exact large IDs without reserving one-use capabilities", async () => {
    const largeId = "90071992547409931234";
    await vault(largeId);
    expect(await validate({})).toEqual([]);
    for (let count = 0; count < 2; count++) expect(await validate({ mediaFiles: [largeId], previews: [largeId], avatar: largeId, header: largeId })).toEqual([]);
    expect(await custody()).toEqual([]);
  });

  it("refuses missing vault metadata and evidence belonging to another page or account", async () => {
    await vault("101", { isReady: true }, { pageId: otherPageId, accountId: OTHER_ACCOUNT });
    await vault("202", { isReady: true }, { accountId: "acct_previous_binding" });
    for (const ref of ["101", "202", "303"]) await expect(validate({ mediaFiles: [ref] })).rejects.toBeInstanceOf(ConflictError);
  });

  it("requires affirmative vault readiness and respects error and visibility refusals", async () => {
    const cases = [{ isReady: false }, { isReady: null }, { isReady: true, hasError: true }, { isReady: true, canView: false }];
    for (const [index, flags] of cases.entries()) {
      const ref = String(index + 100);
      await vault(ref, flags);
      await expect(validate({ mediaFiles: [ref] })).rejects.toBeInstanceOf(ConflictError);
    }
    await vault("200", { isReady: true, hasError: null, canView: null });
    expect(await validate({ mediaFiles: ["200"] })).toEqual([]);
  });

  it("validates every preview and profile media field and rejects URLs and coerced IDs", async () => {
    await vault("101");
    for (const fields of [{ previews: ["999"] }, { avatar: "999" }, { header: "999" }]) await expect(validate({ mediaFiles: ["101"], ...fields })).rejects.toBeInstanceOf(ConflictError);
    for (const fields of [{ mediaFiles: "101" }, { mediaFiles: [101] }, { previews: ["https://example.test/a.jpg"] }, { avatar: {} }, { header: "../101" }]) await expect(validate(fields)).rejects.toBeInstanceOf(BadRequestError);
  });

  it("uses completed upload job custody and returns distinct CDN tokens across all media fields", async () => {
    await upload();
    expect((await database.pool.query("select count(*)::int n from ofapi_media_catalog")).rows[0].n).toBe(0);
    expect(await validate({ mediaFiles: [TOKEN, TOKEN], previews: [TOKEN], avatar: TOKEN, header: TOKEN })).toEqual([TOKEN]);
    expect(await custody()).toEqual([]);
  });

  it("refuses uncompleted, wrong-destination, error and explicitly unready uploads", async () => {
    const cases = [
      { state: "ready" as const }, { status: "failed" }, { destination: "vault" as const },
      { isReady: false }, { hasError: true },
    ];
    for (const [index, options] of cases.entries()) {
      const token = `${TOKEN}_${index}`;
      await upload(token, options);
      await expect(validate({ mediaFiles: [token] })).rejects.toBeInstanceOf(ConflictError);
    }
  });

  it("requires the exact completed CDN token under the same page and binding", async () => {
    await upload(`${TOKEN}_other_page`, { pageId: otherPageId, accountId: OTHER_ACCOUNT });
    await upload(`${TOKEN}_old_account`, { accountId: "acct_previous_binding" });
    for (const token of [`${TOKEN}_other_page`, `${TOKEN}_old_account`, `${TOKEN}_unknown`]) await expect(validate({ mediaFiles: [token] })).rejects.toBeInstanceOf(ConflictError);
  });

  it("does not turn a CDN catalog hash into upload authorization", async () => {
    const mediaRef = `cdn_sha256:${createHash("sha256").update(TOKEN).digest("hex")}`;
    const media = { isReady: true, hasError: false };
    const evidence = await capture({ data: media }, { kind: "ofapi.media_upload_response.v1" });
    await recordOfapiMediaFacts(app.db, pageId, [buildOfapiMediaFact(media, { ...evidence, accountId: ACCOUNT, materialKind: "cdn", mediaRef })]);
    await expect(validate({ mediaFiles: [TOKEN] })).rejects.toBeInstanceOf(ConflictError);
    await expect(validate({ mediaFiles: [mediaRef] })).rejects.toBeInstanceOf(BadRequestError);
  });

  it("arbitrates concurrent actions once and permits only the winning action to repeat reservation", async () => {
    const first = await intent();
    const second = await intent();
    const outcomes = await Promise.allSettled([
      reserveOfapiActionMedia(app.db, first, ACCOUNT, [TOKEN, TOKEN]),
      reserveOfapiActionMedia(app.db, second, ACCOUNT, [TOKEN]),
    ]);
    expect(outcomes.map(value => value.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = outcomes.find(value => value.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictError);
    const rows = await custody();
    expect(rows).toHaveLength(1);
    const winner = rows[0].action_intent_id;
    expect([first, second]).toContain(winner);
    expect(rows[0]).toMatchObject({ command_id: null, operation_id: winner });
    await reserveOfapiActionMedia(app.db, winner, ACCOUNT, [TOKEN]);
    expect(await custody()).toEqual(rows);
  });

  it("refuses an existing chat reservation and keeps its original provider identity", async () => {
    const chatId = await chat();
    const operation = await reserveChat(chatId);
    const actionId = await intent();
    await expect(reserveOfapiActionMedia(app.db, actionId, ACCOUNT, [TOKEN])).rejects.toBeInstanceOf(ConflictError);
    expect(await custody()).toEqual([{ account_id: ACCOUNT, token: TOKEN, operation_id: operation.operationId, command_id: chatId, action_intent_id: null }]);
  });

  it("prevents a chat send from consuming a token already owned by an action", async () => {
    const actionId = await intent();
    await reserveOfapiActionMedia(app.db, actionId, ACCOUNT, [TOKEN]);
    const chatId = await chat();
    await expect(reserveChat(chatId)).rejects.toMatchObject({ reason: "media_token_already_used" });
    expect((await database.pool.query("select count(*)::int n from ofapi_command_provider_operations")).rows[0].n).toBe(0);
    expect((await custody())[0]).toMatchObject({ action_intent_id: actionId, command_id: null });
  });

  it("arbitrates a racing chat send and owner action through the same unique token key", async () => {
    const actionId = await intent();
    const chatId = await chat();
    const outcomes = await Promise.allSettled([reserveOfapiActionMedia(app.db, actionId, ACCOUNT, [TOKEN]), reserveChat(chatId)]);
    expect(outcomes.map(value => value.status).sort()).toEqual(["fulfilled", "rejected"]);
    const failure = (outcomes.find(value => value.status === "rejected") as PromiseRejectedResult).reason;
    expect(failure instanceof ConflictError || failure instanceof OfapiProviderOperationRefused).toBe(true);
    const rows = await custody();
    expect(rows).toHaveLength(1);
    const operationCount = Number((await database.pool.query("select count(*)::int n from ofapi_command_provider_operations")).rows[0].n);
    if (rows[0].action_intent_id === actionId) {
      expect(rows[0]).toMatchObject({ command_id: null, operation_id: actionId });
      expect(operationCount).toBe(0);
    } else {
      expect(rows[0]).toMatchObject({ command_id: chatId, action_intent_id: null });
      expect(operationCount).toBe(1);
    }
  });

  it("rolls reservation back with a failed dispatch claim so a fresh action can still consume it", async () => {
    const failed = await intent();
    await expect(app.db.transaction(async tx => {
      await reserveOfapiActionMedia(tx as unknown as Database, failed, ACCOUNT, [TOKEN]);
      throw new Error("Synthetic claim failure before HTTP");
    })).rejects.toThrow("Synthetic claim failure");
    expect(await custody()).toEqual([]);
    const replacement = await intent();
    await reserveOfapiActionMedia(app.db, replacement, ACCOUNT, [TOKEN]);
    expect((await custody())[0]).toMatchObject({ action_intent_id: replacement });
  });

  it("rolls back fresh tokens when a later token conflicts in the same reservation", async () => {
    const taken = `${TOKEN}_z_taken`;
    const fresh = `${TOKEN}_a_fresh`;
    await reserveChat(await chat(taken), taken);
    const owner = await intent();
    await expect(reserveOfapiActionMedia(app.db, owner, ACCOUNT, [fresh, taken])).rejects.toBeInstanceOf(ConflictError);
    expect((await custody()).map(row => row.token)).toEqual([taken]);
    await reserveOfapiActionMedia(app.db, owner, ACCOUNT, [fresh]);
    expect((await custody()).map(row => row.token)).toEqual([fresh, taken]);
  });
});
