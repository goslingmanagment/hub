import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createFanslyPage,
  createOnlyFansPage,
  createModel,
  createUser,
  DM_ARCHIVE_ERASURE_FENCE_LOCK_NS,
  upsertCreatorRawMedia,
  type UpsertCreatorRawMediaInput,
} from "@agency_hub_core/db";
import { executeErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

let db: StartedTestDatabase;
let pageId: number;
let ownerId: number;
beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Raw media erasure tests require PostgreSQL");
  db = started;
}, 120000);
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await resetIntegrationDatabase(db.pool);
  const model = (await createModel(db.db, {
    slug: "raw-media-fence",
    name: "Raw media fence",
  }))!;
  pageId = (await createFanslyPage(db.db, {
    modelId: model.id,
    label: "raw-media-fence",
  }))!.id;
  ownerId = (await createUser(db.db, {
    username: "owner",
    role: "owner",
    passwordHash: null,
  }))!.id;
});
const mediaFixtures = [
  { platform: "fansly", sourceKind: "vault_media", createPage: createFanslyPage },
  { platform: "onlyfans", sourceKind: "ofapi.collection_read_response.v1", createPage: createOnlyFansPage },
] as const;
function snapshot(
  fixture: Pick<UpsertCreatorRawMediaInput, "platform" | "sourceKind"> = mediaFixtures[0],
): UpsertCreatorRawMediaInput {
  return {
    pageId,
    platform: fixture.platform,
    mediaRef: "321",
    ownerAccountRef: null,
    filename: "owned.png",
    mediaType: null,
    providerType: "photo",
    mimeType: "image/png",
    durationMs: null,
    originalWidth: null,
    originalHeight: null,
    width: 1,
    height: 1,
    frameRateMilli: null,
    createdAtPlatform: null,
    updatedAtPlatform: null,
    sourceKind: fixture.sourceKind,
    firstOrigin: "vault",
    observedAt: new Date(Date.now() - 1000),
    contentHash: "a".repeat(64),
    sourceEventId: 1,
    sourceObservationId: 1,
    sourceAccountSeq: 1,
  };
}
describe("raw media erasure writer fence", () => {
  it.each(mediaFixtures)(
    "prevents an already loaded $platform event recreating erased media while admitting later observations",
    async (fixture) => {
      const pageLabel = `${fixture.platform}-media-fence`;
      const model = (await createModel(db.db, {
        slug: pageLabel,
        name: pageLabel,
      }))!;
      pageId = (await fixture.createPage(db.db, {
        modelId: model.id,
        label: pageLabel,
      }))!.id;
      const loadedBeforeErasure = snapshot(fixture);
      expect(await upsertCreatorRawMedia(db.db, loadedBeforeErasure)).toEqual({
        applied: true,
      });
      const app = createTestAppContext(db);
      await executeErasure(
        app,
        {
          scopeType: "page",
          pageLabel,
        },
        { initiatedBy: ownerId },
      );
      expect(await upsertCreatorRawMedia(db.db, loadedBeforeErasure)).toEqual({
        applied: false,
      });
      expect(
        (
          await db.pool.query(
            "select count(*)::int n from creator_raw_media where page_id=$1",
            [pageId],
          )
        ).rows[0].n,
      ).toBe(0);
      const tombstone = (
        await db.pool.query(
          "select max(started_at) at from erasure_log where dry_run=false",
        )
      ).rows[0].at as Date;
      expect(
        await upsertCreatorRawMedia(db.db, {
          ...loadedBeforeErasure,
          observedAt: new Date(tombstone.getTime() + 1000),
          sourceAccountSeq: 2,
        }),
      ).toEqual({ applied: true });
    },
  );
  it("defers writes while the erasure lock is held and retries after it releases", async () => {
    const client = await db.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1::int,$2::int)", [
        DM_ARCHIVE_ERASURE_FENCE_LOCK_NS,
        pageId,
      ]);
      await expect(upsertCreatorRawMedia(db.db, snapshot())).rejects.toThrow(
        "deferred during page erasure",
      );
      expect(
        (await db.pool.query("select count(*)::int n from creator_raw_media"))
          .rows[0].n,
      ).toBe(0);
    } finally {
      await client.query("rollback");
      client.release();
    }
    expect(await upsertCreatorRawMedia(db.db, snapshot())).toEqual({
      applied: true,
    });
  });
});
