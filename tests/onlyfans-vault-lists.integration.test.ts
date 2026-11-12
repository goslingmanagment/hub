import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyOnlyfansVaultListWalk,
  createModel,
  createOnlyFansPage,
  findPageVaultAlbumRefs,
  getOnlyfansVaultListWalk,
  listOnlyfansVaultLists,
  requestOnlyfansVaultListWalk,
  type OnlyfansVaultListInput,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

// OnlyFans vault lists (0394): «missing» only from a complete walk; a walk cut
// short marks nothing; a list seen again is not missing.

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;

const album = (listRef: string, name: string): OnlyfansVaultListInput => ({ listRef, name, type: "custom", mediaCount: 3 });
const at = (day: number) => new Date(Date.UTC(2026, 10, day, 12));
const walk = (day: number, lists: OnlyfansVaultListInput[], complete: boolean) => applyOnlyfansVaultListWalk(app.db, {
  pageId, seenAt: at(day), lists, complete, requests: 1, failure: complete ? null : "read_budget", answeredRequestAt: null,
});
const missing = async () => Object.fromEntries((await listOnlyfansVaultLists(app.db, pageId)).map((list) => [list.listRef, list.missingSince !== null]));

describe("OnlyFans vault lists", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    const model = await createModel(app.db, { slug: "vault-lists", name: "Vault lists" });
    pageId = (await createOnlyFansPage(app.db, { modelId: model!.id, label: "vault-lists-of" }))!.id;
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  it("a walk answers its request: the request does not stay pending and is not walked again", async (context) => {
    if (!testDb) return context.skip();
    const user = await testDb.pool.query<{ id: string }>(
      "insert into users (username, role) values ('vault-lists-owner', 'owner') returning id",
    );
    await requestOnlyfansVaultListWalk(app.db, { pageId, userId: Number(user.rows[0]!.id) });
    // A request as production held it: its moment with microseconds, which a Date does not carry.
    await testDb.pool.query(
      "update onlyfans_vault_list_walks set requested_at = date_trunc('milliseconds', now()) + interval '112 microseconds' where page_id = $1",
      [pageId],
    );
    // The job reads the request's moment as a Date and answers with it.
    const requestedAt = (await getOnlyfansVaultListWalk(app.db, pageId))?.requestedAt ?? null;
    expect(requestedAt).not.toBeNull();
    await applyOnlyfansVaultListWalk(app.db, {
      pageId, seenAt: new Date(), lists: [], complete: true, requests: 1, failure: null, answeredRequestAt: requestedAt,
    });
    expect((await getOnlyfansVaultListWalk(app.db, pageId))?.requestedAt).toBeNull();
  });

  it("marks missing only after a complete walk, and clears it when the list is seen again", async (context) => {
    if (!testDb) return context.skip();
    // A platform's title may end with a space; a pack's title never does, and still names it.
    await walk(1, [album("101", "Autumn"), album("102", "Mirror ")], true);
    expect(await findPageVaultAlbumRefs(app.db, pageId, "Mirror")).toEqual(["102"]);

    // Cut short without "Mirror": nothing is missing.
    expect(await walk(2, [album("101", "Autumn")], false)).toMatchObject({ markedMissing: 0 });
    expect(await missing()).toEqual({ "101": false, "102": false });
    expect(await getOnlyfansVaultListWalk(app.db, pageId)).toMatchObject({ completedAt: at(1), failedAt: at(2), failure: "read_budget" });

    // Complete without "Mirror": missing, and no longer an album of the page.
    expect(await walk(3, [album("101", "Autumn")], true)).toMatchObject({ markedMissing: 1 });
    expect(await missing()).toEqual({ "101": false, "102": true });
    expect(await findPageVaultAlbumRefs(app.db, pageId, "Mirror")).toEqual([]);

    // Seen again, even by a walk cut short: not missing.
    await walk(4, [album("102", "Mirror")], false);
    expect(await missing()).toEqual({ "101": false, "102": false });
    expect(await findPageVaultAlbumRefs(app.db, pageId, "Mirror")).toEqual(["102"]);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
