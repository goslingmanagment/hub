import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// Step 4 S4-13 (owner decision №11, plan §11; design S4-13, §4): Fansly stops
// writing `page_dm_messages`. The readers of a live page read
// `message_archive` (S4-08); the Sync Engine's DM apply inserts no hot row,
// and the engine's only write to the table is the deletion mark of a row
// legacy stored (`dm-live.deletions`, so the frozen snapshot never shows a
// deleted message as live). OnlyFans keeps writing the table. This pins who
// names the table, every write statement on it and every caller of its
// writers. It is a ceiling: a new reader or writer fails until it is listed
// here with its reason — a change of the list is a review of the boundary.
// A row whose code a later step-4 PR deletes says which; that PR drops it.

const ROOT = join(__dirname, "..");
const SCANNED = ["apps", "packages", "scripts"];

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx|mts|mjs|js)$/.test(entry)) files.push(relative(ROOT, path));
    }
  };
  for (const directory of SCANNED) walk(join(ROOT, directory));
  return files.sort();
}

const files = sourceFiles();
const sources = new Map(files.map((file) => [file, readFileSync(join(ROOT, file), "utf8")]));
const matching = (pattern: RegExp) => files.filter((file) => pattern.test(sources.get(file)!));
const outside = (found: readonly string[], allowed: Readonly<Record<string, unknown>>) =>
  found.filter((file) => !Object.hasOwn(allowed, file));

const ENGINE = "apps/runtime/src/sync/";

/** Every file that names `page_dm_messages` (SQL) or `pageDmMessages` (the
 *  Drizzle table), and why. */
const SANCTIONED_FILES: Record<string, string> = {
  // The table, its repository and the planes that name it.
  "packages/db/src/schema.ts": "the table's definition",
  "packages/db/src/repositories/page-dm.ts":
    "the page DM repository: the hot writers (OnlyFans) and the readers whose default store it is (OnlyFans)",
  "packages/contracts/src/agent-read-registry.ts": "the agent read plane's name",
  "apps/runtime/src/modules/agent-read/planes.ts": "the agent read plane's name",
  // OnlyFans writes and reads it.
  "apps/runtime/src/services/ofapi-dm-projection.ts": "the OnlyFans DM projection (the table's writer)",
  "packages/db/src/repositories/ofapi-sync-snapshot.ts": "the OnlyFans sync snapshot",
  "packages/db/src/repositories/ppv-purchase-facts.ts": "OnlyFans PPV purchase marks (pages.platform = 'onlyfans')",
  "apps/runtime/src/services/ppv-purchase-backfill.ts": "the OnlyFans PPV backfill CLI",
  "packages/db/src/repositories/ai-transcript-union.ts": "the OnlyFans AI transcript union (tombstones, PPV upgrade)",
  "packages/db/src/repositories/agent-hydration.ts": "the hydration boundary of the OnlyFans lane",
  // Readers that serve each page from the store its sync mode names
  // (`dmReaderStoreOf`, S4-08): the archive on a live page, this table elsewhere.
  "apps/runtime/src/services/conversations.ts": "the chat routes pass the page's store",
  "apps/runtime/src/modules/agent-read/handlers-threads.ts": "the agent transcript's hot arm, off on a live page",
  "packages/db/src/repositories/agent-transcript.ts": "the agent transcript's hot arm, off on a live page",
  "packages/db/src/repositories/sync/live-messages.ts": "the overlay dedup and its passive confirm, by the page's store",
  "packages/db/src/repositories/sync/thread-chain.ts": "the fold's stored facts by the page's store (the chain rebuild refuses live pages)",
  "apps/runtime/src/sync/fansly/lib/chain.ts": "comment: the store the fold's stored facts come from",
  "apps/runtime/src/sync/fansly/lib/chain-checks.ts": "comment: the store the chain checks read",
  // Erasure, retention and maintenance.
  "apps/runtime/src/services/erasure/index.ts": "the erasure inventory (the rows go by the threads' cascade)",
  "packages/db/src/repositories/erasure-fence.ts": "comment: the fence keeps erased rows from coming back",
  "apps/runtime/src/services/page-dm-retention.ts": "the hot-table prune gate",
  "packages/db/src/repositories/message-archive.ts":
    "maintenance: backfillArchiveFromHotTable, countArchiveCoverageGaps, the census, the prune gate",
  "packages/db/src/repositories/catalog.ts": "the page's business-fact presence",
  "apps/runtime/src/services/fansly-page.ts": "comment: the platform-agnostic DM store",
  "apps/runtime/src/cli.ts": "maintenance CLI descriptions",
  // The Sync Engine: no hot row is written (I23); deletion marks only.
  "apps/runtime/src/sync/fansly/resources/dm-live.ts": "the deletion mark of the rows legacy stored (markFanslyWsHotDeletion)",
  "apps/runtime/src/sync/fansly/resources/dm-messages.ts": "comment: the DM apply writes no hot row",
  "apps/runtime/src/sync/fansly/lib/dm-normalize.ts": "comment: the legacy lanes stored its rows, the engine does not",
  "packages/db/src/repositories/fansly-ws-deletions.ts": "markFanslyWsHotDeletion (the engine's mark)",
  // The reader parity (S4-06) compares against legacy's rows. (The shadow
  // report and its replay did too, until S4-22 deleted them.)
  "apps/runtime/src/sync/cli/dm-reader-parity.ts": "the reader parity CLI",
  "apps/runtime/src/sync/parity/classify.ts": "the reader parity",
  "apps/runtime/src/sync/parity/run.ts": "the reader parity",
  "packages/db/src/repositories/sync/dm-reader-parity.ts": "the reader parity",
  // What is left of the legacy Fansly DM code since S4-14 deleted its handlers
  // and S4-15 the targeted backfill with its page fetch.
  "packages/db/src/repositories/fansly-dm-reader-heads.ts": "the exact-id reader heads of the WS recovery manifest",
  "packages/db/src/repositories/sync.ts": "the sync monitor's DM message count (listSyncMonitorStreamRows)",
};

/** Files with an INSERT, UPDATE or DELETE on the table (SQL or Drizzle), and
 *  how many statements each holds at most. */
const WRITE_STATEMENTS: Record<string, number> = {
  // upsertPageDmMessages, deletePageDmMessageByPlatformMessageId,
  // markPageDmMessagePurchased, raisePageDmMessageTipAmount,
  // prunePageDmMessagesToLimit, resetPageDmSyncState.
  "packages/db/src/repositories/page-dm.ts": 6,
  // markFanslyWsHotDeletion.
  "packages/db/src/repositories/fansly-ws-deletions.ts": 1,
  // markHotPurchasesFromLedger (OnlyFans).
  "packages/db/src/repositories/ppv-purchase-facts.ts": 1,
};

/** The writers of the table (the two last prune it), and every file that may
 *  call them. */
const WRITERS: Record<string, Record<string, string>> = {
  upsertPageDmMessages: { "apps/runtime/src/services/ofapi-dm-projection.ts": "OnlyFans" },
  deletePageDmMessageByPlatformMessageId: { "apps/runtime/src/services/ofapi-dm-projection.ts": "OnlyFans" },
  markPageDmMessagePurchased: { "apps/runtime/src/services/ofapi-dm-projection.ts": "OnlyFans" },
  raisePageDmMessageTipAmount: { "apps/runtime/src/services/ofapi-dm-projection.ts": "OnlyFans" },
  markHotPurchasesFromLedger: { "apps/runtime/src/services/ppv-purchase-backfill.ts": "the OnlyFans PPV backfill" },
  resetPageDmSyncState: { "apps/runtime/src/services/sync-blocks.ts": "the legacy block reset (refused for messages)" },
  markFanslyWsHotDeletion: {
    "apps/runtime/src/sync/fansly/resources/dm-live.ts": "the engine's deletion mark of a legacy row",
  },
  prunePageDmMessagesToLimit: {},
  refreshPageDmConversationWindow: { "apps/runtime/src/services/ofapi-dm-projection.ts": "OnlyFans" },
};

/** Where each writer is defined (calls inside it are its own). */
const WRITER_HOME: Record<string, string> = {
  upsertPageDmMessages: "packages/db/src/repositories/page-dm.ts",
  deletePageDmMessageByPlatformMessageId: "packages/db/src/repositories/page-dm.ts",
  markPageDmMessagePurchased: "packages/db/src/repositories/page-dm.ts",
  raisePageDmMessageTipAmount: "packages/db/src/repositories/page-dm.ts",
  prunePageDmMessagesToLimit: "packages/db/src/repositories/page-dm.ts",
  refreshPageDmConversationWindow: "packages/db/src/repositories/page-dm.ts",
  resetPageDmSyncState: "packages/db/src/repositories/page-dm.ts",
  markFanslyWsHotDeletion: "packages/db/src/repositories/fansly-ws-deletions.ts",
  markHotPurchasesFromLedger: "packages/db/src/repositories/ppv-purchase-facts.ts",
};

const WRITE_STATEMENT = new RegExp(
  [
    String.raw`\b(?:insert\s+into|update|delete\s+from)\s+(?:\$\{\s*)?(?:page_dm_messages|pageDmMessages)\b`,
    String.raw`\.(?:insert|update|delete)\(\s*pageDmMessages\s*\)`,
  ].join("|"),
  "gi",
);

const callersOf = (writer: string) =>
  matching(new RegExp(String.raw`\b${writer}\(`)).filter((file) => file !== WRITER_HOME[writer]);

describe("page_dm_messages boundary (step 4 S4-13, owner decision №11)", () => {
  it("is named only by the sanctioned files", () => {
    expect(outside(matching(/\bpage_dm_messages\b|\bpageDmMessages\b/), SANCTIONED_FILES)).toEqual([]);
  });

  it("is written only by the repository writers", () => {
    const counts = new Map<string, number>();
    for (const file of files) {
      const n = sources.get(file)!.match(WRITE_STATEMENT)?.length ?? 0;
      if (n > 0) counts.set(file, n);
    }
    expect(outside([...counts.keys()], WRITE_STATEMENTS)).toEqual([]);
    for (const [file, n] of counts) expect(n, file).toBeLessThanOrEqual(WRITE_STATEMENTS[file]!);
    // The pattern itself still finds the statements it pins.
    expect(counts.get("packages/db/src/repositories/fansly-ws-deletions.ts")).toBe(1);
    expect(counts.get("packages/db/src/repositories/ppv-purchase-facts.ts")).toBe(1);
  });

  it("has its writers called only by the sanctioned callers", () => {
    expect(Object.keys(WRITERS).sort()).toEqual(Object.keys(WRITER_HOME).sort());
    for (const [writer, allowed] of Object.entries(WRITERS)) {
      expect(sources.get(WRITER_HOME[writer]!), writer).toMatch(new RegExp(String.raw`export async function ${writer}\(`));
      expect(outside(callersOf(writer), allowed), writer).toEqual([]);
    }
    // No writer is imported under another name.
    const aliased = new RegExp(String.raw`\b(?:${Object.keys(WRITERS).join("|")})\s+as\s+\w`);
    expect(matching(aliased)).toEqual([]);
  });

  it("gets no row from the Sync Engine, which only marks the deletion of a row legacy stored (I23)", () => {
    const engineCalls: Record<string, string[]> = {};
    for (const writer of Object.keys(WRITERS)) {
      for (const file of callersOf(writer).filter((caller) => caller.startsWith(ENGINE))) {
        (engineCalls[file] ??= []).push(writer);
      }
    }
    expect(engineCalls).toEqual({ "apps/runtime/src/sync/fansly/resources/dm-live.ts": ["markFanslyWsHotDeletion"] });
    // Not even named (an import, a type): the engine has no way to the inserts.
    expect(matching(/\bupsertPageDmMessages\b/).filter((file) => file.startsWith(ENGINE))).toEqual([]);
    // The DM apply feeds the archive and the summary from it.
    const apply = sources.get("apps/runtime/src/sync/fansly/resources/dm-messages.ts")!;
    expect(apply).toContain("await applyMessageEventsToArchive(tx, {");
    expect(apply).toContain("await writeThreadSummary(tx, summary, {");
  });
});
