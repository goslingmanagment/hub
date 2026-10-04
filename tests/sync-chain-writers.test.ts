import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// Fansly Sync Engine invariant I9 (design §1, §2.3, §8.1): the chain columns
// of a DM thread have ONE writer module, and the engine writes the legacy
// coverage columns only through `writeThreadSummary` (and its deletion
// recount), from message_archive since step 4 (S4-08).
//
// The census reads every statement that writes `page_dm_threads` (raw SQL
// `update`/`insert`, drizzle `.update(...)`/`.insert(...)` of the table or its
// `pageDmConversations` alias) and requires that none outside
// repositories/sync/thread-chain.ts names a chain column.

const root = join(__dirname, "..");
const WRITER = "packages/db/src/repositories/sync/thread-chain.ts";

const CHAIN_COLUMNS = [
  "head_confirmed_id", "head_confirmed_at", "contiguous_oldest_id", "contiguous_oldest_at", "contiguous_count",
  "chain_upward_count", "chain_epoch", "history_state", "history_proof", "history_proven_at",
  "history_proof_observation_id", "history_proof_observation_received_at", "history_proof_raw_payload_id",
  "chain_source", "chain_journal_watermark",
];
const camel = (name: string) => name.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
const CHAIN_NAMES = [...CHAIN_COLUMNS, ...CHAIN_COLUMNS.map(camel)];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir))) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(dir, entry);
    const stats = statSync(join(root, path));
    if (stats.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

const SOURCES = [
  ...sourceFiles("apps/runtime/src"),
  ...readdirSync(join(root, "packages")).flatMap((name) => {
    try {
      return sourceFiles(join("packages", name, "src"));
    } catch {
      return [];
    }
  }),
].map((path) => relative(root, join(root, path)));

const THREAD_WRITE = /(update\s+page_dm_threads\b|insert\s+into\s+page_dm_threads\b|\.update\(\s*(pageDmThreads|pageDmConversations)\s*\)|\.insert\(\s*(pageDmThreads|pageDmConversations)\s*\))/gi;

/** The text of each statement that writes the thread table: from the verb to
 *  the end of the SQL template or the drizzle `.where(` / `.returning(`. */
function threadWrites(text: string): string[] {
  const chunks: string[] = [];
  for (const match of text.matchAll(THREAD_WRITE)) {
    const start = match.index;
    const rest = text.slice(start + match[0].length, start + 4000);
    const ends = ["`", ".where(", ".returning(", ".onConflict"].map((token) => rest.indexOf(token)).filter((index) => index >= 0);
    chunks.push(match[0] + rest.slice(0, ends.length === 0 ? rest.length : Math.min(...ends)));
  }
  return chunks;
}

describe("DM thread chain writers (I9)", () => {
  it("finds the thread writers it censuses (the census is not empty)", () => {
    const writers = SOURCES.filter((path) => threadWrites(readFileSync(join(root, path), "utf8")).length > 0);
    expect(writers).toContain("packages/db/src/repositories/page-dm.ts");
    expect(writers).toContain(WRITER);
  });

  it("writes the chain columns only in repositories/sync/thread-chain.ts", () => {
    const offenders: string[] = [];
    for (const path of SOURCES) {
      if (path === WRITER) continue;
      for (const chunk of threadWrites(readFileSync(join(root, path), "utf8"))) {
        const named = CHAIN_NAMES.filter((name) => new RegExp(`\\b${name}\\b`).test(chunk));
        if (named.length > 0) offenders.push(`${path}: ${named.join(", ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the engine off the legacy coverage writers", () => {
    const legacyWriters = /\b(refreshPageDmConversationWindow|resetPageDmSyncState|upsertPageDmConversation)\b/;
    const engine = SOURCES.filter((path) => path.startsWith("apps/runtime/src/sync/"));
    expect(engine.length).toBeGreaterThan(0);
    expect(engine.filter((path) => legacyWriters.test(readFileSync(join(root, path), "utf8")))).toEqual([]);
    expect(engine.filter((path) => threadWrites(readFileSync(join(root, path), "utf8")).length > 0)).toEqual([]);
  });

  it("writes legacy coverage columns from the engine's repositories only through writeThreadSummary and writeThreadSummaryAfterDeletion", () => {
    const syncRepositories = SOURCES.filter((path) => path.startsWith("packages/db/src/repositories/sync/"));
    const legacyAssignment = /\b(stored_message_count|message_coverage_status|message_backfill_complete|last_message_sync_at)\s*=\s*[^=]/;
    expect(syncRepositories.filter((path) => threadWrites(readFileSync(join(root, path), "utf8"))
      .some((chunk) => legacyAssignment.test(chunk)))).toEqual([WRITER]);
    const writer = readFileSync(join(root, WRITER), "utf8");
    const legacyChunks = threadWrites(writer).filter((chunk) => legacyAssignment.test(chunk));
    // A read's stored rows, a socket deletion's marked row (design §3.3 item 4, E7).
    expect(legacyChunks).toHaveLength(2);
    for (const name of ["writeThreadSummary", "writeThreadSummaryAfterDeletion"]) {
      expect(writer).toMatch(new RegExp(`export async function ${name}\\(`));
    }
    // Each statement asserts the page mode in its own WHERE (no read-then-write).
    for (const chunk of legacyChunks) expect(chunk).toMatch(/and sp\.mode in \('handover', 'live'\)/);
  });
});
