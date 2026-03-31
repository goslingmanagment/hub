import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  FANSLY_PAGE_ALIAS_SOURCE,
  createFanslyPage,
  createModel,
  reconcileFanslyFanPageIdentity,
  searchFansInScope,
  upsertFanPage,
  upsertFans,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

async function createIdentityPage(testDb: StartedTestDatabase, label: string) {
  const model = await createModel(testDb.db, {
    slug: `${label}-model`,
    name: `${label} model`,
  });

  return createFanslyPage(testDb.db, {
    modelId: model.id,
    label,
  });
}

describe("fan page identity repository integration", () => {
  let testDb: StartedTestDatabase | null = null;

  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  });

  afterAll(async () => {
    if (testDb) {
      await testDb.stop();
    }
  });

  beforeEach(async () => {
    if (!testDb) {
      return;
    }

    await resetIntegrationDatabase(testDb.pool);
  });

  it("persists external notes, picks the freshest alias, and stores alias history", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await createIdentityPage(testDb, "identity-freshest-alias");
    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-alias-primary",
      username: "fan_alias_primary",
      displayName: "Fan Alias Primary",
    }]);

    await upsertFanPage(testDb.db, {
      fanId: fan.id,
      platformAccountId: page.id,
    });

    const seenAt = new Date("2026-03-31T10:00:00.000Z");
    const result = await reconcileFanslyFanPageIdentity(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      seenAt,
      notes: [
        {
          externalNoteId: "alias-old",
          title: "Custom Username",
          body: "Legacy Mike",
          updatedAtExternal: new Date("2026-03-20T09:00:00.000Z"),
          raw: { id: "alias-old" },
        },
        {
          externalNoteId: "alias-new",
          contentType: 12002,
          body: " VIP Mike ",
          updatedAtExternal: new Date("2026-03-30T12:00:00.000Z"),
          raw: { id: "alias-new" },
        },
        {
          externalNoteId: "note-other",
          title: "Other",
          body: "ignored",
          updatedAtExternal: new Date("2026-03-29T12:00:00.000Z"),
          raw: { id: "note-other" },
        },
      ],
    });

    const membershipResult = await testDb.pool.query<{
      page_alias: string | null;
      page_alias_source: string | null;
      page_alias_source_note_id: string | null;
      page_alias_synced_at: Date | null;
    }>(
      `select page_alias, page_alias_source, page_alias_source_note_id, page_alias_synced_at
       from page_fans
       where platform_account_id = $1 and fan_id = $2`,
      [page.id, fan.id],
    );
    const notesResult = await testDb.pool.query<{
      external_note_id: string;
      is_active: boolean;
      body: string | null;
    }>(
      `select external_note_id, is_active, body
       from page_fan_external_notes
       where platform_account_id = $1 and fan_id = $2
       order by external_note_id asc`,
      [page.id, fan.id],
    );
    const aliasesResult = await testDb.pool.query<{
      alias: string;
      source_note_id: string | null;
    }>(
      `select alias, source_note_id
       from page_fan_aliases
       where platform_account_id = $1 and fan_id = $2
       order by alias asc`,
      [page.id, fan.id],
    );
    const membership = membershipResult.rows[0];
    const notes = notesResult.rows.map((row) => ({
      externalNoteId: row.external_note_id,
      isActive: row.is_active,
      body: row.body,
    }));
    const aliases = aliasesResult.rows.map((row) => ({
      alias: row.alias,
      sourceNoteId: row.source_note_id,
    }));

    expect(result).toMatchObject({
      noteCount: 3,
      upsertedNoteCount: 3,
      deactivatedNoteCount: 0,
      currentAlias: "VIP Mike",
      aliasSet: true,
      aliasCleared: false,
      aliasHistoryCount: 2,
    });
    expect(membership).toMatchObject({
      page_alias: "VIP Mike",
      page_alias_source: FANSLY_PAGE_ALIAS_SOURCE,
      page_alias_source_note_id: "alias-new",
      page_alias_synced_at: seenAt,
    });
    expect(notes).toEqual([
      { externalNoteId: "alias-new", isActive: true, body: " VIP Mike " },
      { externalNoteId: "alias-old", isActive: true, body: "Legacy Mike" },
      { externalNoteId: "note-other", isActive: true, body: "ignored" },
    ]);
    expect(aliases).toEqual([
      { alias: "Legacy Mike", sourceNoteId: "alias-old" },
      { alias: "VIP Mike", sourceNoteId: "alias-new" },
    ]);
  });

  it("treats a blank freshest alias as no alias and keeps prior alias history", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await createIdentityPage(testDb, "identity-blank-alias");
    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-alias-blank",
      username: "fan_alias_blank",
      displayName: "Fan Alias Blank",
    }]);

    await upsertFanPage(testDb.db, {
      fanId: fan.id,
      platformAccountId: page.id,
    });

    await reconcileFanslyFanPageIdentity(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      seenAt: new Date("2026-03-29T10:00:00.000Z"),
      notes: [{
        externalNoteId: "alias-live",
        title: "Custom Username",
        body: "Known Alias",
        updatedAtExternal: new Date("2026-03-29T09:00:00.000Z"),
      }],
    });

    const blankSeenAt = new Date("2026-03-31T10:00:00.000Z");
    const result = await reconcileFanslyFanPageIdentity(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      seenAt: blankSeenAt,
      notes: [{
        externalNoteId: "alias-blank",
        title: "Custom Username",
        body: "   ",
        updatedAtExternal: new Date("2026-03-31T09:00:00.000Z"),
      }],
    });

    const membershipResult = await testDb.pool.query<{
      page_alias: string | null;
      page_alias_source: string | null;
      page_alias_source_note_id: string | null;
      page_alias_synced_at: Date | null;
    }>(
      `select page_alias, page_alias_source, page_alias_source_note_id, page_alias_synced_at
       from page_fans
       where platform_account_id = $1 and fan_id = $2`,
      [page.id, fan.id],
    );
    const notesResult = await testDb.pool.query<{
      external_note_id: string;
      is_active: boolean;
    }>(
      `select external_note_id, is_active
       from page_fan_external_notes
       where platform_account_id = $1 and fan_id = $2
       order by external_note_id asc`,
      [page.id, fan.id],
    );
    const aliasesResult = await testDb.pool.query<{ alias: string }>(
      `select alias
       from page_fan_aliases
       where platform_account_id = $1 and fan_id = $2`,
      [page.id, fan.id],
    );
    const membership = membershipResult.rows[0];
    const notes = notesResult.rows.map((row) => ({
      externalNoteId: row.external_note_id,
      isActive: row.is_active,
    }));
    const aliases = aliasesResult.rows.map((row) => ({ alias: row.alias }));

    expect(result).toMatchObject({
      noteCount: 1,
      upsertedNoteCount: 1,
      deactivatedNoteCount: 1,
      currentAlias: null,
      aliasSet: false,
      aliasCleared: true,
      aliasHistoryCount: 0,
    });
    expect(membership).toMatchObject({
      page_alias: null,
      page_alias_source: null,
      page_alias_source_note_id: null,
      page_alias_synced_at: blankSeenAt,
    });
    expect(notes).toEqual([
      { externalNoteId: "alias-blank", isActive: true },
      { externalNoteId: "alias-live", isActive: false },
    ]);
    expect(aliases).toEqual([{ alias: "Known Alias" }]);
  });

  it("matches and ranks current alias, alias history, username, and display name in page-scoped search", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await createIdentityPage(testDb, "identity-search-aliases");
    const [currentAliasFan, historyAliasFan, usernameFan, displayNameFan] = await upsertFans(testDb.db, [
      {
        platform: "fansly",
        platformUserId: "fan-current-alias",
        username: "alpha_handle",
        displayName: "Alpha Display",
      },
      {
        platform: "fansly",
        platformUserId: "fan-history-alias",
        username: "beta_handle",
        displayName: "Beta Display",
      },
      {
        platform: "fansly",
        platformUserId: "fan-username",
        username: "rose_handle",
        displayName: "Gamma Display",
      },
      {
        platform: "fansly",
        platformUserId: "fan-display",
        username: "display_handle",
        displayName: "Rose Display",
      },
    ]);

    for (const fan of [currentAliasFan, historyAliasFan, usernameFan, displayNameFan]) {
      await upsertFanPage(testDb.db, {
        fanId: fan.id,
        platformAccountId: page.id,
      });
    }

    await reconcileFanslyFanPageIdentity(testDb.db, {
      platformAccountId: page.id,
      fanId: currentAliasFan.id,
      seenAt: new Date("2026-03-29T10:00:00.000Z"),
      notes: [{
        externalNoteId: "alias-current",
        title: "Custom Username",
        body: "Rose Current",
        updatedAtExternal: new Date("2026-03-29T09:00:00.000Z"),
      }],
    });
    await reconcileFanslyFanPageIdentity(testDb.db, {
      platformAccountId: page.id,
      fanId: historyAliasFan.id,
      seenAt: new Date("2026-03-29T10:00:00.000Z"),
      notes: [{
        externalNoteId: "alias-history",
        title: "Custom Username",
        body: "Rose History",
        updatedAtExternal: new Date("2026-03-29T09:00:00.000Z"),
      }],
    });
    await reconcileFanslyFanPageIdentity(testDb.db, {
      platformAccountId: page.id,
      fanId: historyAliasFan.id,
      seenAt: new Date("2026-03-31T10:00:00.000Z"),
      notes: [],
    });

    const result = await searchFansInScope(testDb.db, {
      platform: "fansly",
      pageIds: [page.id],
      query: "rose",
      limit: 10,
      offset: 0,
    });

    expect(result.total).toBe(4);
    expect(result.items.map((item) => ({
      platformUserId: item.platformUserId,
      pageAlias: item.pageAlias,
      matchKind: item.matchKind,
      matchedValue: item.matchedValue,
    }))).toEqual([
      {
        platformUserId: "fan-current-alias",
        pageAlias: "Rose Current",
        matchKind: "alias",
        matchedValue: "Rose Current",
      },
      {
        platformUserId: "fan-history-alias",
        pageAlias: null,
        matchKind: "alias",
        matchedValue: "Rose History",
      },
      {
        platformUserId: "fan-username",
        pageAlias: null,
        matchKind: "username",
        matchedValue: "rose_handle",
      },
      {
        platformUserId: "fan-display",
        pageAlias: null,
        matchKind: "displayName",
        matchedValue: "Rose Display",
      },
    ]);
  });
});
