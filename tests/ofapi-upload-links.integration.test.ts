import { createHash } from "node:crypto";
import type * as FsPromises from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicationContentBody } from "@agency_hub_core/contracts";
import {
  createModel,
  createOnlyFansPage,
  getOfapiCaptureJob,
  getOnlyfansVaultAlbumRun,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";
import { PUBLICATION_PLATFORM_KINDS } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCredentialPolicy } from "../apps/runtime/src/services/ofapi-credential-policy.ts";
import { capturePublicationFileOfapiSource, createOwnerOfapiMediaUpload } from "../apps/runtime/src/services/ofapi-media-sources.ts";
import { runOfapiMediaUploadSweep } from "../apps/runtime/src/services/ofapi-media-worker.ts";
import {
  createOfapiUploadLink,
  OFAPI_UPLOAD_LINK_PATH,
  OFAPI_UPLOAD_LINK_TTL_MS,
  resolveOfapiUploadLink,
  revokeOfapiUploadLinks,
} from "../apps/runtime/src/services/ofapi-upload-links.ts";
import { uploadPublicationFile } from "../apps/runtime/src/services/publication-files.ts";
import { runOnlyfansVaultAlbumTick } from "../apps/runtime/src/services/publications-onlyfans-vault.ts";
import { approvePublications, createPublicationDraft } from "../apps/runtime/src/services/publications.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

/**
 * Large files of an OnlyFans vault album go by a link (8-docs
 * 2026-11-12-of-vault-album, plan PR 7), against a fake OnlyFansAPI. A file
 * over 100 MB is priced at 3 credits a started MB and sent as `file_url` (a
 * link to Hub) with `async=true`, never read into memory whole; the link
 * serves that one file of that one upload in flight and answers 404 once
 * expired, revoked, superseded or once its upload has an outcome; the token
 * is stored nowhere in clear; a lost answer is never sent again.
 */

// Every whole-file read of the process: a large file must never be one.
const wholeReads = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    wholeReads.push(String(args[0]));
    return actual.readFile(...args);
  }) as typeof actual.readFile;
  return { ...actual, default: { ...actual, readFile }, readFile };
});

const ACCOUNT = "acct_27000000000000000000000000000000";
const MB = 1_000_000;
const MIN = 60_000;
const UPLOAD_ID = "ofapi_media_large0001";
// An MP4's first bytes (Hub's file store and the uploader read the type from them).
const MP4_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(20, 1)]);

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let root = "";
let pageId = 0;
let ownerId = 0;
let smallFileId = 0;
let opened: string[] = [];

let lists = new Map<string, { name: string; media: string[] }>();
let vault = new Map<string, { isReady: boolean }>();
let nextId = 9001;
/** The bodies of every upload OnlyFansAPI was sent. */
let uploads: Buffer[] = [];
let uploadAnswer: () => Response | Promise<Response> = () => accepted();
let statusAnswer: () => Response = () => json({ prefixed_id: UPLOAD_ID, status: "processing" });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const accepted = () => json({
  prefixed_id: UPLOAD_ID, status: "pending",
  polling_url: `https://app.onlyfansapi.com/api/${ACCOUNT}/media/uploads/${UPLOAD_ID}/status`,
}, 202);
const bodyOf = (init?: RequestInit) => JSON.parse(
  typeof init?.body === "string" ? init.body : Buffer.from(init?.body as Uint8Array).toString("utf8"),
) as Record<string, unknown>;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  (PUBLICATION_PLATFORM_KINDS as unknown as Record<string, string[]>).onlyfans = opened;
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  const kinds = PUBLICATION_PLATFORM_KINDS as unknown as Record<string, string[]>;
  opened = kinds.onlyfans!;
  if (!opened.includes("vault_album")) kinds.onlyfans = [...opened, "vault_album"];

  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  root = await mkdtemp(path.join(tmpdir(), "vault-link-"));
  app.config.publicationFilesDir = root;
  app.config.webConsoleOrigin = "https://hub.example.test";
  app.config.ofapiExpectedTeamSlug = "agency";
  app.config.ofapiApiKey = "synthetic-key";
  app.config.publishingEnabled = true;
  app.config.publishingOnlyfansEnabled = true;
  app.config.publishingOnlyfansVaultEnabled = true;
  app.config.onlyfansVaultDailyCredits = 5000;
  app.config.onlyfansVaultReserveCredits = 100;
  app.config.ofapiCreditFloor = 10;
  const model = await createModel(app.db, { slug: "lora", name: "Lora" });
  pageId = (await createOnlyFansPage(app.db, { modelId: model.id, label: "lora-of" })).id;
  await setPageOfapiAccountId(app.db, { pageId, ofapiAccountId: ACCOUNT });
  ownerId = (await createUserAccount(app, { username: "owner", role: "owner", password: "owner-password-for-tests" }, { source: "cli" })).id;
  await testDb.pool.query("insert into page_publishing_settings (page_id, enabled) values ($1, true)", [pageId]);
  await testDb.pool.query(`
    insert into ofapi_credit_state (id, last_balance, last_balance_at, updated_at) values (1, 100000, now(), now())
    on conflict (id) do update set last_balance = 100000, last_balance_at = now()
  `);
  const small = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2_000, 3)]);
  smallFileId = (await uploadPublicationFile(app, {
    body: Readable.from([small]), declaredLength: small.length, model: { pageLabel: "lora-of" }, originalName: "IMG_1.jpg", userId: ownerId,
  })).file.id;

  lists = new Map();
  vault = new Map();
  nextId = 9001;
  uploads = [];
  wholeReads.length = 0;
  uploadAnswer = () => accepted();
  statusAnswer = () => json({ prefixed_id: UPLOAD_ID, status: "processing" });
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const pathname = parsed.pathname;
    const method = init?.method ?? "GET";
    if (pathname.endsWith("/whoami")) return json({ team: { slug: "agency" } });
    if (pathname.endsWith(`/${ACCOUNT}/media/vault/lists`) && method === "GET") {
      const list = [...lists].map(([id, entry]) => ({ id: Number(id), name: entry.name, type: "custom", mediaCount: entry.media.length }));
      return json({ data: { list, hasMore: false } });
    }
    if (pathname.endsWith(`/${ACCOUNT}/media/vault/lists`) && method === "POST") {
      const id = String(nextId++);
      lists.set(id, { name: String(bodyOf(init).name), media: [] });
      return json({ data: { id: Number(id), name: String(bodyOf(init).name), type: "custom" } });
    }
    const add = new RegExp(`/${ACCOUNT}/media/vault/lists/(\\d+)/media$`).exec(pathname);
    if (add && method === "POST") {
      const mediaIds = (bodyOf(init).mediaIds as unknown[]).map(String);
      lists.get(add[1]!)?.media.push(...mediaIds);
      return json({ data: { id: Number(add[1]), type: "custom", name: lists.get(add[1]!)?.name ?? "" } });
    }
    if (pathname.endsWith(`/${ACCOUNT}/media/vault`) && method === "POST") {
      uploads.push(Buffer.from(init?.body as Uint8Array));
      return uploadAnswer();
    }
    if (pathname.endsWith(`/${ACCOUNT}/media/vault`) && method === "GET") {
      const listId = parsed.searchParams.get("list") ?? "";
      const media = (lists.get(listId)?.media ?? []).map((id) => ({ id: Number(id), type: "video", isReady: vault.get(id)?.isReady ?? false, hasError: false }));
      return json({ data: { list: media, hasMore: false } });
    }
    if (pathname.endsWith(`/${ACCOUNT}/media/uploads/${UPLOAD_ID}/status`)) return statusAnswer();
    throw new Error(`unexpected OFAPI request ${method} ${pathname}`);
  }));
  app.ofapi = createOfapiClient({ apiKey: "synthetic-key", restDelayMs: 0, ...ofapiCredentialPolicy(app.db, app.config, app.logger) });
});

/** A 300 MB MP4 of the page's model, streamed to Hub's file store in 1 MB chunks (never whole in memory here either). */
async function largeFile(bytes = 300 * MB): Promise<{ id: number; path: string; sha256: string }> {
  const zeros = Buffer.alloc(MB);
  const hash = createHash("sha256").update(MP4_HEAD);
  let left = bytes - MP4_HEAD.length;
  const chunks = function* () {
    yield MP4_HEAD;
    while (left > 0) {
      const part = left >= MB ? zeros : zeros.subarray(0, left);
      left -= part.length;
      hash.update(part);
      yield part;
    }
  };
  const uploaded = await uploadPublicationFile(app, {
    body: Readable.from(chunks()), declaredLength: bytes, model: { pageLabel: "lora-of" }, originalName: "long.mp4", userId: ownerId,
  });
  const sha256 = hash.digest("hex");
  expect(uploaded.file.sha256).toBe(sha256);
  const modelId = uploaded.file.modelId;
  return { id: uploaded.file.id, path: path.join(root, String(modelId), sha256), sha256 };
}

async function approvedAlbum(fileId: number) {
  const body: PublicationContentBody = {
    kind: "vault_album", text: "Long set", media: [{ source: "file", fileId }], previews: [],
    publishAt: new Date(Date.now() - MIN).toISOString(), expiresAt: null, wallRefs: [], tierRefs: [], priceMills: null,
    repost: false, pinWallRefs: [], replyLock: [], subscribersOnly: false, extraAttachments: [],
  };
  const draft = await createPublicationDraft(app.db, { pageId, body, author: { kind: "human", userId: ownerId }, idempotencyKey: null });
  const [result] = await approvePublications(app.db, { items: [{ id: draft.id, version: draft.version }], userId: ownerId });
  expect(result?.outcome, JSON.stringify(result)).toBe("approved");
  return draft.id;
}

async function ticks(count: number) {
  for (let tick = 0; tick < count; tick += 1) await runOnlyfansVaultAlbumTick(app);
}

/** The link's token as the upload body carried it, and the whole field. */
function linkOf(body: Buffer): { url: string; token: string } {
  const text = body.toString("utf8");
  const match = /name="file_url"\r\n\r\n([^\r]+)\r\n/.exec(text);
  expect(match, text).not.toBeNull();
  const url = match![1]!;
  return { url, token: url.slice(url.lastIndexOf("/") + 1) };
}

async function linkRows() {
  return (await testDb!.pool.query<{ id: string; token_sha256: Buffer; revoked_at: Date | null; revoked_reason: string | null; fetch_count: number; fetched_from: string[] }>(
    "select id, token_sha256, revoked_at, revoked_reason, fetch_count, fetched_from from ofapi_upload_links order by created_at")).rows;
}

describe("a vault album file over 100 MB", () => {
  it("is priced 3 credits a started MB, sent once as file_url with async, never read whole; its link serves it while the upload runs and answers 404 after", async () => {
    const big = await largeFile();
    const id = await approvedAlbum(big.id);
    await ticks(4);

    const run = await getOnlyfansVaultAlbumRun(app.db, id);
    expect(run?.files[0]).toMatchObject({ state: "uploading", bytes: 300 * MB, credits: 900 });
    expect(run?.priceCredits).toBe(900 + 15);

    // One upload request, a small multipart body: async and the link, no bytes.
    expect(uploads).toHaveLength(1);
    const sentBody = uploads[0]!;
    expect(sentBody.length).toBeLessThan(2_000);
    expect(sentBody.toString("utf8")).toContain('name="async"\r\n\r\ntrue\r\n');
    expect(sentBody.toString("utf8")).not.toContain('name="file"');
    const { url, token } = linkOf(sentBody);
    expect(url).toBe(`https://hub.example.test${OFAPI_UPLOAD_LINK_PATH}${token}`);
    // The large file was never read into memory whole.
    expect(wholeReads.filter((read) => read === big.path)).toEqual([]);
    // The reserve is the tariff of its size.
    const jobId = run!.files[0]!.jobId!;
    const attempts = await testDb!.pool.query<{ reserved_credits: number }>(
      "select reserved_credits from ofapi_request_attempts where capture_job_id = $1::uuid", [jobId]);
    expect(attempts.rows.map((row) => row.reserved_credits)).toEqual([900]);

    // The token is stored nowhere in clear: its sha256 only.
    const [link] = await linkRows();
    expect(link!.token_sha256.toString("hex")).toBe(createHash("sha256").update(token).digest("hex"));
    for (const [table, column] of [["observations", "payload"], ["ofapi_capture_jobs", "target"], ["ofapi_capture_jobs", "cursor"], ["ofapi_request_attempts", "admission_snapshot"]] as const) {
      const found = await testDb!.pool.query(`select 1 from ${table} where ${column}::text like $1 limit 1`, [`%${token}%`]);
      expect(found.rows, `${table}.${column}`).toEqual([]);
    }

    // While the upload runs, the link serves its file: HEAD, then a range.
    const server = await buildApiServer(app);
    try {
      const head = await server.inject({ method: "HEAD", url: `${OFAPI_UPLOAD_LINK_PATH}${token}` });
      expect(head.statusCode).toBe(200);
      expect(head.headers["content-length"]).toBe(String(300 * MB));
      expect(head.headers["content-type"]).toBe("video/mp4");
      expect(head.headers["accept-ranges"]).toBe("bytes");
      const first = await server.inject({ method: "GET", url: `${OFAPI_UPLOAD_LINK_PATH}${token}`, headers: { range: "bytes=0-11" } });
      expect(first.statusCode).toBe(206);
      expect(first.headers["content-range"]).toBe(`bytes 0-11/${300 * MB}`);
      expect(first.rawPayload.equals(MP4_HEAD.subarray(0, 12))).toBe(true);
      const tail = await server.inject({ method: "GET", url: `${OFAPI_UPLOAD_LINK_PATH}${token}`, headers: { range: "bytes=-5" } });
      expect(tail.statusCode).toBe(206);
      expect(tail.headers["content-range"]).toBe(`bytes ${300 * MB - 5}-${300 * MB - 1}/${300 * MB}`);
      expect(tail.rawPayload.equals(Buffer.alloc(5))).toBe(true);
      const outside = await server.inject({ method: "GET", url: `${OFAPI_UPLOAD_LINK_PATH}${token}`, headers: { range: `bytes=${300 * MB}-` } });
      expect(outside.statusCode).toBe(416);
      expect((await linkRows())[0]).toMatchObject({ fetch_count: 3, revoked_at: null });

      // The status read brings the outcome: the link is revoked and answers 404.
      statusAnswer = () => json({
        prefixed_id: UPLOAD_ID, status: "completed", account_id: ACCOUNT, credits_used: 900,
        media: { id: 7777, type: "video", isReady: true, hasError: false },
      });
      vault.set("7777", { isReady: true });
      await testDb!.pool.query("update ofapi_capture_jobs set next_attempt_at = now() where id = $1::uuid", [jobId]);
      // The read, then its parse (the sweep's next chunk).
      await runOfapiMediaUploadSweep(app);
      await runOfapiMediaUploadSweep(app);
      expect((await getOfapiCaptureJob(app.db, jobId))?.state).toBe("complete");
      expect((await linkRows())[0]).toMatchObject({ revoked_reason: "upload_completed" });
      const after = await server.inject({ method: "GET", url: `${OFAPI_UPLOAD_LINK_PATH}${token}`, headers: { range: "bytes=0-11" } });
      expect(after.statusCode).toBe(404);
    } finally {
      await server.close();
    }

    // The album goes on with the uploaded file; nothing is uploaded again.
    await ticks(4);
    expect(uploads).toHaveLength(1);
    expect((await getOnlyfansVaultAlbumRun(app.db, id))?.files[0]).toMatchObject({ state: "uploaded", mediaRef: "7777" });
  }, 120_000);

  it("over the link's limit stays for a person: priced 0, never sent", async () => {
    app.config.onlyfansVaultLinkMaxMb = 200;
    const big = await largeFile();
    const id = await approvedAlbum(big.id);
    await ticks(4);
    expect((await getOnlyfansVaultAlbumRun(app.db, id))?.files[0]).toMatchObject({ state: "too_big", credits: 0 });
    expect(uploads).toEqual([]);
    expect(await linkRows()).toEqual([]);
  }, 120_000);

  it("a lost answer is unknown and never sent again", async () => {
    const big = await largeFile();
    const id = await approvedAlbum(big.id);
    uploadAnswer = () => {
      throw new TypeError("fetch failed: socket hang up");
    };
    await ticks(4);
    expect(uploads).toHaveLength(1);
    for (let round = 0; round < 3; round += 1) {
      await testDb!.pool.query("update ofapi_capture_jobs set next_attempt_at = now() where kind = 'media_upload'");
      await runOfapiMediaUploadSweep(app);
    }
    await ticks(3);
    expect(uploads).toHaveLength(1);
    const file = (await getOnlyfansVaultAlbumRun(app.db, id))?.files[0];
    expect(file?.state).toBe("unknown");
  }, 120_000);
});

describe("a link", () => {
  /** An upload job of the small file (no OnlyFansAPI call: queued only) and a link to that file. */
  async function job() {
    const source = await capturePublicationFileOfapiSource(app, { pageId, fileId: smallFileId, actorUserId: ownerId });
    const policy = (await testDb!.pool.query<{ revision: number }>("select revision from ofapi_collection_state where id = 1")).rows[0];
    const queued = await createOwnerOfapiMediaUpload(app, {
      pageId, sourceId: source.id, destination: "vault", requestId: "11111111-1111-4111-8111-111111111111",
      expectedPolicyRevision: Number(policy?.revision ?? 0), maxCredits: 1, dryRun: false,
    }, ownerId);
    return queued.jobId!;
  }
  const tokenOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);

  it("serves its file while its job runs; unknown, expired, revoked or superseded answers 404", async () => {
    const jobId = await job();
    const link = await createOfapiUploadLink(app, { uploadJobId: jobId, pageId, fileId: smallFileId });
    const token = tokenOf(link.url);
    expect((await resolveOfapiUploadLink(app, token, { fetch: { address: "203.0.113.7" } })).file.id).toBe(smallFileId);
    expect((await linkRows())[0]).toMatchObject({ fetch_count: 1, fetched_from: ["203.0.113.7"] });
    // The whole file without a Range.
    const server = await buildApiServer(app);
    try {
      const whole = await server.inject({ method: "GET", url: `${OFAPI_UPLOAD_LINK_PATH}${token}` });
      expect(whole.statusCode).toBe(200);
      expect(whole.headers["content-type"]).toBe("image/jpeg");
      expect(whole.rawPayload.length).toBe(2_004);
      expect(whole.rawPayload.subarray(0, 4).equals(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
      const unknown = await server.inject({ method: "GET", url: `${OFAPI_UPLOAD_LINK_PATH}nothing-here` });
      expect(unknown.statusCode).toBe(404);
    } finally {
      await server.close();
    }

    // Another token of the same shape: its first character changed (the last one may already be an "A").
    const another = `${token.startsWith("A") ? "B" : "A"}${token.slice(1)}`;
    await expect(resolveOfapiUploadLink(app, another, { fetch: null })).rejects.toMatchObject({ statusCode: 404 });
    await expect(resolveOfapiUploadLink(app, token, { fetch: null, now: new Date(Date.now() + OFAPI_UPLOAD_LINK_TTL_MS + MIN) }))
      .rejects.toMatchObject({ statusCode: 404 });

    // A newer link of the same job revokes the older.
    const newer = await createOfapiUploadLink(app, { uploadJobId: jobId, pageId, fileId: smallFileId });
    await expect(resolveOfapiUploadLink(app, token, { fetch: null })).rejects.toMatchObject({ statusCode: 404 });
    expect((await resolveOfapiUploadLink(app, tokenOf(newer.url), { fetch: null })).file.id).toBe(smallFileId);

    expect(await revokeOfapiUploadLinks(app.db, jobId, "upload_failed")).toBe(1);
    await expect(resolveOfapiUploadLink(app, tokenOf(newer.url), { fetch: null })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("of a finished job, or naming another file than its job uploads, answers 404", async () => {
    const jobId = await job();
    const finished = await createOfapiUploadLink(app, { uploadJobId: jobId, pageId, fileId: smallFileId });
    await testDb!.pool.query("update ofapi_capture_jobs set state = 'cancelled', completed_at = now() where id = $1::uuid", [jobId]);
    await expect(resolveOfapiUploadLink(app, tokenOf(finished.url), { fetch: null })).rejects.toMatchObject({ statusCode: 404 });

    const other = await largeFile(101 * MB);
    await testDb!.pool.query("update ofapi_capture_jobs set state = 'ready', completed_at = null where id = $1::uuid", [jobId]);
    const foreign = await createOfapiUploadLink(app, { uploadJobId: jobId, pageId, fileId: other.id });
    await expect(resolveOfapiUploadLink(app, tokenOf(foreign.url), { fetch: null })).rejects.toMatchObject({ statusCode: 404 });
  }, 60_000);
});
