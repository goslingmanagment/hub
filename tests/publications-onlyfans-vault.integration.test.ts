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
  getPublication,
  saveOnlyfansVaultAlbumRun,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";
import { PUBLICATION_PLATFORM_KINDS } from "@agency_hub_core/shared";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCredentialPolicy } from "../apps/runtime/src/services/ofapi-credential-policy.ts";
import { runOfapiMediaUploadSweep } from "../apps/runtime/src/services/ofapi-media-worker.ts";
import { uploadPublicationFile } from "../apps/runtime/src/services/publication-files.ts";
import { onlyfansCommandFor, runOnlyfansPublishingTick } from "../apps/runtime/src/services/publications-onlyfans.ts";
import { runOnlyfansVaultAlbumTick } from "../apps/runtime/src/services/publications-onlyfans-vault.ts";
import { approvePublications, createPublicationDraft } from "../apps/runtime/src/services/publications.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

/**
 * The executor of an OnlyFans vault album (8-docs 2026-11-12-of-vault-album,
 * plan PR 4) against a fake OnlyFansAPI: the album found or created once,
 * files up one at a time from the folder's end, one add, the album read back.
 * Every write gets one attempt — a lost answer to the create, an upload or the
 * add never brings a second one; a late upload outcome is taken by a re-send
 * without paying again; nothing leaves while the albums are switched off; an
 * album is never a post.
 *
 * The kind `vault_album` is still closed for OnlyFans (the next PR opens it):
 * these tests open it for themselves to make albums through the real draft
 * and approval. Uploads run through a fake runner (`runUpload`) that writes
 * the job's outcome as OnlyFansAPI's answer would leave it; the switch test
 * drives the real runner with a transport that must never be called.
 */

const ACCOUNT = "acct_26000000000000000000000000000000";
const MIN = 60_000;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let root = "";
let pageId = 0;
let ownerId = 0;
let fileIds: number[] = [];

/** The fake OnlyFans account: its vault media (id → ready) and lists (id → name and media in the order added). */
let vault = new Map<string, { isReady: boolean }>();
let lists = new Map<string, { name: string; media: string[] }>();
let nextId = 9001;
let creates: Array<Record<string, unknown>> = [];
let adds: Array<{ listId: string; mediaIds: string[] }> = [];
let createAnswer: (name: string) => Response = (name) => {
  const id = String(nextId++);
  lists.set(id, { name, media: [] });
  return json({ data: { id: Number(id), name, type: "custom" } });
};
let addAnswer: (listId: string, mediaIds: string[]) => Response = (listId, mediaIds) => {
  lists.get(listId)?.media.push(...mediaIds);
  return json({ data: { id: Number(listId), type: "custom", name: lists.get(listId)?.name ?? "" } });
};
let postsSent = 0;
/** Reads of the page's lists; `listsFail`: OnlyFansAPI answers them with 500. */
let listReads = 0;
let listsFail = false;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bodyOf = (init?: RequestInit) => JSON.parse(
  typeof init?.body === "string" ? init.body : Buffer.from(init?.body as Uint8Array).toString("utf8"),
) as Record<string, unknown>;

/** The album's media as OnlyFans lists them: newest upload first (ids grow with time here). */
function albumMedia(listId: string) {
  return [...(lists.get(listId)?.media ?? [])]
    .sort((a, b) => Number(b) - Number(a))
    .map((id) => ({ id: Number(id), type: "photo", isReady: vault.get(id)?.isReady ?? false, hasError: false }));
}

let opened: string[] = [];

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
  // Open the kind for these tests only (closed for OnlyFans until the next PR).
  const kinds = PUBLICATION_PLATFORM_KINDS as unknown as Record<string, string[]>;
  opened = kinds.onlyfans!;
  kinds.onlyfans = [...opened, "vault_album"];

  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  root = await mkdtemp(path.join(tmpdir(), "vault-album-"));
  app.config.publicationFilesDir = root;
  app.config.ofapiExpectedTeamSlug = "agency";
  app.config.ofapiApiKey = "synthetic-key";
  app.config.publishingEnabled = true;
  app.config.publishingOnlyfansEnabled = true;
  app.config.publishingOnlyfansVaultEnabled = true;
  app.config.onlyfansVaultDailyCredits = 1000;
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
  fileIds = [];
  for (let index = 0; index < 5; index += 1) {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2_000, 10 + index)]);
    fileIds.push((await uploadPublicationFile(app, {
      body: Readable.from([bytes]), declaredLength: bytes.length, model: { pageLabel: "lora-of" }, originalName: `IMG_${index}.jpg`, userId: ownerId,
    })).file.id);
  }

  vault = new Map();
  lists = new Map();
  nextId = 9001;
  creates = [];
  adds = [];
  postsSent = 0;
  listReads = 0;
  listsFail = false;
  createAnswer = (name) => {
    const id = String(nextId++);
    lists.set(id, { name, media: [] });
    return json({ data: { id: Number(id), name, type: "custom" } });
  };
  addAnswer = (listId, mediaIds) => {
    lists.get(listId)?.media.push(...mediaIds);
    return json({ data: { id: Number(listId), type: "custom", name: lists.get(listId)?.name ?? "" } });
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const pathname = parsed.pathname;
    const method = init?.method ?? "GET";
    if (pathname.endsWith("/whoami")) return json({ team: { slug: "agency" } });
    if (pathname.endsWith(`/${ACCOUNT}/posts`)) {
      postsSent += 1;
      return json({ data: { id: 700001, responseType: "post" } });
    }
    if (pathname.endsWith(`/${ACCOUNT}/media/vault/lists`) && method === "GET") {
      listReads += 1;
      if (listsFail) return json({ message: "upstream" }, 500);
      const list = [...lists].map(([id, entry]) => ({ id: Number(id), name: entry.name, type: "custom", mediaCount: entry.media.length }));
      return json({ data: { list, hasMore: false } });
    }
    if (pathname.endsWith(`/${ACCOUNT}/media/vault/lists`) && method === "POST") {
      const sent = bodyOf(init);
      creates.push(sent);
      return createAnswer(String(sent.name));
    }
    const add = new RegExp(`/${ACCOUNT}/media/vault/lists/(\\d+)/media$`).exec(pathname);
    if (add && method === "POST") {
      const mediaIds = (bodyOf(init).mediaIds as unknown[]).map(String);
      adds.push({ listId: add[1]!, mediaIds });
      return addAnswer(add[1]!, mediaIds);
    }
    if (pathname.endsWith(`/${ACCOUNT}/media/vault`) && method === "GET") {
      const listId = parsed.searchParams.get("list") ?? "";
      return json({ data: { list: albumMedia(listId), hasMore: false } });
    }
    const media = new RegExp(`/${ACCOUNT}/media/vault/(\\d+)$`).exec(pathname);
    if (media && method === "GET") {
      const known = vault.get(media[1]!);
      return known ? json({ data: { id: Number(media[1]), type: "photo", isReady: known.isReady, hasError: false } }) : json({ message: "Media not found" }, 404);
    }
    throw new Error(`unexpected OFAPI request ${method} ${pathname}`);
  }));
  app.ofapi = createOfapiClient({ apiKey: "synthetic-key", restDelayMs: 0, ...ofapiCredentialPolicy(app.db, app.config, app.logger) });
});

type UploadAnswer = "done" | "indeterminate" | "refused" | "processing" | { done: number };
/** How the fake OnlyFansAPI answers each upload, by the file's position; "done" by default. */
let uploadAnswers = new Map<number, UploadAnswer>();
/** Every upload the fake runner sent, by position, in order. */
let sent: number[] = [];

/**
 * The upload runner as OnlyFansAPI's answers leave the job (ofapi-media-uploads.ts):
 * a job that dispatched once is never sent again, as the real runner never sends one again.
 */
async function fakeRunUpload(_app: AppContext, _pageId: number, jobId: string) {
  const job = await getOfapiCaptureJob(app.db, jobId);
  if (!job || job.dispatchCount > 0 || job.cursor !== null || job.state !== "ready") return;
  const run = await getOnlyfansVaultAlbumRun(app.db, Number(job.target.publicationId));
  const position = run?.files.find((file) => file.jobId === jobId)?.position ?? -1;
  sent.push(position);
  const answer = uploadAnswers.get(position) ?? "done";
  if (answer === "done" || typeof answer === "object") {
    const id = String(nextId++);
    vault.set(id, { isReady: true });
    const credits = typeof answer === "object" ? answer.done : Number(job.target.maxCredits);
    await testDb!.pool.query(
      `update ofapi_capture_jobs set state = 'complete', completed_at = now(), terminal_observation_id = 1, terminal_observation_received_at = now(), dispatch_count = 1,
              cursor = jsonb_build_object('phase', 'terminal', 'status', 'completed', 'mediaRef', $2::text, 'isReady', false, 'actualCredits', $3::int)
        where id = $1::uuid`, [jobId, id, credits]);
    return;
  }
  if (answer === "processing") {
    await testDb!.pool.query(
      `update ofapi_capture_jobs set state = 'retry_wait', dispatch_count = 1, next_attempt_at = now() + interval '1 day',
              cursor = jsonb_build_object('phase', 'poll', 'uploadId', 'ofapi_media_slow', 'status', 'processing')
        where id = $1::uuid`, [jobId]);
    return;
  }
  await testDb!.pool.query(
    "update ofapi_capture_jobs set state = 'blocked', dispatch_count = 1, reason_code = $2 where id = $1::uuid",
    [jobId, answer === "refused" ? "upload_http_400" : "indeterminate"]);
}

async function approvedAlbum(count = 3, title = "White robe", overrides: Partial<PublicationContentBody> = {}) {
  const body: PublicationContentBody = {
    kind: "vault_album", text: title, media: fileIds.slice(0, count).map((fileId) => ({ source: "file" as const, fileId })), previews: [],
    publishAt: new Date(Date.now() - MIN).toISOString(), expiresAt: null, wallRefs: [], tierRefs: [], priceMills: null,
    repost: false, pinWallRefs: [], replyLock: [], subscribersOnly: false, extraAttachments: [], ...overrides,
  };
  const draft = await createPublicationDraft(app.db, { pageId, body, author: { kind: "human", userId: ownerId }, idempotencyKey: null });
  const [result] = await approvePublications(app.db, { items: [{ id: draft.id, version: draft.version }], userId: ownerId });
  expect(result?.outcome, JSON.stringify(result)).toBe("approved");
  return draft.id;
}

/** Minutes of the executor until the album settles (or `ticks` pass). */
async function runAlbum(ticks = 6) {
  for (let tick = 0; tick < ticks; tick += 1) await runOnlyfansVaultAlbumTick(app, { runUpload: fakeRunUpload });
}

/** One minute of the executor as if it ran `minutes` from now. */
async function tickAt(minutes: number) {
  await runOnlyfansVaultAlbumTick(app, { runUpload: fakeRunUpload, now: new Date(Date.now() + minutes * MIN) });
}

async function statusOf(id: number) {
  return (await testDb!.pool.query<{ status: string; status_reason: string | null; vault_album_ref: string | null }>(
    "select status, status_reason, vault_album_ref from publications where id = $1", [id])).rows[0];
}

async function uploadJobsOf(id: number) {
  return (await testDb!.pool.query<{ n: number }>(
    "select count(*)::int as n from ofapi_capture_jobs where kind = 'media_upload' and (target->>'publicationId')::bigint = $1", [id])).rows[0]!.n;
}

beforeEach(() => {
  uploadAnswers = new Map();
  sent = [];
});

describe("an OnlyFans vault album", () => {
  it("is created once, its files go up one at a time from the folder's end, all added in one request, read back: published", async () => {
    const id = await approvedAlbum(3);
    // The post sender never touches it: an album is never a post.
    await runOnlyfansPublishingTick(app);
    expect(postsSent).toBe(0);
    expect((await statusOf(id))?.status).toBe("approved");

    await runAlbum();
    expect(creates).toEqual([{ name: "White robe" }]);
    expect(sent).toEqual([2, 1, 0]);
    expect(adds).toHaveLength(1);
    const albumId = [...lists.keys()][0]!;
    expect(new Set(adds[0]!.mediaIds)).toEqual(new Set(lists.get(albumId)!.media));
    expect(await statusOf(id)).toMatchObject({ status: "published", status_reason: null, vault_album_ref: albumId });
    const run = await getOnlyfansVaultAlbumRun(app.db, id);
    expect(run?.step).toBe("done");
    expect(run?.priceCredits).toBeGreaterThan(0);
    expect(postsSent).toBe(0);

    // More minutes change nothing.
    await runAlbum(2);
    expect(creates).toHaveLength(1);
    expect(adds).toHaveLength(1);
    expect(sent).toHaveLength(3);
  });

  it("goes into the page's album with its exact title, and leaves alone what it already holds", async () => {
    lists.set("5000", { name: "White robe", media: [] });
    const id = await approvedAlbum(2);
    await runAlbum();
    expect(creates).toEqual([]);
    expect(adds).toEqual([{ listId: "5000", mediaIds: expect.any(Array) }]);
    expect(await statusOf(id)).toMatchObject({ status: "published", vault_album_ref: "5000" });
  });

  it("is not sent when the page has several albums with its title", async () => {
    lists.set("5000", { name: "White robe", media: [] });
    lists.set("5001", { name: "White robe", media: [] });
    const id = await approvedAlbum(2);
    await runAlbum();
    expect(creates).toEqual([]);
    expect(sent).toEqual([]);
    expect(await statusOf(id)).toMatchObject({ status: "missed", status_reason: "not_sent:album_title_ambiguous:2:5000,5001" });
  });
});

describe("one attempt per write", () => {
  it("a lost create answer: one more walk finds the album it made — never a second create", async () => {
    createAnswer = (name) => {
      lists.set("6000", { name, media: [] });
      return json({ message: "upstream timeout" }, 502);
    };
    const id = await approvedAlbum(2);
    await runAlbum();
    expect(creates).toHaveLength(1);
    expect(await statusOf(id)).toMatchObject({ status: "published", vault_album_ref: "6000" });
  });

  it("a lost create answer with no album to show for it: not confirmed, nothing more is sent", async () => {
    createAnswer = () => json({ message: "upstream timeout" }, 502);
    const id = await approvedAlbum(2);
    await runAlbum();
    expect(creates).toHaveLength(1);
    expect(sent).toEqual([]);
    expect((await statusOf(id))?.status).toBe("unknown");
    await runAlbum(2);
    expect(creates).toHaveLength(1);
  });

  it("a lost upload answer: that file is unknown, never uploaded again; the album goes on without it", async () => {
    uploadAnswers.set(1, "indeterminate");
    const id = await approvedAlbum(3);
    await runAlbum();
    expect(sent).toEqual([2, 1, 0]);
    expect(await uploadJobsOf(id)).toBe(3);
    const status = await statusOf(id);
    expect(status?.status).toBe("published");
    expect(status?.status_reason).toBe("files_unknown:1/3:IMG_1.jpg=indeterminate");
    expect(adds[0]!.mediaIds).toHaveLength(2);
  });

  it("three failures in a row stop the uploads; the rest are not tried, nothing is added", async () => {
    for (const position of [4, 3, 2]) uploadAnswers.set(position, "refused");
    const id = await approvedAlbum(5);
    await runAlbum();
    expect(sent).toEqual([4, 3, 2]);
    expect(adds).toEqual([]);
    const status = await statusOf(id);
    expect(status?.status).toBe("rejected");
    expect(status?.status_reason).toContain("files_not_tried:2:three_failures:IMG_0.jpg,IMG_1.jpg");
  });

  it("a lost add answer: the read back decides, the add is never sent again", async () => {
    addAnswer = (listId, mediaIds) => {
      lists.get(listId)?.media.push(...mediaIds);
      return json({ message: "upstream timeout" }, 502);
    };
    const id = await approvedAlbum(2);
    await runAlbum();
    expect(adds).toHaveLength(1);
    expect((await statusOf(id))?.status).toBe("published");
    await runAlbum(2);
    expect(adds).toHaveLength(1);
  });
});

describe("steps that cannot read or write end", () => {
  it("a walk that keeps failing is tried 3 times, 5 minutes apart, then the album is not sent and no more reads follow", async () => {
    listsFail = true;
    const id = await approvedAlbum(2);
    await tickAt(0); // admitted
    await tickAt(1); // walk 1 fails
    await tickAt(2); // within 5 minutes: no read
    expect(listReads).toBe(1);
    await tickAt(7); // walk 2
    await tickAt(13); // walk 3: gives up
    expect(listReads).toBe(3);
    expect(await statusOf(id)).toMatchObject({ status: "missed" });
    expect((await statusOf(id))?.status_reason).toMatch(/^not_sent:lists_not_read:/);
    await tickAt(30);
    expect(listReads).toBe(3);
    expect(creates).toEqual([]);
  });

  it("a create that does not leave is tried again without a new walk for 10 minutes; after 90 minutes it is cancelled and the album is not sent", async () => {
    const id = await approvedAlbum(2);
    await tickAt(0); // admitted
    // The transport is down for the create: the action stays prepared.
    const original = app.ofapi!.dispatchGovernedRaw!.bind(app.ofapi);
    const transport = vi.spyOn(app.ofapi!, "dispatchGovernedRaw").mockImplementation(async (context, request) => {
      if (request.operation === "ofapi_command_action_vault_list_create") throw new Error("transport down");
      return original(context, request);
    });
    await tickAt(1); // walk, then the create does not leave
    expect(listReads).toBe(1);
    await tickAt(3);
    await tickAt(8);
    expect(listReads).toBe(1);
    await tickAt(15); // past 10 minutes: a fresh walk
    expect(listReads).toBe(2);
    await tickAt(95); // past 90 minutes from the first try: cancelled
    transport.mockRestore();
    expect(await statusOf(id)).toMatchObject({ status: "missed", status_reason: "not_sent:album_create_not_sent" });
    const state = (await testDb!.pool.query<{ state: string }>(
      "select state from ofapi_action_intents where action = 'vault_list_create'")).rows;
    expect(state).toEqual([{ state: "cancelled" }]);
    await tickAt(100);
    expect(creates).toEqual([]);
  });
});

describe("money", () => {
  it("stops the uploads once the spend would pass the price kept with the run by 10 %", async () => {
    uploadAnswers.set(2, { done: 200 });
    const id = await approvedAlbum(3);
    await runAlbum();
    expect(sent).toEqual([2]);
    const status = await statusOf(id);
    expect(status?.status).toBe("published");
    expect(status?.status_reason).toBe("files_not_tried:2:price_exceeded:IMG_0.jpg,IMG_1.jpg");
  });

  it("a ceiling of 0 is a pause, a price above a whole ceiling returns the album to a person", async () => {
    app.config.onlyfansVaultDailyCredits = 0;
    const paused = await approvedAlbum(2);
    await runAlbum(1);
    expect(await statusOf(paused)).toMatchObject({ status: "approved", status_reason: "held: vault_credits_paused" });

    app.config.onlyfansVaultDailyCredits = 5;
    await runAlbum(1);
    expect(await statusOf(paused)).toMatchObject({ status: "draft" });
    expect((await statusOf(paused))?.status_reason).toMatch(/^album_over_daily_credits/);
    expect(sent).toEqual([]);
  });

  it("a late upload outcome is taken by a re-send without paying again", async () => {
    uploadAnswers.set(0, "processing");
    const first = await approvedAlbum(1, "Late one");
    await runAlbum(2);
    // Processing for more than 90 minutes: the album no longer waits for it.
    const run = (await getOnlyfansVaultAlbumRun(app.db, first))!;
    await saveOnlyfansVaultAlbumRun(app.db, {
      ...run, files: run.files.map((file) => ({ ...file, startedAt: new Date(Date.now() - 2 * 60 * MIN).toISOString() })),
    });
    await runAlbum(2);
    // Its only file may have gone: not confirmed, never uploaded again by itself.
    expect(await statusOf(first)).toMatchObject({ status: "unknown", status_reason: "files_unknown:1/1:IMG_0.jpg=still_processing" });
    const jobId = (await getOnlyfansVaultAlbumRun(app.db, first))!.files[0]!.jobId!;
    // Its job lives on: the late outcome lands in it.
    vault.set("8888", { isReady: true });
    await testDb!.pool.query(
      `update ofapi_capture_jobs set state = 'complete', completed_at = now(), terminal_observation_id = 1, terminal_observation_received_at = now(),
              cursor = jsonb_build_object('phase', 'terminal', 'status', 'completed', 'mediaRef', '8888', 'actualCredits', 3)
        where id = $1::uuid`, [jobId]);

    const again = await approvedAlbum(1, "Late one again");
    await runAlbum();
    expect(sent).toEqual([0]);
    expect(await uploadJobsOf(again)).toBe(0);
    expect(adds.at(-1)?.mediaIds).toEqual(["8888"]);
    expect((await statusOf(again))?.status).toBe("published");
  });
});

describe("switched off", () => {
  it("a queued upload job does not leave after the albums are switched off; on again, it goes once", async () => {
    const id = await approvedAlbum(1);
    // The executor queues the upload; nothing runs it yet.
    for (let tick = 0; tick < 3; tick += 1) await runOnlyfansVaultAlbumTick(app, { runUpload: async () => undefined });
    const jobId = (await getOnlyfansVaultAlbumRun(app.db, id))!.files[0]!.jobId;
    expect(jobId).not.toBeNull();

    app.config.publishingOnlyfansVaultEnabled = false;
    const transport = vi.spyOn(app.ofapi!, "dispatchGovernedRaw");
    await runOfapiMediaUploadSweep(app);
    expect(transport.mock.calls.filter((call) => (call[1] as { operation?: string }).operation === "ofapi_upload_vault")).toEqual([]);
    const held = await getOfapiCaptureJob(app.db, jobId!);
    expect(held).toMatchObject({ state: "blocked", reasonCode: "vault_album_held", dispatchCount: 0 });

    // Nothing of the album moves while off.
    await runAlbum(2);
    expect(sent).toEqual([]);
    expect((await statusOf(id))?.status).toBe("submitting");

    app.config.publishingOnlyfansVaultEnabled = true;
    await runAlbum();
    expect(sent).toEqual([0]);
    expect((await statusOf(id))?.status).toBe("published");
  });
});

describe("never a post", () => {
  it("the post command builder refuses an album", async () => {
    const id = await approvedAlbum(1);
    const album = (await getPublication(app.db, id))!;
    expect(() => onlyfansCommandFor(album, "now")).toThrow(/never sent as a post/);
  });
});
