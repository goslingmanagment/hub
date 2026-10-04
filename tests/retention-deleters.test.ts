import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Kernel Stage 28: deletion is a governed act. This is the inverse of the
// Stage 1 audit — it enumerates every file that issues a SQL delete and pins
// the list. A new deleter anywhere fails here first and must justify itself
// (projection rebuild / session hygiene / sanctioned retention sweep) before
// joining the allowlist. The SCHEDULED deleters — the only ones that touch
// captured data on a timer — are exactly:
//   - deleteExpiredSyncObservability (sync_http_attempts, sync_run_events,
//     and since Stage 28 sync_runs; 30 days)
//   - deleteExpiredSyncEngineTelemetry (Fansly Sync Engine, 0228: closed
//     sync_work rows and terminal non-evidence sync_attempts rows; the same
//     30 days, the same nightly job)
//   - the golden-signals sampler prune (ops_metric_samples; 90 days)
//   - the page_dm_messages prune (cache policy, archive-coverage-gated)
//   - terminal typing command expiry after its short idempotency window
//   - expired pending device-token custody (10-minute activation window)
//   - expired Fansly Sync Engine media handoff rows (0234: transient chat-media
//     bytes for the AI describer nobody consumed within 24 h; not a captured
//     fact — owner decision №17)
//   - pg-boss's own archival tables
// Raw payloads (sync_raw_payloads) are explicitly NOT on that list: they are
// captured facts, and the nightly `fansly.raw-payload-cleanup` job keeps only
// its name. The last test in this file pins that the erasure is their only
// deleter.
// The Stage 28 erasure module is the one sanctioned NON-scheduled deleter:
// owner-initiated, dry-run default, tombstoned in erasure_log.
// Projection reset helpers are also sanctioned: they only clear rebuildable
// state and are never scheduled retention work.
//
// G5 slice 3b adds ONE new sanctioned deleter, and it is the first one ever
// allowed to destroy a captured BODY:
//   - packages/db/src/repositories/capture-payload-erasure.ts —
//     deleteUnreferencedCapturePayloadObjects. Lawful for one reason and only
//     that reason: it deletes a content-addressed capture body ONLY when NO
//     envelope references it any more, which the same statement PROVES with a
//     `not exists` against both observations and sync_raw_payloads inside the
//     erasure's own transaction. A body whose every envelope this erasure just
//     deleted is a copy of a fact that no longer exists (0123 wrote the rule
//     down before there was code for it: "a body may die only when the last
//     surviving envelope reference is gone"); a body a SURVIVING envelope
//     still needs is a bystander's fact and is kept, counted and reported,
//     never deleted and never rewritten. It is NOT scheduled, has no timer and
//     no retention window: the only caller is
//     apps/runtime/src/services/erasure/capture-catalog.ts, inside an
//     owner-initiated run that is tombstoned in erasure_log — the same
//     governance the rest of the module has. It sits in its own file so the
//     capture WRITE path (capture-payloads.ts) never has to appear on this
//     list.
//
// G5 slice 3c-2 adds the SECOND sanctioned destroyer of captured bytes, and it
// does not appear in the file list below because it does not issue a SQL
// `delete` at all — it issues a `DROP TABLE`. That is not a loophole, it is a
// different act needing a different licence, and the second test in this file
// pins it statement by statement:
//   - apps/runtime/src/services/capture-rewrite/reclaim.ts —
//     runCaptureDropParked. The relation it destroys can only ever be one that
//     lives in the `capture_pending_drop` schema: the schema half of the
//     statement is a module constant that no caller can influence, and the
//     relation half is resolved out of that schema's own catalog listing before
//     the drop, so a name that is not parked there cannot be reached by any
//     spelling. What is in that schema is, by construction, a partition a
//     transactional swap SUPERSEDED — every one of its rows is also in the
//     skinny twin attached under the partition's old name. So the fact is not
//     being deleted; a duplicate of its physical residue is. It is not
//     scheduled, has no timer, demands `--confirm` equal to the exact relation
//     name, enforces a grace window, and tombstones itself in
//     `capture_rewrite_runs` — the erasure's governance, for the same class of
//     act.
const SANCTIONED_DELETER_FILES = [
  // Sync Engine host (design §3.6): Map/Set.delete forget in-memory page slots,
  // held advisory locks, wake waiters, cached resource modules and the owner's
  // paused-key set before it is written whole; the stall watchdog's Set.delete
  // stops watching a finished step (step 4, 4-3). No SQL deletion.
  "apps/runtime/src/sync/engine/host-ports.ts",
  "apps/runtime/src/sync/engine/host.ts",
  "apps/runtime/src/sync/engine/resource.ts",
  "apps/runtime/src/sync/engine/watchdog.ts",
  "apps/runtime/src/sync/inspect.ts",
  // Plan §2.5 send guard: Map/Set.delete forget this process's lease handles
  // once their completion is written. No SQL deletion.
  "apps/runtime/src/services/fansly-send-guard/engine.ts",
  // Decision270: owner reset of encrypted-response-derived configuration, no source deletion.
  "apps/runtime/src/services/projections/ofapi-marketing.ts",
  // Decision266: owner-invoked reset of replayable OFAPI snapshot projection only.
  "apps/runtime/src/services/projections/ofapi-read-snapshots.ts",
  // S11a owner rebuild deletes only reconstructible vendor queue heads.
  "apps/runtime/src/services/projections/ofapi-content-events.ts",
  // S8: rebuilds derived rows from domain events; never deletes captured artifacts or jobs.
  "apps/runtime/src/services/projections/ofapi-typed-exports.ts",
  "apps/runtime/src/services/projections/ofapi-media.ts", // Explicit derived metadata rebuild; source authority remains.
  "apps/runtime/src/cli.ts",
  "apps/runtime/src/services/erasure/index.ts",
  "apps/runtime/src/modules/events/index.ts",
  "apps/runtime/src/services/auth.ts",
  "apps/runtime/src/services/domain-events-stream.ts",
  "apps/runtime/src/services/events-stream.ts",
  "apps/runtime/src/services/projections/fan-earnings.ts",
  "apps/runtime/src/services/projections/creator-posts.ts",
  // WP-F0(b): projection reset — rebuildable state only, never scheduled.
  // rebuildMediaPlaneProjection clears the four 0130 tables plus its own
  // watermark inside ONE transaction and immediately replays them from the
  // domain-event ledger. It deletes no captured fact: every row it removes is
  // reproduced from events the sweep never deletes.
  "apps/runtime/src/services/projections/media-plane.ts",
  // WP-F1: projection reset — rebuildable state only, never scheduled.
  // rebuildFanslyStatsProjection clears the eleven 0132 statistics tables plus
  // its own watermark inside ONE transaction and immediately replays them from
  // the domain-event ledger. It deletes no captured fact, and `capture_coverage`
  // is deliberately NOT in its table list: that is capture-plane operational
  // state (§3.4, A17-6) holding retention floors no event carries, so a rebuild
  // that truncated it would erase evidence the backfill paid egress to find.
  "apps/runtime/src/services/projections/fansly-stats.ts",
  // WP-F2: projection reset — rebuildable state only, never scheduled.
  // rebuildFanslyEngagementProjection clears `platform_notifications` and
  // `post_likes` plus its own watermark inside ONE transaction and immediately
  // replays them from the domain-event ledger. `subject_refresh_state` is
  // deliberately NOT in its table list: that is capture-plane operational state
  // (§3.4) holding due dates and walk cursors no event carries, so a rebuild
  // that truncated it would re-mark the whole catalogue as first-sight and
  // release an egress storm.
  "apps/runtime/src/services/projections/fansly-engagement.ts",
  // WP-F3: projection reset — rebuildable state only, never scheduled.
  // rebuildFanslyCatalogProjection clears the six catalog tables plus the
  // GIFT-CODE half of `page_promo_links` (scoped by `link_kind`, because the
  // tracking half belongs to the statistics projector's ledger) and its own
  // watermark, inside ONE transaction, then replays them from the
  // domain-event ledger. The stream CHECKPOINT is deliberately untouched: the
  // vault walk's per-album cursors live there, they are capture-plane
  // operational state (§3.4), and resetting them would re-run a first-enable
  // exhaustion crawl of every album on every page.
  "apps/runtime/src/services/projections/fansly-catalog.ts",
  // WP-F5: projection reset — rebuildable state only, never scheduled.
  // rebuildFanslyCommentsProjection clears `post_comments` and its own
  // watermark inside ONE transaction, then replays them from the domain-event
  // ledger. `subject_refresh_state` is deliberately untouched: the reply walk's
  // queue is capture-plane operational state (§3.4), and resetting it would
  // re-run a first-pass crawl of the entire post back-catalogue for a repair
  // that should cost zero platform calls.
  "apps/runtime/src/services/projections/fansly-comments.ts",
  // WP-F7: projection reset — rebuildable state only, never scheduled.
  // rebuildFanslyPayoutsProjection clears `page_payout_methods` and
  // `page_payout_requests` and its own watermark inside ONE transaction, then
  // replays them from the domain-event ledger. The stream CHECKPOINT is
  // deliberately untouched: the request walk's offset cursor and its floor are
  // capture-plane operational state (§3.4), and resetting them would re-walk
  // the whole payout history for a repair that should cost zero platform calls.
  "apps/runtime/src/services/projections/fansly-payouts.ts",
  "apps/runtime/src/services/sync/executor.ts",
  "apps/runtime/src/services/sync/observability.ts",
  "packages/db/src/repositories/auth.ts",
  "packages/db/src/repositories/capture-payload-erasure.ts",
  "packages/db/src/repositories/catalog.ts",
  "packages/db/src/repositories/config-settings.ts",
  "packages/db/src/repositories/dm-analytics.ts",
  "packages/db/src/repositories/dm-message-archive.ts",
  "packages/db/src/repositories/fan-metadata.ts",
  // M11: an owner-run queue repair, never scheduled, dry-run by default (a
  // READ ONLY transaction). deleteForeignMediaStatsQueueRows removes only
  // never-visited `media_stats` rows of `subject_refresh_state` — capture-plane
  // operational state (§3.4), no captured fact — for media another account
  // owns, which the route can only ever fail. Every observation, event and
  // `creator_media` head stays, and the enqueue's owner check keeps the rows
  // from coming back.
  "packages/db/src/repositories/fansly-media-stats-foreign-queue.ts",
  // Owner decision 2026-09-29: an owner-run queue repair, never scheduled,
  // dry-run by default (a READ ONLY transaction). deleteDmOnlyMediaStatsQueueRows
  // removes only `media_stats` rows of `subject_refresh_state` — capture-plane
  // operational state (§3.4), no captured fact — for media the page showed only
  // in DMs, whose per-media views the owner does not want. Every observation,
  // event, `creator_media` head and collected bucket stays, and the enqueue's
  // origin check keeps the rows from coming back.
  "packages/db/src/repositories/fansly-media-stats-dm-only-queue.ts",
  "packages/db/src/repositories/message-archive.ts",
  // observations.ts left this list when the insert protocol became atomic:
  // its only delete was the compensating release of a failed key claim, and
  // a claim that never commits without its journal row needs no compensation.
  "packages/db/src/repositories/ofapi-commands.ts",
  // Desktop media images: `ofapi_media_flights` holds single-flight markers
  // (one per file while one resolve talks to OFAPI, or until a paid
  // hand-out's report). They are coordination rows, never captured data: a
  // report releases its marker and the daily OFAPI events cleanup purges
  // markers expired for an hour. Locators and the decision log are never
  // deleted by schedule (expired locator URLs are only nulled).
  "packages/db/src/repositories/ofapi-media-images.ts",
  "packages/db/src/repositories/ofapi-message-coverage.ts",
  "packages/db/src/repositories/ofapi.ts",
  "packages/db/src/repositories/ops-metrics.ts",
  "packages/db/src/repositories/page-dm.ts",
  "packages/db/src/repositories/runtime-instances.ts",
  "packages/db/src/repositories/spenders.ts",
  "packages/db/src/repositories/sync.ts",
  // Fansly Sync Engine hold set (0240, owner decision №26): a page's holds
  // are rows of `sync_holds`, and lifting a hold deletes its row — in the
  // actor's own transaction (an identity proof, an answer after a hold ended,
  // a breaker's file answering again); for the one release the old hold
  // columns exist, an ownership acquisition replaces a page's rows by what
  // those columns say when the two differ (holds-legacy.ts). Engine state,
  // never a captured fact, and never scheduled: no timer, no retention window.
  "packages/db/src/repositories/sync/holds-legacy.ts",
  // Fansly Sync Engine media handoff (0234, owner decision №17): the
  // transient buffer that carries a chat file's bytes from the `sync` process
  // to the AI describer. The describer's read deletes the row it consumed; a
  // row nobody consumed is deleted after its 24 h (the nightly retention job,
  // and every new download of the page). A transient handoff buffer, not a
  // captured fact: the description and the media metadata observation are.
  "packages/db/src/repositories/sync/media-handoff.ts",
  // The hold writers (see holds-legacy.ts above): `clearPageHold`,
  // `setResourceHold`, `writeSyncRouteState`.
  "packages/db/src/repositories/sync/pages.ts",
  // Fansly Sync Engine telemetry (0228), scheduled with the sync
  // observability sweep: closed work rows and terminal attempts that are not
  // coverage evidence, 30 days. No captured fact: raw responses live in
  // observations, which it never touches.
  "packages/db/src/repositories/sync/retention.ts",
  "packages/db/src/repositories/top-spenders.ts",
  "packages/db/src/repositories/transactions.ts",
  "packages/db/src/repositories/voice-profiles.ts",
];

describe("retention deleter enumeration (Stage 28)", () => {
  it("no file outside the pinned allowlist issues a SQL delete", () => {
    const root = join(__dirname, "..");
    let output: string;
    try {
      output = execFileSync(
        "grep",
        [
          "-rE",
          "\\.delete\\(|delete from",
          "--include=*.ts",
          "packages/db/src/repositories",
          "apps/runtime/src",
        ],
        { cwd: root, encoding: "utf8" },
      );
    } catch {
      output = "";
    }
    // `server.delete(` is an HTTP verb registration (the Stage 31 persona
    // archive route), not a SQL delete — those lines don't make a deleter.
    // Custody quarantine also removes an entry from an in-memory Map only.
    const found = [...new Set(
      output
        .split("\n")
        .filter((line) => line.trim() !== "" && !/server\.delete\(/.test(line)
          && !/^apps\/runtime\/src\/services\/canonicalize-driver\.ts:\s*accountIdByNativeRef\.delete\(key\);$/.test(line))
        .map((line) => line.slice(0, line.indexOf(":"))),
    )].sort();
    expect(found).toEqual([...SANCTIONED_DELETER_FILES].sort());
  });

  // The file-level allowlist above says WHO may delete. For the one deleter
  // that destroys a captured body, that is not enough — WHAT it deletes and
  // WHAT it must prove first are the whole licence, so both are pinned here.
  it("the capture-body deleter touches only the catalog trio, and only with zero references proved", () => {
    const source = readFileSync(
      join(__dirname, "..", "packages/db/src/repositories/capture-payload-erasure.ts"),
      "utf8",
    );

    const deleted = [...source.matchAll(/delete from (\w+)/g)].map((match) => match[1]).sort();
    expect(deleted).toEqual([
      "capture_byte_hot_bodies",
      "capture_json_hot_bodies",
      "capture_payload_locations",
      "capture_payload_objects",
    ]);

    // The proof, verbatim: an object is deletable only when NEITHER envelope
    // table references it. Dropping either arm would silently turn this into a
    // deleter of live bodies.
    expect(source).toContain("exists (select 1 from observations e");
    expect(source).toContain("exists (select 1 from sync_raw_payloads e");
    expect(source).toContain("e.payload_bucket_month = c.bucket_month");
    expect(source).toContain("e.payload_object_id = c.object_id");
    // Nothing here may rewrite a body: a shared body belongs to a bystander.
    expect(source).not.toMatch(/\bupdate\s+capture_/i);
    expect(source).not.toMatch(/\binsert\s+into\s+capture_/i);

    // DECISION #222 EXTENDS THIS LICENCE, deliberately, because the fix added a
    // statement to this file. The `not exists` above proves zero references AT
    // AN INSTANT; on its own that is a stale proof, because a capture that has
    // already committed its CAS transaction can stamp a reference onto an
    // envelope a millisecond later. What makes the proof binding is that the
    // candidate rows are LOCKED FOR UPDATE in a statement of their own BEFORE
    // the verdict is computed — an envelope writer holds `FOR KEY SHARE` on the
    // same row until its insert commits, so the two acts are ordered and the
    // verdict statement's fresh snapshot cannot miss a reference that beat it.
    //
    // Delete the lock statement, or fold it into the verdict query, and this
    // file goes back to being able to destroy the only copy of a captured body
    // while an envelope is being written to point at it. That is why it is
    // pinned here, in the file that says what this deleter must prove.
    expect(source).toContain("for update");
    const lockAt = source.indexOf("for update");
    const verdictAt = source.indexOf("with candidate (bucket_month, object_id) as (values");
    const firstDeleteAt = source.indexOf("delete from capture_json_hot_bodies");
    expect(lockAt).toBeGreaterThan(-1);
    expect(verdictAt).toBeGreaterThan(lockAt);
    expect(firstDeleteAt).toBeGreaterThan(verdictAt);
  });

  // G5 slice 3c-2. `DROP TABLE` is invisible to the grep above, which is
  // exactly why it needs its own pin: a command that destroys a whole relation
  // of captured rows must be provably unable to point at a live one.
  it("the parked-partition dropper can reach nothing outside the parking schema", () => {
    const path = join(__dirname, "..", "apps/runtime/src/services/capture-rewrite/reclaim.ts");
    const source = readFileSync(path, "utf8");

    // Exactly one DROP TABLE in the file, and its schema is the constant.
    const drops = [...source.matchAll(/drop\s+table[^`\n]*/gi)].map((match) => match[0]);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toContain("${CAPTURE_PARKING_SCHEMA}");
    // The relation name is quoted (so it is one identifier, never a schema
    // qualification smuggled through a name) and the schema is NOT
    // interpolated from anything a caller supplies.
    expect(drops[0]).toMatch(/\$\{CAPTURE_PARKING_SCHEMA\}\."\$\{options\.relation\}"/);
    expect(drops[0]).not.toContain("public");

    // The name it drops was resolved out of that schema's own listing first —
    // remove this and a caller could name any relation in the database.
    expect(source).toContain("const parked = await listCaptureParkedRelations(app);");
    expect(source).toContain("parked.find((row) => row.relation === options.relation)");
    expect(source).toContain("is not a relation in ${CAPTURE_PARKING_SCHEMA}");
    // …and the exact-name confirm, the erasure's ritual.
    expect(source).toContain("if (options.confirm !== options.relation) {");

    // The parking schema itself may only ever be filled by the swap, so its
    // contents are always superseded copies. Nothing else writes to it.
    const setSchema = [...source.matchAll(/set\s+schema\s+\$\{CAPTURE_PARKING_SCHEMA\}/gi)];
    expect(setSchema).toHaveLength(1);

    // And this file must not acquire a SQL delete on the quiet: the file-level
    // allowlist above does not name it, so any `delete from` here fails that
    // test — this assertion states the intent where the reader will meet it.
    expect(source).not.toMatch(/delete\s+from/i);

    // The schema name is a module constant, not a parameter.
    const scope = readFileSync(
      join(__dirname, "..", "apps/runtime/src/services/capture-rewrite/scope.ts"),
      "utf8",
    );
    expect(scope).toContain('export const CAPTURE_PARKING_SCHEMA = "capture_pending_drop";');
  });

  // The other half of the same law: the erasure must still be able to reach a
  // parked copy while it sits in its grace window, or a swap would open a
  // window of silent under-erasure.
  it("the erasure sweeps the new parking schema as well as Stage 28's", () => {
    const source = readFileSync(
      join(__dirname, "..", "apps/runtime/src/services/erasure/index.ts"),
      "utf8",
    );
    expect(source).toContain(
      "where n.nspname in ('tiered_pending_drop', 'capture_pending_drop') and c.relkind = 'r'",
    );
  });

  // sync.ts is on the file allowlist for the observability prune, so the file
  // test above cannot see a raw-payload purge added next to it. The nightly
  // job used to run `delete from sync_raw_payloads where retain_until < now`,
  // harmless only because every writer stamps retain_until 100 years out; one
  // writer with a normal date would have silently destroyed captured facts.
  it("nothing but the owner-initiated erasure deletes raw payloads", () => {
    const root = join(__dirname, "..");
    let output: string;
    try {
      output = execFileSync(
        "grep",
        [
          "-rliE",
          "syncRawPayloads|sync_raw_payloads",
          "--include=*.ts",
          "--include=*.mts",
          "--include=*.js",
          "--include=*.mjs",
          "--exclude-dir=node_modules",
          "--exclude-dir=dist",
          "apps",
          "packages",
          "scripts",
        ],
        { cwd: root, encoding: "utf8" },
      );
    } catch {
      output = "";
    }
    const rawDeleter = /\.delete\(\s*syncRawPayloads\b|delete\s+from\s+(?:\$\{\s*syncRawPayloads\b|"?sync_raw_payloads\b)/i;
    const deleters = output
      .split("\n")
      .filter((file) => file.trim() !== "")
      .filter((file) => rawDeleter.test(readFileSync(join(root, file), "utf8")))
      .sort();
    expect(deleters).toEqual(["apps/runtime/src/services/erasure/index.ts"]);
  });
});
