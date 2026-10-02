import type { SyncStream } from "@agency_hub_core/db";

import { FANSLY_RESOURCE_SPECS, type ResourceFile, type ResourceSpec } from "./registry.ts";

// Legacy stream ↔ registry key (design step 3 §3.2): what an owner lever or a
// status surface that speaks in legacy streams (the Settings blocks, the
// `sync_streams` dataset, the scope of "sync now") means on a page the engine
// owns. Generated from the registry's `legacy` refs — one source of truth;
// `@agency_hub_core/db`'s `FANSLY_ENGINE_LEGACY_STREAMS` is its SQL-side copy,
// pinned equal by tests/sync-legacy-streams.test.ts.

/** Registry key → the legacy streams it takes over (streams only, registry
 *  order; keys that take over only senders are absent). */
export function fanslyLegacyStreamTable(
  specs: readonly ResourceSpec[] = FANSLY_RESOURCE_SPECS,
): Array<readonly [string, readonly SyncStream[]]> {
  const table: Array<readonly [string, readonly SyncStream[]]> = [];
  for (const spec of specs) {
    const streams = spec.legacy.flatMap((ref) => ("stream" in ref ? [ref.stream] : []));
    if (streams.length > 0) table.push([spec.key, streams]);
  }
  return table;
}

const SECOND_MS = 1_000;
const TABLE = fanslyLegacyStreamTable();
const SPEC_BY_KEY = new Map(FANSLY_RESOURCE_SPECS.map((spec) => [spec.key, spec] as const));

/** The registry keys that take over any of `streams`, in registry order. */
export function fanslyKeysForStreams(streams: readonly SyncStream[]): string[] {
  const wanted = new Set(streams);
  return TABLE.filter(([, owned]) => owned.some((stream) => wanted.has(stream))).map(([key]) => key);
}

/** The resource files of those keys (the unit of "sync now"), sorted. */
export function fanslyFilesForStreams(streams: readonly SyncStream[]): ResourceFile[] {
  const files = new Set<ResourceFile>();
  for (const key of fanslyKeysForStreams(streams)) {
    const spec = SPEC_BY_KEY.get(key);
    if (spec !== undefined) files.add(spec.file);
  }
  return [...files].sort();
}

/** The legacy streams a key takes over (empty for a sender-only key). */
export function fanslyLegacyStreamsOfKey(key: string): readonly SyncStream[] {
  return TABLE.find(([candidate]) => candidate === key)?.[1] ?? [];
}

/** The poll period of a stream's first poll key, in seconds (0: no poll). */
export function fanslyStreamPollSeconds(stream: SyncStream): number {
  for (const key of fanslyKeysForStreams([stream])) {
    const spec = SPEC_BY_KEY.get(key);
    // Registry periods are whole seconds.
    if (spec?.kind === "poll" && spec.period !== undefined) return Math.floor(spec.period.everyMs / SECOND_MS);
  }
  return 0;
}
