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
//   - the golden-signals sampler prune (ops_metric_samples; 90 days)
//   - the page_dm_messages prune (cache policy, archive-coverage-gated)
//   - terminal typing command expiry after its short idempotency window
//   - expired pending device-token custody (10-minute activation window)
//   - pg-boss's own archival tables
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
const SANCTIONED_DELETER_FILES = [
  "apps/runtime/src/cli.ts",
  "apps/runtime/src/services/erasure/index.ts",
  "apps/runtime/src/modules/events/index.ts",
  "apps/runtime/src/services/auth.ts",
  "apps/runtime/src/services/domain-events-stream.ts",
  "apps/runtime/src/services/events-stream.ts",
  "apps/runtime/src/services/projections/fan-earnings.ts",
  "apps/runtime/src/services/projections/creator-posts.ts",
  "apps/runtime/src/services/sync/executor.ts",
  "apps/runtime/src/services/sync/observability.ts",
  "apps/runtime/src/services/sync/rate-limiter.ts",
  "packages/db/src/repositories/auth.ts",
  "packages/db/src/repositories/capture-payload-erasure.ts",
  "packages/db/src/repositories/catalog.ts",
  "packages/db/src/repositories/config-settings.ts",
  "packages/db/src/repositories/dm-analytics.ts",
  "packages/db/src/repositories/dm-message-archive.ts",
  "packages/db/src/repositories/fan-metadata.ts",
  "packages/db/src/repositories/message-archive.ts",
  // observations.ts left this list when the insert protocol became atomic:
  // its only delete was the compensating release of a failed key claim, and
  // a claim that never commits without its journal row needs no compensation.
  "packages/db/src/repositories/ofapi-commands.ts",
  "packages/db/src/repositories/ofapi-message-coverage.ts",
  "packages/db/src/repositories/ofapi.ts",
  "packages/db/src/repositories/ops-metrics.ts",
  "packages/db/src/repositories/page-dm.ts",
  "packages/db/src/repositories/runtime-instances.ts",
  "packages/db/src/repositories/spenders.ts",
  "packages/db/src/repositories/sync.ts",
  "packages/db/src/repositories/top-spenders.ts",
  "packages/db/src/repositories/transactions.ts",
  "packages/db/src/repositories/voice-profiles.ts",
  "packages/db/src/repositories/workboard-v2.ts",
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
    const found = [...new Set(
      output
        .split("\n")
        .filter((line) => line.trim() !== "" && !/server\.delete\(/.test(line))
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
  });
});
