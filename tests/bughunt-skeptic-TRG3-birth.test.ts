import { describe, expect, it } from "vitest";

import type { Database, SyncAttemptRow, SyncPageRow, SyncWorkRow } from "@agency_hub_core/db";

import { createEngineRegistry, pollsFor, type ApplyInput } from "../apps/runtime/src/sync/engine/resource.ts";
import { FANSLY_RESOURCE_SPECS } from "../apps/runtime/src/sync/fansly/registry.ts";
import { postsModule } from "../apps/runtime/src/sync/fansly/resources/posts.ts";
import { ownerEnqueueKeys } from "../apps/runtime/src/sync/inspect.ts";

// Skeptic of TRG-3 (bug hunt 2026-10-09): what a page born live gets on its
// own. Pure: no database, no transport. Each case PASSING confirms one fact
// the claim rests on.

const NOW = new Date("2026-10-09T12:00:00Z");
const DAY = 86_400_000;
const HISTORY_KEYS = ["posts.backfill", "notifications.backfill", "stats.backfill", "subscribers.history"] as const;

function input(variant: string, cursor: unknown, request: ApplyInput["request"], parsed: unknown): ApplyInput {
  return {
    pageId: 99,
    now: NOW,
    ownRef: "acct-99",
    work: { resource: `posts.${variant}`, cursor } as unknown as SyncWorkRow,
    attempt: { admittedAt: NOW } as unknown as SyncAttemptRow,
    request,
    parsed,
    response: parsed,
    observation: { id: 1, receivedAt: NOW },
    fenced: false,
    page: { registryOverrides: {} } as unknown as SyncPageRow,
  };
}

/** One timeline page of 15 posts (the size Fansly serves), all `ageDays` old. */
function timelinePage(firstId: number, ageDays: number) {
  return {
    posts: Array.from({ length: 15 }, (_, index) => ({
      id: String(firstId - index),
      createdAt: NOW.getTime() - ageDays * DAY - index * 60_000,
      content: "",
    })),
  };
}

describe("TRG-3: a page born live", () => {
  it("has no standing row for any history walk", () => {
    const rows = pollsFor(createEngineRegistry(FANSLY_RESOURCE_SPECS), { registryOverrides: {} }).map((row) => row.resource);
    for (const key of HISTORY_KEYS) expect(rows).not.toContain(key);
  });

  it("can reach the history walks only through the owner's `sync work enqueue`", () => {
    for (const key of HISTORY_KEYS) {
      const spec = FANSLY_RESOURCE_SPECS.find((candidate) => candidate.key === key)!;
      expect(spec.kind).toBe("goal");
      expect(spec.triggers).toEqual(["owner"]);
      expect(ownerEnqueueKeys()).toContain(key);
    }
  });

  it("first posts.refresh on an empty cursor is still bounded: a page wholly older than now − 14 d ends it", async () => {
    const refresh = await postsModule("refresh");
    const page = timelinePage(1_000, 20);
    const first = await refresh.apply({} as Database, input("refresh", null, {
      spec: "posts.timeline", params: { accountId: "acct-99", before: "0" },
    }, page));
    // The closing page's tips are read, then the walk completes.
    const tipsOf = (first.work.cursor as { walk: { pendingTips: string[]; end: string | null } }).walk;
    expect(tipsOf.end).toBe("cutoff_reached");
    const second = await refresh.apply({} as Database, input("refresh", first.work.cursor, {
      spec: "posts.tips", params: { targetIds: tipsOf.pendingTips },
    }, []));
    expect(second.work).toMatchObject({ close: "done", closeReason: "walk_cutoff_reached" });
    // Never marked as a full walk: nothing reads this field anyway.
    expect((second.work.cursor as { tipsBackfilledAt: string | null }).tipsBackfilledAt).toBeNull();
  });

  it("control: posts.backfill walks on past the same page", async () => {
    const backfill = await postsModule("backfill");
    const first = await backfill.apply({} as Database, input("backfill", null, {
      spec: "posts.timeline", params: { accountId: "acct-99", before: "0" },
    }, timelinePage(1_000, 20)));
    const walk = (first.work.cursor as { walk: { end: string | null; before: string } }).walk;
    expect(walk.end).toBeNull();
    expect(walk.before).toBe("986");
  });
});
