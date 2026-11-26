import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  admitFanslyWriteCommand,
  findPageVaultAlbumRefs,
  insertAgentKey,
  settleFanslyWriteCommand,
  type Database,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { seedSyncPage } from "./helpers/sync-engine-host.ts";

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

/**
 * An agent renames a Fansly vault album of its page (0451): the album among
 * the page's albums Hub knows, by its title now or its id; ONE `album_edit`
 * command with no publication, the description as Hub knew it; the same ask
 * again answers from it; the title Fansly confirmed is Hub's copy at once —
 * the next rename and a vault-album draft find the album by it.
 */

const DAY = 24 * 60 * 60_000;
const HASH = "f".repeat(64);
/** Drafts and approves vault albums, on lilly-1. */
const RENAMER = `${AGENT_KEY_TOKEN_PREFIX}album-renamer`;
/** Drafts only, on lilly-1. */
const DRAFTER = `${AGENT_KEY_TOKEN_PREFIX}album-drafter`;
/** Drafts and approves vault albums, on lora-1 only. */
const OUTSIDE = `${AGENT_KEY_TOKEN_PREFIX}album-outside`;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;
let attemptId = 9000;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

afterEach(async () => {
  await server?.close();
  server = null;
});

async function sql<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await testDb!.pool.query<T>(text, values)).rows;
}

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  app.config.publishingEnabled = true;
  ({ pageId } = await seedSyncPage({ db: app.db as unknown as Database, pool: testDb.pool }, { label: "lilly-1", mode: "live", guard: "fansly_sync_engine" }));
  const { pageId: otherPageId } = await seedSyncPage({ db: app.db as unknown as Database, pool: testDb.pool }, { label: "lora-1" });
  await sql("update sync_pages set transport = 'browser' where page_id = $1", [pageId]);
  await sql("insert into page_publishing_settings (page_id, enabled) values ($1, true)", [pageId]);
  const ownerId = (await createUserAccount(app, { username: "owner", role: "owner", password: "owner-password-for-tests" }, { source: "cli" })).id;
  for (const [token, name, capabilities, pageIds] of [
    [RENAMER, "album-renamer", ["write:publication_drafts", "approve:vault_albums"], [pageId]],
    [DRAFTER, "album-drafter", ["write:publication_drafts"], [pageId]],
    [OUTSIDE, "album-outside", ["write:publication_drafts", "approve:vault_albums"], [otherPageId]],
  ] as const) {
    await insertAgentKey(app.db, {
      name,
      keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(token),
      capabilities: [...capabilities] as never,
      pageIds: [...pageIds],
      expiresAt: new Date(Date.now() + 30 * DAY),
      createdBy: ownerId,
    });
  }
  for (const [ref, title, description] of [["11", "PPV-018 Белое бельё", "белое"], ["12", "SEXTING 1", ""], ["13", "SEXTING 1 ", ""]]) {
    await sql(
      `insert into creator_vault_albums (page_id, platform, vault_kind, album_ref, title, description, first_observed_at, last_observed_at,
                                         content_hash, source_event_id, source_observation_id, source_account_seq)
       values ($1, 'fansly', 'creator', $2, $3, $4, now() - interval '1 hour', now() - interval '1 hour', $5, 1, 1, 1)`,
      [pageId, ref, title, description, HASH],
    );
  }
  server = await buildApiServer(app);
  await server.ready();
});

const rename = (token: string, payload: Record<string, unknown>, page = "lilly-1") =>
  server!.inject({ method: "POST", url: `/api/v1/agent/pages/${page}/vault-album-renames`, headers: { authorization: `Bearer ${token}` }, payload });
const follow = (token: string, id: number) =>
  server!.inject({ method: "GET", url: `/api/v1/agent/pages/lilly-1/vault-album-renames/${id}`, headers: { authorization: `Bearer ${token}` } });
const commands = () => sql<{ id: string; step: string; album_ref: string; album_title: string; album_description: string; publication_id: string | null; state: string }>(
  "select id::text, step, album_ref, album_title, album_description, publication_id::text, state from fansly_write_commands order by id",
);

async function answer(id: string, title: string) {
  attemptId += 1;
  expect(await admitFanslyWriteCommand(app.db, {
    id: Number(id), attemptId, workId: 1,
    request: { spec: "publish.vault_album_edit", method: "POST", host: "api", pathAndQuery: "/api/v1/vault/albums/edit", body: "", fingerprint: "e".repeat(64) },
  })).toBe(true);
  expect(await settleFanslyWriteCommand(app.db, { id: Number(id), attemptId, to: "answered", reason: null, result: { albumId: "11", title, description: "белое" } })).toBe(true);
}

describe("vault-album-rename", () => {
  it("one command for the album named by its title; the same ask again answers from it; Fansly's answer is Hub's title at once", async () => {
    const first = await rename(RENAMER, { album: "PPV-018 Белое бельё", title: "PPV-024 Белое бельё" });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      pageLabel: "lilly-1", albumRef: "11", fromTitle: "PPV-018 Белое бельё", title: "PPV-024 Белое бельё",
      outcome: "accepted", repeat: false, command: { state: "queued" },
    });
    // No publication; the description goes as Hub knew it.
    expect(await commands()).toEqual([expect.objectContaining({
      step: "album_edit", album_ref: "11", album_title: "PPV-024 Белое бельё", album_description: "белое", publication_id: null, state: "queued",
    })]);
    const commandId = first.json().commandId as number;
    expect((await rename(RENAMER, { albumRef: "11", title: "PPV-024 Белое бельё" })).json()).toMatchObject({ outcome: "accepted", repeat: true, commandId });
    expect((await rename(RENAMER, { albumRef: "11", title: "PPV-025" })).json()).toMatchObject({ outcome: "refused", reason: "rename_in_progress" });
    expect(await commands()).toHaveLength(1);
    expect(await sql("select resource, subject from sync_work where resource = 'publish.background'")).toEqual([{ resource: "publish.background", subject: String(commandId) }]);

    await answer(String(commandId), "PPV-024 Белое бельё");
    expect((await follow(RENAMER, commandId)).json()).toMatchObject({ outcome: "renamed", albumRef: "11", title: "PPV-024 Белое бельё" });
    // Hub's copy: a draft of the new title finds the album, of the old one none.
    expect(await findPageVaultAlbumRefs(app.db, pageId, "PPV-024 Белое бельё")).toEqual(["11"]);
    expect(await findPageVaultAlbumRefs(app.db, pageId, "PPV-018 Белое бельё")).toEqual([]);
    // The next rename names it by its new title.
    expect((await rename(RENAMER, { album: "PPV-018 Белое бельё", title: "PPV-026" })).json()).toMatchObject({ outcome: "refused", reason: "album_not_found" });
    expect((await rename(RENAMER, { album: "PPV-024 Белое бельё", title: "PPV-024 Белое бельё" })).json()).toMatchObject({ outcome: "renamed", repeat: true });
    expect((await rename(RENAMER, { album: "PPV-024 Белое бельё", title: "PPV-026" })).json()).toMatchObject({ outcome: "accepted", repeat: false });

    expect(await sql("select metadata->>'albumRef' as album, metadata->>'outcome' as outcome from audit_events where event_type = 'admin.vault_album_rename' order by id"))
      .toEqual(expect.arrayContaining([{ album: "11", outcome: "accepted" }]));
  });

  it("refuses an album it cannot tell, a title another album holds, and a key or page without the right — nothing queued", async () => {
    const twins = (await rename(RENAMER, { album: "SEXTING 1", title: "SEXTING 2" })).json();
    expect(twins).toMatchObject({ outcome: "refused", reason: "album_title_ambiguous" });
    expect(twins.albums.map((album: { albumRef: string }) => album.albumRef)).toEqual(["12", "13"]);
    expect((await rename(RENAMER, { albumRef: "11", title: "SEXTING 1" })).json()).toMatchObject({ outcome: "refused", reason: "title_taken" });
    expect((await rename(RENAMER, { albumRef: "99", title: "X" })).json()).toMatchObject({ outcome: "refused", reason: "album_not_found" });
    expect((await rename(RENAMER, { title: "X" })).statusCode).toBe(400);
    expect((await rename(DRAFTER, { albumRef: "11", title: "X" })).statusCode).toBe(403);
    expect((await rename(OUTSIDE, { albumRef: "11", title: "X" })).statusCode).toBe(404);
    // Publishing off: the switch a create needs says no before anything is written.
    app.config.publishingEnabled = false;
    expect((await rename(RENAMER, { albumRef: "11", title: "X" })).json()).toMatchObject({ outcome: "refused", reason: "publishing_off" });
    expect(await commands()).toEqual([]);
  });
});
