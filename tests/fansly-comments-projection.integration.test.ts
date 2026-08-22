// WP-F5 end to end: journaled reply pages become the comment archive, and stay
// reproducible from the ledger alone.
//
// Four claims, and three of them are specific to this family:
//
//  - `missing_since` IS A REPLAYED FACT, written by the roster event
//    (`post.comment_list_observed`) and never by a sweep, so a
//    truncate-and-replay reproduces it exactly. The hardest case is the one
//    with no row events at all: a walk that comes back EMPTY.
//  - A TRUNCATED ROSTER MARKS NOTHING. A page that could not be proven complete
//    has an unknowable complement, and marking from it would delete an archive
//    one page at a time. The CLEAR half still runs.
//  - THE WALK QUEUE SURVIVES A REBUILD. `subject_refresh_state` rows for
//    `plane='post_replies'` are capture-plane operational state; a rebuild that
//    truncated them would re-run a first-pass crawl of the whole back-catalogue
//    for a repair that should cost zero platform calls.
//
// Plus the ordinary one: replay is a no-op, an edit is a revision, and nothing
// is ever deleted.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  ensureDomainEventPartitions,
  insertObservation,
  listSubjectRefreshState,
} from "@agency_hub_core/db";

import {
  resetCanonicalizeSweepCursors,
  runCanonicalization,
} from "../apps/runtime/src/services/canonicalize-driver.ts";
import {
  FANSLY_COMMENTS_PROJECTION,
  FANSLY_COMMENTS_PROJECTION_TABLES,
  measureFanslyComments,
  rebuildFanslyCommentsProjection,
  runFanslyCommentsProjection,
} from "../apps/runtime/src/services/projections/fansly-comments.ts";
import {
  findProjection,
  isOperationalStateTable,
} from "../apps/runtime/src/services/projections/registry.ts";
import { executeErasure, planErasure } from "../apps/runtime/src/services/erasure/index.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) {
    await resetIntegrationDatabase(testDb.pool);
  }
  resetCanonicalizeSweepCursors();
});

const FIXTURES = path.resolve("tests/fixtures/fansly-comments");
const COMMENT_KINDS = ["post_replies"];

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")) as Record<
    string,
    unknown
  >;
}

function sha256(value: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(value)).digest();
}

function appStub() {
  return {
    db: testDb!.db,
    pool: testDb!.pool,
    // No lake in these cases: listLakeManifests treats an unreadable directory
    // as "no manifests", which keeps DuckDB out of a projection test.
    config: { lakeDir: "/nonexistent-lake-dir" } as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

async function seedPage() {
  const model = await createModel(testDb!.db, { slug: "comments", name: "Comments" });
  if (!model) throw new Error("Expected the comments test model to be created");
  const page = await createFanslyPage(testDb!.db, { modelId: model.id, label: "comments-page" });
  if (!page) throw new Error("Expected the comments test page to be created");
  await testDb!.pool.query("update pages set external_page_id = $1 where id = $2", [
    "acct-comments",
    page.id,
  ]);
  await ensureDomainEventPartitions(testDb!.db);
  return page;
}

async function seedObservation(pageId: number, key: string, payload: unknown) {
  await insertObservation(testDb!.db, {
    source: "pull",
    producer: "sync:fansly:post_replies",
    platform: "fansly",
    accountId: pageId,
    kind: "post_replies",
    payload,
    payloadHash: sha256(key),
    idempotencyKey: `post_replies:${key}`,
  });
}

async function project(pageId: number) {
  await runCanonicalization(appStub(), { kinds: COMMENT_KINDS });
  return runFanslyCommentsProjection(appStub(), { accountId: pageId });
}

async function rows<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
  const result = await testDb!.pool.query(sql, params);
  return result.rows as T[];
}

/**
 * The projection's content, checksummed the way the §9.1 matrix does: CONTENT,
 * not row count, so a replay that loses a column still fails.
 *
 * `created_at` and `updated_at` are stripped, and only those two — they are
 * row-bookkeeping written by `now()`, so a rebuild moves them by construction.
 * `first_observed_at`, `last_observed_at`, `changed_at` and `missing_since` all
 * stay IN: every one of them is derived from the ledger, and a rebuild that
 * moved one is exactly the defect this test exists for.
 */
async function checksums(pageId: number): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of FANSLY_COMMENTS_PROJECTION_TABLES) {
    const result = await testDb!.pool.query(
      `select md5(string_agg(row_text, '|' order by row_text)) as digest,
              count(*)::int as rows
         from (
           select (to_jsonb(t) - 'created_at' - 'updated_at' - 'id')::text as row_text
             from ${table} t where page_id = $1
         ) stripped`,
      [pageId],
    );
    const record = result.rows[0] as { digest: string | null; rows: number };
    out[table] = `${record.rows}:${record.digest ?? "empty"}`;
  }
  return out;
}

/** A walk row, the way the handler and the creator-posts hook write them. */
async function seedWalkRow(pageId: number, subjectRef: string, visitedAt: string | null) {
  await testDb!.pool.query(
    `insert into subject_refresh_state (
       page_id, plane, subject_ref, refresh_class, next_due_at, last_visited_at, known_count
     ) values ($1, 'post_replies', $2, 'long_tail', now(), $3, 4)
     on conflict (page_id, plane, subject_ref) do nothing`,
    [pageId, subjectRef, visitedAt],
  );
}

describe("[sync-critical] WP-F5 comment projection", () => {
  it("projects every reply, and replaying appends nothing", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedObservation(page.id, "four", fixture("replies-four-with-accounts"));

    const first = await project(page.id);
    expect(first.comments).toBe(4);

    const stored = await rows(
      `select comment_ref, parent_post_ref, root_post_ref, author_ref, author_username,
              author_display_name, text_plain, like_count, media_like_count,
              tip_total_mills, attachment_tip_mills, attachment_count, discovered_via,
              possibly_truncated, missing_since, occurred_at
         from post_comments where page_id = $1 order by comment_ref`,
      [page.id],
    );
    expect(stored).toHaveLength(4);

    // BODIES. Including the empty one — a fan who replied with nothing still
    // replied, and dropping the row would make the reply count disagree with
    // the archive.
    expect(stored.map((row) => row.text_plain)).toEqual([
      "first one",
      "",
      "tipped this",
      "nested reply",
    ]);

    // THREADING. The nested reply's parent is a COMMENT, its root is the post,
    // and both are stored — the difference is what reconstructs the thread.
    const nested = stored.find((row) => row.comment_ref === "000910000000000104")!;
    expect(nested.parent_post_ref).toBe("000910000000000101");
    expect(nested.root_post_ref).toBe("000910000000000001");

    // TIPS: mills, two bases, never summed.
    const tipped = stored.find((row) => row.comment_ref === "000910000000000103")!;
    expect(String(tipped.tip_total_mills)).toBe("5000");
    expect(String(tipped.attachment_tip_mills)).toBe("1500");
    expect(tipped.attachment_count).toBe(1);
    expect(tipped.like_count).toBe(1);
    expect(tipped.media_like_count).toBe(2);

    // The display fields rode in on the populated `accounts[]` sidecar.
    expect(stored[0]!.author_username).toBe("fixture_fan");
    expect(stored[0]!.discovered_via).toBe("replies_walk");
    expect(stored[0]!.possibly_truncated).toBe(false);
    expect(stored[0]!.missing_since).toBeNull();
    // The comment's OWN date, not the look.
    expect(new Date(String(stored[0]!.occurred_at)).getUTCFullYear()).toBe(2026);

    const before = await checksums(page.id);
    const second = await project(page.id);
    expect(second.applied).toBe(0);
    expect(await checksums(page.id)).toEqual(before);
  });

  it("stores the author ref alone when `accounts[]` was EMPTY", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedObservation(page.id, "nosidecar", fixture("replies-accounts-empty"));
    await project(page.id);

    const [row] = await rows(
      `select author_ref, author_username, author_display_name
         from post_comments where page_id = $1`,
      [page.id],
    );
    // 2 of 5 live responses looked like this. The identity that reaches storage
    // is the REF; the hydration fallback exists so the identity is captured in
    // the journal, not so it fills these columns.
    expect(row!.author_ref).toBe("000910000000000205");
    expect(row!.author_username).toBeNull();
    expect(row!.author_display_name).toBeNull();
  });

  it("treats an EDIT as a revision: one new event, one head, `changed_at` moves", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const original = fixture("replies-four-with-accounts");
    await seedObservation(page.id, "v1", original);
    await project(page.id);

    const [firstHead] = await rows(
      `select content_hash, changed_at, first_observed_at, last_observed_at, text_plain
         from post_comments where page_id = $1 and comment_ref = '000910000000000101'`,
      [page.id],
    );

    const edited = JSON.parse(JSON.stringify(original)) as {
      response: { posts: { content: string }[] };
    };
    edited.response.posts[0]!.content = "first one, edited";
    await seedObservation(page.id, "v2", edited);
    await project(page.id);

    const [secondHead] = await rows(
      `select content_hash, changed_at, first_observed_at, last_observed_at, text_plain
         from post_comments where page_id = $1 and comment_ref = '000910000000000101'`,
      [page.id],
    );
    expect(secondHead!.text_plain).toBe("first one, edited");
    expect(secondHead!.content_hash).not.toBe(firstHead!.content_hash);
    // `first_observed_at` only ever moves BACKWARDS.
    expect(new Date(String(secondHead!.first_observed_at)).getTime())
      .toBe(new Date(String(firstHead!.first_observed_at)).getTime());
    // The head still exists exactly once — a revision is not a second row.
    const all = await rows(
      `select count(*)::int as n from post_comments where page_id = $1`,
      [page.id],
    );
    expect((all[0] as { n: number }).n).toBe(4);

    // TWO events for that comment in the ledger: the ledger keeps both versions
    // even though the head keeps one.
    const events = await rows(
      `select count(*)::int as n from domain_events
        where account_id = $1 and type = 'post.comment_observed'
          and data->>'commentRef' = '000910000000000101'`,
      [page.id],
    );
    expect((events[0] as { n: number }).n).toBe(2);
  });

  it("marks a vanished comment `missing_since` and NEVER deletes it", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedObservation(page.id, "four", fixture("replies-four-with-accounts"));
    await project(page.id);
    expect((await measureFanslyComments(testDb.db, page.id)).total).toBe(4);

    // The same post, walked again, with every comment gone. No row events at
    // all — which is exactly why the roster exists.
    await seedObservation(page.id, "empty", fixture("replies-empty"));
    const result = await project(page.id);
    // THREE, not four, and the fourth is the point. The nested reply hangs off
    // a COMMENT (`inReplyTo` = another comment's ref), not off the post, so a
    // walk of the POST does not enumerate it and its roster says nothing about
    // it. The reconcile is scoped to `parent_post_ref` precisely so a walk can
    // only ever mark what it was in a position to see; whether the route serves
    // nested replies inside a post's list has never been observed, and the
    // reconcile UNDER-marks rather than guessing.
    expect(result.markedMissing).toBe(3);

    const archive = await measureFanslyComments(testDb.db, page.id);
    // NOTHING DELETED (DP 7). The rows are still here; they are marked.
    expect(archive.total).toBe(4);
    expect(archive.missing).toBe(3);

    const stored = await rows(
      `select comment_ref, parent_post_ref, missing_since, text_plain
         from post_comments where page_id = $1`,
      [page.id],
    );
    for (const row of stored) {
      expect(
        row.missing_since === null,
        `${String(row.comment_ref)} under ${String(row.parent_post_ref)}`,
      ).toBe(row.parent_post_ref !== "000910000000000001");
    }
    // The bodies survive the mark. "Gone from the platform" is not "gone from
    // the archive".
    expect(stored.some((row) => row.text_plain === "tipped this")).toBe(true);
  });

  it("CLEARS the mark when the comments come back unchanged", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedObservation(page.id, "four", fixture("replies-four-with-accounts"));
    await project(page.id);
    await seedObservation(page.id, "empty", fixture("replies-empty"));
    await project(page.id);
    // Three: the nested reply hangs off a comment, so the post's walk never
    // marked it (see the test above).
    expect((await measureFanslyComments(testDb.db, page.id)).missing).toBe(3);

    // The comments return UNCHANGED, so their content hashes are the ones they
    // had before: the row events dedupe and never reach the projector. Only the
    // ROSTER can un-mark them, which is why the clear half exists.
    await seedObservation(page.id, "four-again", fixture("replies-four-with-accounts"));
    const result = await project(page.id);
    expect(result.clearedMissing).toBe(3);
    expect((await measureFanslyComments(testDb.db, page.id)).missing).toBe(0);
  });

  it("REFUSES to mark anything missing from a page it could not prove complete", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedObservation(page.id, "four", fixture("replies-four-with-accounts"));
    await project(page.id);

    // A cursor-fetched page naming ONE of the four. It is `possiblyTruncated`
    // by construction, so its complement is unknowable — marking from it would
    // delete three live comments on the strength of a page we cannot bound.
    await seedObservation(page.id, "paged", {
      walk: { postId: "000910000000000001", before: "000910000000000104" },
      response: {
        posts: [{
          id: "000910000000000101",
          accountId: "000910000000000201",
          content: "first one",
          inReplyTo: "000910000000000001",
          inReplyToRoot: "000910000000000001",
          createdAt: 1786709378,
          attachments: [],
          likeCount: 0,
          mediaLikeCount: 0,
          totalTipAmount: 0,
          attachmentTipAmount: 0,
        }],
        accounts: [],
      },
    });
    const result = await project(page.id);
    expect(result.markedMissing).toBe(0);
    expect((await measureFanslyComments(testDb.db, page.id)).missing).toBe(0);
  });

  it("reproduces every row — `missing_since` included — from the ledger alone", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedObservation(page.id, "four", fixture("replies-four-with-accounts"));
    await seedObservation(page.id, "other", fixture("replies-accounts-empty"));
    await seedObservation(page.id, "empty", fixture("replies-empty"));
    await project(page.id);

    const before = await checksums(page.id);
    expect(before["post_comments"]).not.toMatch(/^0:/u);

    await rebuildFanslyCommentsProjection(appStub(), { accountId: page.id });
    // CONTENT, not row count: a replay that loses `missing_since` or moves
    // `changed_at` fails here, which is the whole point of rebuilding from the
    // roster rather than from a sweep-time side effect.
    expect(await checksums(page.id)).toEqual(before);
  });

  it("leaves the WALK QUEUE untouched by a truncate-and-replay", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedWalkRow(page.id, "000910000000000001", "2026-08-01T00:00:00.000Z");
    await seedWalkRow(page.id, "000910000000000002", null);
    await seedObservation(page.id, "four", fixture("replies-four-with-accounts"));
    await project(page.id);

    const before = await listSubjectRefreshState(testDb.db, {
      pageId: page.id,
      plane: "post_replies",
    });
    expect(before).toHaveLength(2);

    await rebuildFanslyCommentsProjection(appStub(), { accountId: page.id });

    const after = await listSubjectRefreshState(testDb.db, {
      pageId: page.id,
      plane: "post_replies",
    });
    // Byte for byte. A rebuild that reset these rows would re-mark the whole
    // back-catalogue as never-walked and release a first-pass crawl of every
    // post on every page — an egress storm bought by a repair that should cost
    // zero platform calls.
    expect(after).toEqual(before);
    // And the classification, not a quiet executor exemption, is what says so.
    expect(isOperationalStateTable("subject_refresh_state")).toBe(true);
    expect(findProjection(FANSLY_COMMENTS_PROJECTION)?.tables)
      .not.toContain("subject_refresh_state");
  });

  it("declares itself in the registry with a real rebuild and a partition preflight", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const definition = findProjection(FANSLY_COMMENTS_PROJECTION);
    expect(definition?.stateClass).toBe("fact_projection");
    expect(definition?.rebuildKind).toBe("truncate_replay");
    expect(definition?.rebuild).toBeTypeOf("function");
    expect(definition?.eventTypes).toEqual([
      "post.comment_observed",
      "post.comment_list_observed",
    ]);
    expect(definition?.tables).toEqual(["post_comments"]);
  });

  it("erases one fan's comments — and only that fan's", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedObservation(page.id, "four", fixture("replies-four-with-accounts"));
    await project(page.id);
    expect((await measureFanslyComments(testDb.db, page.id)).total).toBe(4);

    // THE DRILL. `post_comments.author_ref` is a TEXT platform ref with no FK to
    // `fans`, so the unmapped-non-cascade-FK guard is structurally blind to it —
    // an explicit predicate is the only thing that reaches these rows, and this
    // is the fan-ref column whose under-erasure is most visible, because the row
    // holds words the fan wrote.
    const scope = {
      scopeType: "fan",
      platform: "fansly",
      fanRef: "000910000000000201",
    } as const;
    const plan = await planErasure(appStub(), scope);
    const target = plan.targets.find((entry) => entry.target === "post_comments");
    expect(target?.action).toBe("delete");
    expect(target?.rows).toBe(1);

    const ownerRow = await rows<{ id: string }>(
      `insert into users (username, role) values ($1, 'owner') returning id::text as id`,
      ["comments-erasure-owner"],
    );
    await executeErasure(appStub(), scope, { initiatedBy: Number(ownerRow[0]!.id) });

    const remaining = await rows(
      `select author_ref, text_plain from post_comments where page_id = $1 order by comment_ref`,
      [page.id],
    );
    // The fan's own comment is gone; the other three fans' comments — and the
    // creator's own reply — are untouched.
    expect(remaining).toHaveLength(3);
    expect(remaining.every((row) => row.author_ref !== "000910000000000201")).toBe(true);
    expect(remaining.some((row) => row.text_plain === "tipped this")).toBe(true);
  });
});
