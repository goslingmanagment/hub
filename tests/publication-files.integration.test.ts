import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createFanslyPage, createModel, type Database } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import {
  openPublicationFile,
  readPublicationFileBytes,
  runPublicationFileRetention,
} from "../apps/runtime/src/services/publication-files.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

/**
 * Files of publications on disk (docs/plans/2026-10-23-wall-posts, plan PR 3):
 * the owner's upload streams raw bytes to <root>/<model>/<sha256>; the same
 * bytes for the same model are one row; a non-image, a file over its limit and
 * an upload past the total are refused; retention deletes the bytes of files
 * no unfinished publication uses 7 days after the last one finished (or after
 * an unused upload) and keeps the row; a new upload restores them under the
 * same id; a draft cannot take a deleted file.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("a small picture, not a real one")]);
const OTHER_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.from("another picture")]);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let ownerCookie = "";
let root = "";
let lillyModelId = 0;
let loraModelId = 0;
let lillyPageId = 0;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 180_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

async function sql(text: string, values: unknown[] = []) {
  return testDb!.pool.query(text, values);
}

async function upload(bytes: Buffer, query: string) {
  return server!.inject({
    method: "POST",
    url: `/api/v1/admin/publications/files?${query}`,
    headers: { cookie: ownerCookie, "content-type": "application/octet-stream" },
    payload: bytes,
  });
}

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb);
  root = await mkdtemp(path.join(tmpdir(), "publication-files-"));
  appContext.config.publicationFilesDir = root;

  const lilly = await createModel(db(), { slug: "lilly", name: "Lilly" });
  const lora = await createModel(db(), { slug: "lora", name: "Lora" });
  lillyModelId = lilly.id;
  loraModelId = lora.id;
  lillyPageId = (await createFanslyPage(db(), { modelId: lilly.id, label: "lilly-1" })).id;
  await sql(
    `insert into page_walls (page_id, platform, wall_ref, name, default_wall, main_wall, first_observed_at, last_observed_at,
                             content_hash, source_event_id, source_observation_id, source_account_seq)
     values ($1, 'fansly', 'wall-main', 'Main', true, true, now(), now(), $2, 1, 1, 1)`,
    [lillyPageId, "a".repeat(64)],
  );
  await createUserAccount(appContext, { username: "owner", role: "owner", password: "owner-secret" }, { source: "cli" });
  await createUserAccount(appContext, { username: "lead", role: "team_lead", password: "lead-secret" }, { source: "cli" });

  await server?.close();
  server = await buildApiServer(appContext);
  await server.ready();
  const response = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "owner", password: "owner-secret" } });
  const setCookie = response.headers["set-cookie"];
  ownerCookie = String((Array.isArray(setCookie) ? setCookie[0] : setCookie) ?? "").split(";")[0] ?? "";
  expect(ownerCookie).not.toBe("");
});

afterEach(async () => {
  await server?.close();
  server = null;
  await rm(root, { recursive: true, force: true });
});

describe("publication files: upload", () => {
  it("stores the bytes by model and sha256, and the same bytes answer the same file", async () => {
    const first = await upload(JPEG, "modelSlug=lilly&name=" + encodeURIComponent("beach/01.jpg"));
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.created).toBe(true);
    expect(body.file).toMatchObject({
      modelId: lillyModelId, modelSlug: "lilly", sha256: sha(JPEG), byteSize: JPEG.length,
      mimeType: "image/jpeg", originalName: "beach_01.jpg", stored: true, uses: [],
    });
    expect((await stat(path.join(root, String(lillyModelId), sha(JPEG)))).size).toBe(JPEG.length);

    const again = await upload(JPEG, "pageLabel=lilly-1");
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ created: false, file: { id: body.file.id } });

    const otherModel = await upload(JPEG, `modelId=${loraModelId}`);
    expect(otherModel.json().file.id).not.toBe(body.file.id);
    expect(await readdir(path.join(root, ".incoming"))).toEqual([]);

    const read = await readPublicationFileBytes(appContext, body.file.id, { maxBytes: 100_000_000 });
    expect(read.bytes.equals(JPEG)).toBe(true);
    expect(read.mimeType).toBe("image/jpeg");

    const list = await server!.inject({ method: "GET", url: "/api/v1/admin/publications/files?modelSlug=lilly", headers: { cookie: ownerCookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().files.map((file: { id: number }) => file.id)).toEqual([body.file.id]);
    expect(list.json().storedTotalBytes).toBe(2 * JPEG.length);
  });

  it("refuses a non-image, a file over its limit and an upload past the total; only the owner uploads", async () => {
    const text = await upload(Buffer.from("just some text, not a picture"), "modelSlug=lilly");
    expect(text.statusCode).toBe(415);
    expect(text.json().error).toBe("publication_file_type");

    appContext.config.publicationFileMaxMb = 1;
    const big = Buffer.concat([JPEG, Buffer.alloc(1_000_001)]);
    const tooLarge = await upload(big, "modelSlug=lilly");
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().error).toBe("publication_file_too_large");

    appContext.config.publicationFilesMaxTotalGb = 1;
    await sql("insert into publication_files (model_id, content_sha256, byte_size, mime_type) values ($1, $2, $3, 'video/mp4')",
      [loraModelId, "f".repeat(64), 999_999_990]);
    const full = await upload(JPEG, "modelSlug=lilly");
    expect(full.statusCode).toBe(507);
    expect(full.json().error).toBe("publication_files_full");
    expect(await readdir(path.join(root, ".incoming"))).toEqual([]);

    const unknownModel = await upload(JPEG, "modelSlug=nobody");
    expect(unknownModel.statusCode).toBe(404);
    const twoNames = await upload(JPEG, "modelSlug=lilly&pageLabel=lilly-1");
    expect(twoNames.statusCode).toBe(400);

    const login = await server!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "lead", password: "lead-secret" } });
    const leadCookie = String(login.headers["set-cookie"] ?? "").split(";")[0] ?? "";
    const lead = await server!.inject({
      method: "POST", url: "/api/v1/admin/publications/files?modelSlug=lilly",
      headers: { cookie: leadCookie, "content-type": "application/octet-stream" }, payload: JPEG,
    });
    expect(lead.statusCode).toBe(403);
  });
});

describe("publication files: retention (spec §7)", () => {
  async function draftWith(fileId: number) {
    const response = await server!.inject({
      method: "POST", url: "/api/v1/admin/publications", headers: { cookie: ownerCookie },
      payload: {
        pageLabel: "lilly-1", kind: "fyp_post", text: "hi", media: [{ source: "file", fileId }],
        publishAt: new Date(Date.now() + 3 * DAY_MS).toISOString(),
      },
    });
    return response;
  }

  it("keeps bytes in use, deletes them 7 days after the last finish, keeps the row, and a new upload restores them", async () => {
    const used = (await upload(JPEG, "modelSlug=lilly")).json().file.id as number;
    const unused = (await upload(OTHER_JPEG, "modelSlug=lilly")).json().file.id as number;
    const draft = await draftWith(used);
    expect(draft.statusCode).toBe(200);
    const publicationId = draft.json().id as number;
    await sql("update publication_files set stored_at = now() - interval '30 days'");

    // The draft keeps its file however old; the unused upload goes.
    let summary = await runPublicationFileRetention(appContext);
    expect(summary).toMatchObject({ deleted: 1, failed: 0 });
    await expect(openPublicationFile(appContext, used)).resolves.toMatchObject({ byteSize: JPEG.length });
    await expect(openPublicationFile(appContext, unused)).rejects.toThrow(/deleted/);
    await expect(stat(path.join(root, String(lillyModelId), sha(OTHER_JPEG)))).rejects.toThrow();
    const row = (await sql("select bytes_deleted_at, content_sha256 from publication_files where id = $1", [unused])).rows[0];
    expect(row.bytes_deleted_at).not.toBeNull();
    expect(row.content_sha256).toBe(sha(OTHER_JPEG));

    // Cancelled 6 days ago: still kept. 8 days ago: deleted.
    const cancel = await server!.inject({ method: "POST", url: `/api/v1/admin/publications/${publicationId}/cancel`, headers: { cookie: ownerCookie } });
    expect(cancel.statusCode).toBe(200);
    await sql("update publications set status_changed_at = now() - interval '6 days' where id = $1", [publicationId]);
    summary = await runPublicationFileRetention(appContext);
    expect(summary.deleted).toBe(0);
    await sql("update publications set status_changed_at = now() - interval '8 days' where id = $1", [publicationId]);
    summary = await runPublicationFileRetention(appContext);
    expect(summary.deleted).toBe(1);

    // A draft cannot take a deleted file; the same bytes again bring it back under its id.
    const refused = await draftWith(used);
    expect(refused.statusCode).toBe(400);
    const restored = await upload(JPEG, "modelSlug=lilly");
    expect(restored.json()).toMatchObject({ created: false, file: { id: used, stored: true, bytesDeletedAt: null } });
    expect((await draftWith(used)).statusCode).toBe(200);
  });

  it("clears uploads a crash left half-way, and nothing younger", async () => {
    const incoming = path.join(root, ".incoming");
    await mkdir(incoming, { recursive: true });
    await writeFile(path.join(incoming, "old.part"), "x");
    await writeFile(path.join(incoming, "new.part"), "x");
    const old = new Date(Date.now() - 2 * DAY_MS);
    await utimes(path.join(incoming, "old.part"), old, old);
    const summary = await runPublicationFileRetention(appContext);
    expect(summary.incomingRemoved).toBe(1);
    expect(await readdir(incoming)).toEqual(["new.part"]);
  });
});
