import { setTimeout as sleep } from "node:timers/promises";

import type { Pool } from "pg";

import {
  ensureFanslyPageSendGuard,
  insertAuditEvent,
  issueSyncSwitchCapability,
  SYNC_CHAIN_REBUILD_AUDIT_EVENT,
  type Database,
} from "@agency_hub_core/db";
import { createLogger, type AppConfig } from "@agency_hub_core/shared";

import { resolveEgress } from "../../apps/runtime/src/services/egress/resolver.ts";
import { createFanslySendGuards, isFanslyPageOwnedBySyncEngineError } from "../../apps/runtime/src/services/fansly-send-guard/index.ts";
import { createEngineRegistry, type EngineRegistry } from "../../apps/runtime/src/sync/engine/resource.ts";
import { fanslyResourceSpec } from "../../apps/runtime/src/sync/fansly/registry.ts";
import type { SwitchContext, SwitchTiming } from "../../apps/runtime/src/sync/switch/context.ts";
import { silentFanslySendGuardLogger } from "./fansly-send-guard.ts";
import { fanslyJson, harnessRegistry, seedHarnessPage, type FakeRoute, type HarnessHandles, type HarnessPage } from "./sync-engine.ts";

// The step-3 switch and rollback rigs (design step 3 §3.5 tests): the
// physical-request harness of S2-14 with a page in shadow, the preconditions
// the switch checks, a stand-in legacy sender that takes the real step-1 guard
// for every request it sends to the fake origin, and a switch context with
// scaled waits.

/** The build identity the rig's `sync` heartbeat and CLI share. */
export const SWITCH_TEST_BUILD = "0123456789abcdef0123456789abcdef01234567";

/** The legacy sender's route at the fake origin. */
export const LEGACY_PATH = "/api/v1/legacy/ping";

export function legacyRoute(): FakeRoute {
  return (request) => (request.url.pathname === LEGACY_PATH ? fanslyJson({ ok: true }) : null);
}

/** The harness registry plus the production identity checks the switch and
 *  the credentials flows use (`account.verify` is the takeover's first read). */
export function switchRegistry(): EngineRegistry {
  return createEngineRegistry([
    ...harnessRegistry().specs,
    fanslyResourceSpec("account.verify")!,
    fanslyResourceSpec("account.identity")!,
  ]);
}

/** Scaled waits: every phase fails within seconds instead of minutes. */
export const SWITCH_TEST_TIMING: SwitchTiming = {
  guardRetryMs: 50,
  guardTimeoutMs: 2_500,
  stopRetryMs: 100,
  stopTimeoutMs: 2_500,
  ownerTimeoutMs: 20_000,
  ownerRetryMs: 100,
  releaseTimeoutMs: 15_000,
  firstPageRequestsDelayMs: 60 * 60_000,
};

/**
 * A Fansly page in shadow that meets every machine-checked precondition of
 * the switch: its guard row legacy-owned and open, the chains rebuilt, the
 * money writer `fansly`, the `sync` role beating with the rig's build.
 */
export async function seedSwitchPage(
  handles: HarnessHandles,
  input: { label: string; proxyUrl: string; ownRef?: string },
): Promise<HarnessPage> {
  const page = await seedHarnessPage(handles, {
    mode: "shadow",
    proxyUrl: input.proxyUrl,
    label: input.label,
    ...(input.ownRef === undefined ? {} : { ownRef: input.ownRef }),
  });
  await ensureFanslyPageSendGuard(handles.db, page.pageId);
  await handles.pool.query(
    "update fansly_page_send_guards set last_completed_at = clock_timestamp() - interval '1 hour', next_u = 0 where page_id = $1",
    [page.pageId],
  );
  await handles.pool.query("update pages set transactions_writer = 'fansly' where id = $1", [page.pageId]);
  await insertAuditEvent(handles.db, {
    platformAccountId: page.pageId,
    source: "cli",
    eventType: SYNC_CHAIN_REBUILD_AUDIT_EVENT,
    metadata: { scope: "page", completed: true, throughRawId: "0" },
  });
  await beatSync(handles.pool, SWITCH_TEST_BUILD);
  return page;
}

/** The `sync` role's heartbeat with a build identity. */
export async function beatSync(pool: Pool, imageTag: string | null): Promise<void> {
  await pool.query(
    `insert into runtime_instances (role, instance_id, started_at, last_seen_at, image_tag, running)
     values ('sync', 'sync-test', clock_timestamp(), clock_timestamp(), $1, '{}'::jsonb)
     on conflict (role, instance_id) do update set last_seen_at = clock_timestamp(), image_tag = excluded.image_tag`,
    [imageTag],
  );
}

/** An accepted `sync shadow report` that lists the pages in shadow. */
export function acceptedShadowReport(labels: readonly string[], endedAt = new Date()): string {
  return JSON.stringify({
    generatedAt: endedAt.toISOString(),
    pages: labels.map((page) => ({ page, mode: "shadow" })),
    window: { window: { start: new Date(endedAt.getTime() - 3_600_000).toISOString(), end: endedAt.toISOString() } },
    verdict: { accepted: true },
  });
}

export interface SwitchContextHandles {
  db: Database;
  config: AppConfig;
  report?: string;
  lines?: string[];
  recoveries?: string[];
}

/** The switch CLI's context over the rig, as `sync/cli/switch.ts` builds it. */
export function switchContext(handles: SwitchContextHandles, overrides: Partial<SwitchContext> = {}): SwitchContext {
  return {
    db: handles.db,
    rawConfig: handles.config,
    logger: createLogger("silent"),
    actor: "test",
    buildSha: SWITCH_TEST_BUILD,
    liveLoopEnabled: true,
    timing: SWITCH_TEST_TIMING,
    print: (line) => {
      handles.lines?.push(line);
    },
    sleep: async (ms) => {
      await sleep(ms);
    },
    readFile: async () => {
      if (handles.report === undefined) throw new Error("no report");
      return handles.report;
    },
    requestLegacyRecovery: async (label) => {
      handles.recoveries?.push(label);
    },
    inNightWindow: () => false,
    ...overrides,
  };
}

/** The capability factory the CLI passes (the tests issue their own). */
export function testCapability(purpose: string) {
  return (pageId: number) => issueSyncSwitchCapability({ pageId, purpose });
}

/**
 * The legacy engine's sends of a page, as every legacy sender makes them: the
 * real step-1 guard (`createFanslySendGuards`, source `sync_stream`) captured
 * for each request, the request through the page egress with the lease's send
 * check, the completion. Once the guard row belongs to the engine every
 * capture is refused (`engine_owned`): the sender counts the refusal and asks
 * again, as a fenced legacy stream would.
 */
export class LegacySender {
  sent = 0;
  refused = 0;
  failure: unknown = null;
  #stopped = false;
  #loop: Promise<void> | null = null;

  constructor(
    readonly ctx: { db: Database; config: AppConfig },
    readonly pageId: number,
    readonly url: string,
    readonly settingMs: () => number,
  ) {}

  start(): this {
    this.#loop = this.#run().catch((error: unknown) => {
      this.failure = error;
    });
    return this;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await this.#loop;
  }

  async #run(): Promise<void> {
    const guards = createFanslySendGuards({
      db: this.ctx.db,
      config: this.ctx.config,
      logger: silentFanslySendGuardLogger,
      role: "test",
      readSettingMs: async () => this.settingMs(),
    });
    const egress = await resolveEgress(this.ctx, { kind: "page", pageId: this.pageId });
    try {
      while (!this.#stopped) {
        let lease;
        try {
          lease = await guards.forPage(this.pageId, "sync_stream").acquire({ operation: "legacy_ping", requestTimeoutMs: 5_000 });
        } catch (error) {
          if (!isFanslyPageOwnedBySyncEngineError(error)) throw error;
          this.refused += 1;
          await sleep(50);
          continue;
        }
        let status: number | null = null;
        try {
          const response = await fetch(this.url, { dispatcher: lease.bind(egress.dispatcher!) } as RequestInit);
          status = response.status;
          await response.arrayBuffer();
          this.sent += 1;
        } finally {
          await lease.complete({ outcome: status === null ? "transport_error" : "response", httpStatus: status });
        }
      }
    } finally {
      guards.stop();
      await egress.close();
    }
  }
}
