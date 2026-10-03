import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { canonicalJson, type Database, type MediaStatsTiers, type SyncPageRow } from "@agency_hub_core/db";

import type { LongTailWindowMode } from "../../services/sync/fansly-media-stats.ts";
import type { SettingsSource } from "../engine/ports.ts";
import { FANSLY_RESOURCE_SPECS } from "../fansly/registry.ts";
import { mediaStatsOwnerTiers, parseMediaStatsWalkCursor, shadowLongTailMode } from "../fansly/resources/media-stats.ts";
import { ROUTE_POLICY_HASH } from "../fansly/routes.ts";

// The shadow report's fingerprint (step 3b ruling 12): what the shadow hour
// ran on, so the switch accepts a report only of the build and the route
// budget policy it switches to. An accepted report of another build — the
// previous release's hour, still within its 24 h — proves nothing about this
// one: the step-3b set changes how every page paces its routes.
//
//   build    the `sync` build that made every listed shadow page's decisions
//            through the window, proven from the database: one fresh `sync`
//            heartbeat build that started before the window, every page's
//            owner acquired since that start and before the window, and no
//            shadow attempt of the window by another owner generation. A
//            report can only prove the process that runs now: a restart or a
//            deploy after the window leaves the build unproven (run the
//            report right after its hour).
//   policy   the route budget table's hash (`ROUTE_POLICY_HASH`).
//   registry the resource registry's code (every entry but its module), and
//            per page the owner's overrides, the media-stats tiers and the
//            long-tail window mode the shadow models (owner decision №6,
//            ruling 12: media as live).
//   S        the owner's pause setting now, and the settings the window's
//            shadow admissions recorded.
//
// The switch requires the same build and policy (`judgeShadowFingerprint`);
// S, the overrides and the tiers are printed for the owner, never required:
// they are owner levers that change without a release.

/** The fingerprint shape this build writes and the switch reads. */
export const SHADOW_FINGERPRINT_VERSION = 1;
/** A `sync` heartbeat this old is a stopped process (the switch's own bound). */
export const SYNC_BUILD_FRESH_MS = 90_000;
/** The app clock of a heartbeat's start against the database clock of an
 *  owner's acquisition. */
export const OWNER_START_SKEW_MS = 5_000;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalJson(value))).digest("hex");
}

/** The hash of registry entries: every key, kind, period, tier, cadence, route
 *  and flag, in any key order (an entry's module is code, not data: left out). */
export function registryHashOf(specs: readonly object[]): string {
  return digest(specs);
}

/** The resource registry's hash of this build. */
export const FANSLY_REGISTRY_HASH: string = registryHashOf(FANSLY_RESOURCE_SPECS);

export interface ShadowFingerprintPage {
  page: string;
  /** The page's registry overrides as stored (`sync page override`). */
  overrides: Record<string, unknown>;
  /** What the shadow's media-stats walk models on the page: its effective
   *  tiers and the long-tail window mode (`shadowLongTailMode`). */
  media: { tiers: MediaStatsTiers; longTailWindowMode: LongTailWindowMode };
}

export interface ShadowBuildProof {
  /** The `sync` build of the whole window (its heartbeat's image tag); null
   *  when the database does not prove one. */
  sync: string | null;
  /** Why not (null when proven). */
  unproven: string | null;
  /** The build of the process that wrote the report. */
  report: string | null;
}

export interface ShadowReportFingerprint {
  version: typeof SHADOW_FINGERPRINT_VERSION;
  build: ShadowBuildProof;
  /** The route budget policy of the report's build (`ROUTE_POLICY_HASH`). */
  policyHash: string;
  /** `FANSLY_REGISTRY_HASH` of the report's build. */
  registryHash: string;
  /** S: the effective `fanslyDefaultDelayMs` at the report (null: unreadable)
   *  and every setting the window's shadow admissions recorded. */
  setting: { effectiveMs: number | null; windowMs: number[] };
  pages: ShadowFingerprintPage[];
}

/** What the database shows of the processes behind a window. */
export interface SyncBuildFacts {
  /** Every fresh `sync` heartbeat at the report. */
  instances: Array<{ imageTag: string | null; startedAt: Date }>;
  /** Each listed page in shadow: its owner's acquisition, and the window's
   *  shadow attempts of another owner generation. */
  pages: Array<{ page: string; acquiredAt: Date | null; foreignAttempts: number }>;
}

function knownTag(tag: string | null): tag is string {
  return tag !== null && tag.trim().length > 0 && tag !== "unknown";
}

/** The build that ran a window's shadow, or why the facts do not prove one. Pure. */
export function judgeSyncBuild(facts: SyncBuildFacts, window: { start: Date } | null): { sync: string | null; unproven: string | null } {
  const unproven = (why: string) => ({ sync: null, unproven: why });
  if (window === null) return unproven("no window (part A did not run)");
  if (facts.instances.length === 0) return unproven("no fresh sync heartbeat: the process that ran the window is not known");
  if (!facts.instances.every((instance) => knownTag(instance.imageTag))) {
    return unproven("a sync heartbeat without a build identity");
  }
  const tags = [...new Set(facts.instances.map((instance) => instance.imageTag!))].sort();
  if (tags.length > 1) return unproven(`sync heartbeats of ${tags.length} builds (${tags.join(", ")})`);
  const startMs = Math.min(...facts.instances.map((instance) => instance.startedAt.getTime()));
  if (startMs > window.start.getTime()) {
    return unproven(`the sync process started ${new Date(startMs).toISOString()}, after the window start: a deploy or restart in or after the window`);
  }
  if (facts.pages.length === 0) return unproven("no listed page is in shadow");
  for (const page of facts.pages) {
    if (page.acquiredAt === null) return unproven(`${page.page} has no owner`);
    if (page.acquiredAt.getTime() > window.start.getTime()) {
      return unproven(`${page.page}'s owner took it ${page.acquiredAt.toISOString()}, after the window start`);
    }
    if (page.acquiredAt.getTime() < startMs - OWNER_START_SKEW_MS) {
      return unproven(`${page.page}'s owner took it ${page.acquiredAt.toISOString()}, before the running sync process started`);
    }
    if (page.foreignAttempts > 0) {
      return unproven(`${page.page} has ${page.foreignAttempts} shadow attempt(s) of another owner generation in the window`);
    }
  }
  return { sync: tags[0]!, unproven: null };
}

async function readSyncBuildFacts(
  db: Database,
  input: { pages: readonly SyncPageRow[]; window: { start: Date; end: Date } },
): Promise<SyncBuildFacts> {
  const instances = await db.execute<{ imageTag: string | null; startedAt: Date | string }>(sql`
    select image_tag as "imageTag", started_at as "startedAt"
      from runtime_instances
     where role = 'sync'
       and last_seen_at > clock_timestamp() - ${SYNC_BUILD_FRESH_MS}::double precision * interval '1 millisecond'
  `);
  const shadowPages = input.pages.filter((page) => page.mode === "shadow");
  const ids = shadowPages.map((page) => page.pageId);
  const owners = ids.length === 0 ? { rows: [] } : await db.execute<{ pageId: string; acquiredAt: Date | string | null; foreign: number }>(sql`
    select sp.page_id::text as "pageId",
           sp.owner_acquired_at as "acquiredAt",
           (select count(*)::int from sync_attempts a
             where a.page_id = sp.page_id and a.shadow
               and a.admitted_at >= ${input.window.start} and a.admitted_at < ${input.window.end}
               and a.owner_generation is distinct from sp.owner_generation) as "foreign"
      from sync_pages sp
     where sp.page_id = any(${sql.param(ids.map(String))}::bigint[])
  `);
  const byId = new Map(owners.rows.map((row) => [Number(row.pageId), row]));
  return {
    instances: instances.rows.map((row) => ({ imageTag: row.imageTag, startedAt: new Date(row.startedAt) })),
    pages: shadowPages.map((page) => {
      const row = byId.get(page.pageId);
      return {
        page: page.pageLabel ?? String(page.pageId),
        acquiredAt: row?.acquiredAt == null ? null : new Date(row.acquiredAt),
        foreignAttempts: Number(row?.foreign ?? 0),
      };
    }),
  };
}

async function windowSettings(db: Database, input: { pageIds: readonly number[]; window: { start: Date; end: Date } }): Promise<number[]> {
  if (input.pageIds.length === 0) return [];
  const result = await db.execute<{ settingMs: number }>(sql`
    select distinct a.setting_ms as "settingMs"
      from sync_attempts a
     where a.shadow
       and a.page_id = any(${sql.param(input.pageIds.map(String))}::bigint[])
       and a.admitted_at >= ${input.window.start} and a.admitted_at < ${input.window.end}
     order by 1
  `);
  return result.rows.map((row) => Number(row.settingMs));
}

/** The media-stats model of one page as the shadow walk plans it now. */
async function shadowMediaModel(
  db: Database,
  page: Pick<SyncPageRow, "pageId" | "registryOverrides">,
): Promise<ShadowFingerprintPage["media"]> {
  const result = await db.execute<{ cursor: unknown }>(sql`
    select cursor from sync_work
     where page_id = ${page.pageId} and shadow and resource = 'media-stats.walk' and state = 'open'
     order by id desc limit 1
  `);
  const cursor = parseMediaStatsWalkCursor(result.rows[0]?.cursor ?? null);
  return {
    tiers: mediaStatsOwnerTiers(page),
    longTailWindowMode: await shadowLongTailMode(db, { pageId: page.pageId, cursor }),
  };
}

/** The report's fingerprint, read in the report's own snapshot. */
export async function readShadowFingerprint(
  db: Database,
  input: {
    pages: readonly SyncPageRow[];
    window: { start: Date; end: Date } | null;
    settings: SettingsSource;
    reportBuild: string | null;
  },
): Promise<ShadowReportFingerprint> {
  const facts = input.window === null ? { instances: [], pages: [] } : await readSyncBuildFacts(db, { pages: input.pages, window: input.window });
  // Unreadable settings (or none) leave S unknown, never the report unwritten.
  const effectiveMs = await Promise.resolve()
    .then(() => input.settings.read())
    .then((config) => config.fanslyDefaultDelayMs)
    .catch(() => null);
  const pages: ShadowFingerprintPage[] = [];
  for (const page of input.pages) {
    pages.push({ page: page.pageLabel ?? String(page.pageId), overrides: page.registryOverrides, media: await shadowMediaModel(db, page) });
  }
  return {
    version: SHADOW_FINGERPRINT_VERSION,
    build: { ...judgeSyncBuild(facts, input.window), report: input.reportBuild },
    policyHash: ROUTE_POLICY_HASH,
    registryHash: FANSLY_REGISTRY_HASH,
    setting: {
      effectiveMs,
      windowMs: input.window === null ? [] : await windowSettings(db, { pageIds: input.pages.map((page) => page.pageId), window: input.window }),
    },
    pages,
  };
}

// ── the switch's side ────────────────────────────────────────────────────────

/** What the switching build runs: the `sync` heartbeat's build (the switch's
 *  build check holds it equal to the CLI's own) and its route policy. */
export interface ShadowFingerprintExpectation {
  syncBuild: string | null;
  policyHash: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a report's fingerprint (`report.fingerprint`, as JSON) is of the
 * build and route policy the switch runs. Pure; a report without one is a
 * report of an older build.
 */
export function judgeShadowFingerprint(value: unknown, expected: ShadowFingerprintExpectation): { ok: boolean; detail: string } {
  const refuse = (detail: string) => ({ ok: false, detail });
  if (!isRecord(value) || value.version !== SHADOW_FINGERPRINT_VERSION) {
    return refuse("the shadow report carries no fingerprint of this build's kind: a fresh shadow hour on this build");
  }
  const build = isRecord(value.build) ? value.build : {};
  const sync = typeof build.sync === "string" ? build.sync : null;
  if (sync === null) {
    const why = typeof build.unproven === "string" ? build.unproven : "no build";
    return refuse(`the shadow report proves no single sync build through its window (${why})`);
  }
  if (expected.syncBuild === null || sync !== expected.syncBuild) {
    return refuse(`the shadow window ran build ${sync}, sync runs ${expected.syncBuild ?? "an unknown build"}: a fresh shadow hour on this build`);
  }
  const policyHash = typeof value.policyHash === "string" ? value.policyHash : null;
  if (policyHash !== expected.policyHash) {
    return refuse(`the shadow window ran route policy ${policyHash?.slice(0, 12) ?? "none"}, this build ${expected.policyHash.slice(0, 12)}`);
  }
  const setting = isRecord(value.setting) ? value.setting : {};
  const windowMs = Array.isArray(setting.windowMs) ? setting.windowMs.filter((ms): ms is number => typeof ms === "number") : [];
  return {
    ok: true,
    detail: `build ${sync}, route policy ${policyHash.slice(0, 12)}${windowMs.length === 0 ? "" : `, S ${windowMs.join(" / ")} ms in the window`}`,
  };
}
