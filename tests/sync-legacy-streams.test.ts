import { describe, expect, it } from "vitest";

import {
  AGENT_DATASET_SQL,
  FANSLY_ENGINE_LEGACY_STREAMS,
  FANSLY_ENGINE_SUBJECT_LEVEL_KEYS,
  fanslyEngineStreamKeysValuesSql,
  syncWorkQuarantineOf,
} from "@agency_hub_core/db";

import {
  ApplyQuarantine,
  applyErrorDetail,
  FanslyContractViolationError,
} from "../apps/runtime/src/sync/engine/commit.ts";
import {
  fanslyFilesForStreams,
  fanslyKeysForStreams,
  fanslyLegacyStreamsOfKey,
  fanslyLegacyStreamTable,
  fanslyStreamPollSeconds,
} from "../apps/runtime/src/sync/fansly/legacy-streams.ts";
import { FANSLY_RESOURCE_SPECS } from "../apps/runtime/src/sync/fansly/registry.ts";
import { ownerEnqueueKeys } from "../apps/runtime/src/sync/inspect.ts";

// The legacy stream ↔ registry key table of design step 3 §3.2 (S3-02): one
// source of truth (the registry's `legacy` refs), one SQL-side copy (the
// database package cannot import the runtime's registry), pinned equal here.

describe("legacy stream ↔ registry key", () => {
  it("the database copy is exactly the table the registry generates", () => {
    expect(FANSLY_ENGINE_LEGACY_STREAMS.map(([key, streams]) => [key, [...streams]]))
      .toEqual(fanslyLegacyStreamTable().map(([key, streams]) => [key, [...streams]]));
  });

  it("the database copy's subject-level keys are the table's keys whose work carries a subject", () => {
    const tableKeys = new Set(fanslyLegacyStreamTable().map(([key]) => key));
    expect([...FANSLY_ENGINE_SUBJECT_LEVEL_KEYS]).toEqual(
      FANSLY_RESOURCE_SPECS.filter((spec) => tableKeys.has(spec.key) && spec.subject !== "page").map((spec) => spec.key),
    );
  });

  it("every legacy stream an entry names maps back to that entry", () => {
    for (const spec of FANSLY_RESOURCE_SPECS) {
      for (const ref of spec.legacy) {
        if (!("stream" in ref)) continue;
        expect(fanslyKeysForStreams([ref.stream]), `${spec.key} ← ${ref.stream}`).toContain(spec.key);
        expect(fanslyLegacyStreamsOfKey(spec.key)).toContain(ref.stream);
      }
    }
    // A sender-only key takes over no stream.
    expect(fanslyLegacyStreamsOfKey("account.verify")).toEqual([]);
  });

  it("a block's streams name its keys and resource files", () => {
    expect(fanslyKeysForStreams(["top_spenders"])).toEqual(["top-spenders.window", "top-spenders.bootstrap"]);
    expect(fanslyKeysForStreams(["subscribers", "followers", "followers_reconcile"])).toEqual([
      "subscribers.poll",
      "subscribers.history",
      "followers.head",
      "followers.reconcile",
      "fan-profiles.lookup",
    ]);
    expect(fanslyFilesForStreams(["transactions", "fan_identities", "top_spenders"])).toEqual(["top-spenders", "transactions"]);
    expect(fanslyFilesForStreams(["light"])).toEqual(["account"]);
    // OnlyFans-only and retired streams take over nothing.
    expect(fanslyKeysForStreams(["fan_identities"])).toEqual([]);
    expect(fanslyStreamPollSeconds("light")).toBe(3_600);
    expect(fanslyStreamPollSeconds("purchase_history")).toBe(0);
  });

  it("the sync_streams dataset reads the table per stream as a closed values list", () => {
    const values = fanslyEngineStreamKeysValuesSql();
    expect(values.startsWith("values ('light', array['account.poll']::text[], array['account.poll']::text[], '{}'::text[])"))
      .toBe(true);
    // A stream's keys, then its page-level and its subject-level keys.
    expect(values).toContain(
      "('dm_messages', array['dm-messages.head', 'dm-messages.catchup', 'dm-messages.history', 'fan-profiles.probe']::text[], "
        + "'{}'::text[], array['dm-messages.head', 'dm-messages.catchup', 'dm-messages.history', 'fan-profiles.probe']::text[])",
    );
    expect(values).toContain(
      "('followers_reconcile', array['followers.reconcile', 'fan-profiles.lookup']::text[], "
        + "array['followers.reconcile', 'fan-profiles.lookup']::text[], '{}'::text[])",
    );
    // One row per stream the table names.
    const streams = new Set(FANSLY_ENGINE_LEGACY_STREAMS.flatMap(([, owned]) => owned));
    expect(values.match(/\('[a-z_]+', array\[/g)).toHaveLength(streams.size);
    expect(values).not.toMatch(/[;"\\]/);
    const source = AGENT_DATASET_SQL.sync_streams!.source;
    expect(source).toContain(values);
    // Engine-owned pages leave the legacy branch and come from the live work.
    expect(source).toMatch(/esp\.mode in \('handover', 'live'\)/);
    expect(source).toMatch(/from sync_work w[\s\S]*where w\.page_id = sp\.page_id\s+and not w\.shadow/);
    // Never an aggregate over the page's whole attempt journal: per row
    // (`a.work_id = w.id`) or within the last day of the page's attempts.
    expect(source).not.toMatch(/from sync_attempts a\s+join/);
    expect(source).toMatch(/a\.admitted_at >= now\(\) - interval '24 hours'/);
    expect(AGENT_DATASET_SQL.sync_streams!.readPlanes).toEqual([]);
  });
});

describe("owner levers of the engine", () => {
  it("sync work enqueue takes the owner-triggered keys without a lever of their own", () => {
    expect(ownerEnqueueKeys()).toEqual([
      "fan-profiles.alias-backfill",
      "followers.reconcile",
      "notifications.backfill",
      "posts.backfill",
      "stats.backfill",
      "subscribers.history",
      "top-spenders.bootstrap",
      "transactions.backfill",
    ]);
  });

  it("a quarantine records the refusal's own detail, never a driver message", () => {
    expect(applyErrorDetail(new ApplyQuarantine("followers_reconcile_deactivation_blast_radius", { generation: 7 })))
      .toEqual({ generation: 7, refusal: "followers_reconcile_deactivation_blast_radius" });
    expect(applyErrorDetail(new ApplyQuarantine("x", { refusal: "spoofed" }))).toEqual({ refusal: "x" });
    expect(applyErrorDetail(new FanslyContractViolationError("account.id", "missing")))
      .toEqual({ field: "account.id", detail: "missing" });
    const wrapped = Object.assign(new Error("insert into fans values ('secret')"), { code: "23505" });
    expect(applyErrorDetail(wrapped)).toEqual({ error: "23505" });
  });

  it("reads a quarantine record back from a work row's result", () => {
    expect(syncWorkQuarantineOf(null)).toBeNull();
    expect(syncWorkQuarantineOf({ outcome: "restart" })).toBeNull();
    expect(syncWorkQuarantineOf({
      outcome: "restart",
      quarantine: { reason: "apply:quarantine:x", detail: { refusal: "x" }, attemptId: 12, at: "2026-10-02T10:00:00+00:00" },
    })).toEqual({ reason: "apply:quarantine:x", detail: { refusal: "x" }, attemptId: 12, at: "2026-10-02T10:00:00+00:00" });
    expect(syncWorkQuarantineOf({ quarantine: { reason: "plan:page_missing", detail: null, attemptId: null, at: "t" } }))
      .toEqual({ reason: "plan:page_missing", detail: {}, attemptId: null, at: "t" });
  });
});
