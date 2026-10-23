import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicationContentBody } from "@agency_hub_core/contracts";
import { createModel, createOnlyFansPage, getOfapiCaptureJob, setPageOfapiAccountId } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCredentialPolicy } from "../apps/runtime/src/services/ofapi-credential-policy.ts";
import { buildOfapiMediaUploadRequest } from "../apps/runtime/src/services/ofapi-media-uploads.ts";
import { uploadPublicationFile } from "../apps/runtime/src/services/publication-files.ts";
import { runOnlyfansPublishingTick } from "../apps/runtime/src/services/publications-onlyfans.ts";
import { approvePublications, createPublicationDraft } from "../apps/runtime/src/services/publications.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

/**
 * New files on OnlyFans (plan PR 4c), against a stub OnlyFansAPI. A new file
 * of an approved OnlyFans post goes up first through the OnlyFansAPI uploader
 * — its bytes read from the publication's file on disk, the second byte
 * source — once per file of an approval; the post waits for it and then goes
 * with the upload's one-use id. A failed upload sends nothing and returns the
 * post to a person; approving it again uploads anew. Uploads count toward the
 * publications' own credits per day.
 */

const ACCOUNT = "acct_25000000000000000000000000000000";
const DAY = 24 * 60 * 60_000;
// A JPEG both Hub's file store and OnlyFansAPI's uploader take.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2_000, 7)]);

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let root = "";
let pageId = 0;
let ownerId = 0;
let fileId = 0;
let posts: Array<Record<string, unknown>> = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  root = await mkdtemp(path.join(tmpdir(), "publication-uploads-"));
  app.config.publicationFilesDir = root;
  app.config.ofapiExpectedTeamSlug = "agency";
  app.config.publishingEnabled = true;
  app.config.publishingOnlyfansEnabled = true;
  const model = await createModel(app.db, { slug: "lora", name: "Lora" });
  pageId = (await createOnlyFansPage(app.db, { modelId: model.id, label: "lora-of" })).id;
  await setPageOfapiAccountId(app.db, { pageId, ofapiAccountId: ACCOUNT });
  ownerId = (await createUserAccount(app, { username: "owner", role: "owner", password: "owner-password-for-tests" }, { source: "cli" })).id;
  await testDb.pool.query("insert into page_publishing_settings (page_id, enabled) values ($1, true)", [pageId]);
  fileId = (await uploadPublicationFile(app, {
    body: Readable.from([JPEG]), declaredLength: JPEG.length, model: { pageLabel: "lora-of" }, originalName: "set.jpg", userId: ownerId,
  })).file.id;

  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname.endsWith("/whoami")) return json({ team: { slug: "agency" } });
    if (pathname.endsWith(`/${ACCOUNT}/posts`) && init?.method === "POST") {
      posts.push(JSON.parse(typeof init.body === "string" ? init.body : Buffer.from(init.body as Uint8Array).toString("utf8")) as Record<string, unknown>);
      return json({ data: { id: 700000 + posts.length, responseType: "post" } });
    }
    throw new Error(`unexpected OFAPI request ${init?.method ?? "GET"} ${pathname}`);
  }));
  app.ofapi = createOfapiClient({ apiKey: "synthetic-key", restDelayMs: 0, ...ofapiCredentialPolicy(app.db, app.config, app.logger) });
});

function body(overrides: Partial<PublicationContentBody> = {}): PublicationContentBody {
  return {
    kind: "subscriber_post", text: "new set", media: [{ source: "file", fileId }], previews: [],
    publishAt: new Date(Date.now() + 2 * DAY).toISOString(), expiresAt: null, wallRefs: [], tierRefs: [], priceMills: null,
    repost: false, ...overrides,
  };
}

async function approve(id: number) {
  const version = (await testDb!.pool.query<{ version: number }>("select version from publications where id = $1", [id])).rows[0]!.version;
  const [result] = await approvePublications(app.db, { items: [{ id, version }], userId: ownerId });
  expect(result?.outcome, JSON.stringify(result)).toBe("approved");
}

async function approved() {
  const draft = await createPublicationDraft(app.db, { pageId, body: body(), author: { kind: "human", userId: ownerId }, idempotencyKey: null });
  expect(draft.findings).toEqual([]);
  await approve(draft.id);
  return draft.id;
}

async function uploadsOf(id: number) {
  const rows = await testDb!.pool.query<{ capture_job_id: string; revision_id: string; estimated_credits: number }>(
    "select capture_job_id::text, revision_id::text, estimated_credits from publication_uploads where publication_id = $1 order by id", [id],
  );
  return rows.rows;
}

async function finishUpload(jobId: string, token: string) {
  await testDb!.pool.query(
    `update ofapi_capture_jobs set state = 'complete',
            cursor = jsonb_build_object('phase', 'terminal', 'status', 'completed', 'mediaRef', $2::text)
      where id = $1::uuid`,
    [jobId, token],
  );
}

async function statusOf(id: number) {
  return (await testDb!.pool.query<{ status: string; status_reason: string | null }>("select status, status_reason from publications where id = $1", [id])).rows[0];
}

describe("a new file on an OnlyFans post", () => {
  it("goes up once from the file on disk; the post waits for it and then goes with its one-use id", async () => {
    const id = await approved();
    await runOnlyfansPublishingTick(app);
    const [upload] = await uploadsOf(id);
    expect(upload).toBeDefined();
    expect(posts).toEqual([]);
    expect(await statusOf(id)).toMatchObject({ status: "approved" });

    // The uploader reads the bytes from the publication's file, not from an observation.
    const job = await getOfapiCaptureJob(app.db, upload!.capture_job_id);
    expect(job).toMatchObject({ kind: "media_upload", target: expect.objectContaining({ destination: "cdn" }) });
    const request = await buildOfapiMediaUploadRequest(app, job!);
    expect(request?.pathname).toBe(`/${ACCOUNT}/media/upload`);
    expect(request?.bodyBytes?.includes(JPEG)).toBe(true);

    await runOnlyfansPublishingTick(app);
    expect(await uploadsOf(id)).toHaveLength(1);
    expect(posts).toEqual([]);

    await finishUpload(upload!.capture_job_id, "ofapi_media_abc123");
    await runOnlyfansPublishingTick(app);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ text: "new set", mediaFiles: ["ofapi_media_abc123"] });
    expect(await statusOf(id)).toMatchObject({ status: "scheduled" });
  });

  it("a failed upload sends no post and returns it to a person; approved again, it uploads anew", async () => {
    const id = await approved();
    await runOnlyfansPublishingTick(app);
    const [first] = await uploadsOf(id);
    await testDb!.pool.query("update ofapi_capture_jobs set state = 'blocked', reason_code = 'upload_failed' where id = $1::uuid", [first!.capture_job_id]);

    await runOnlyfansPublishingTick(app);
    expect(posts).toEqual([]);
    expect(await statusOf(id)).toMatchObject({ status: "draft", status_reason: "upload_upload_failed" });

    await approve(id);
    await runOnlyfansPublishingTick(app);
    const uploads = await uploadsOf(id);
    expect(uploads).toHaveLength(2);
    expect(uploads[1]!.capture_job_id).not.toBe(first!.capture_job_id);
    expect(uploads[1]!.revision_id).not.toBe(first!.revision_id);
  });

  it("an upload past the publications' credits for the day waits; nothing is sent", async () => {
    app.config.publishingOnlyfansDailyCredits = 0;
    const id = await approved();
    await runOnlyfansPublishingTick(app);
    expect(await uploadsOf(id)).toEqual([]);
    expect(posts).toEqual([]);
    expect(await statusOf(id)).toMatchObject({ status: "approved" });
  });
});
