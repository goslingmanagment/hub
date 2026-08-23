import { vi } from "vitest";

import { FanslyApiError } from "@agency_hub_core/fansly";
import {
  createFanslyPage,
  createModel,
  startSyncRun,
  type SyncStream,
} from "@agency_hub_core/db";

import { SyncChunkBudget } from "../../apps/runtime/src/services/sync/chunk-budget.ts";
import type { StartedTestDatabase } from "./db.ts";

export function fanslyLaneAppStub(input: {
  database: StartedTestDatabase;
  adapter: unknown;
  config: Record<string, unknown>;
  logger?: unknown;
}) {
  return {
    db: input.database.db,
    adapter: input.adapter,
    logger: input.logger ?? { info: () => {}, warn: () => {}, error: () => {} },
    config: input.config,
  } as never;
}

export async function seedFanslyLanePage(
  database: StartedTestDatabase,
  input: {
    slug: string;
    name: string;
    label: string;
    accountRef: string;
    stream: SyncStream;
  },
) {
  const model = await createModel(database.db, { slug: input.slug, name: input.name });
  if (!model) throw new Error(`Expected ${input.label} test model to be created`);
  const page = await createFanslyPage(database.db, { modelId: model.id, label: input.label });
  if (!page) throw new Error(`Expected ${input.label} test page to be created`);
  await database.pool.query("update pages set external_page_id = $1 where id = $2", [
    input.accountRef,
    page.id,
  ]);
  const run = await startSyncRun(database.db, {
    platformAccountId: page.id,
    stream: input.stream,
    trigger: "scheduled",
  });
  if (!run) throw new Error(`Expected ${input.label} sync run to be created`);
  return { page, syncRunId: run.id };
}

export function fanslyLaneTelemetryStub() {
  const anomalies: Array<Record<string, unknown>> = [];
  return {
    anomalies,
    recordPhaseStarted: vi.fn(async () => {}),
    recordCheckpointLoaded: vi.fn(async () => {}),
    recordCheckpointAdvanced: vi.fn(async () => {}),
    addNote: vi.fn(async () => {}),
    addAnomaly: vi.fn(async (input: Record<string, unknown>) => {
      anomalies.push(input);
    }),
    getRequestObserver: vi.fn(() => null),
  };
}

export function fanslyLaneInput(input: {
  pageId: number;
  label: string;
  accountRef: string;
  egressKey: string;
  syncRunId: number;
  now: Date;
  telemetry: ReturnType<typeof fanslyLaneTelemetryStub>;
  budget?: SyncChunkBudget;
}) {
  return {
    budget: input.budget ?? new SyncChunkBudget(),
    pageContext: {
      platform: "fansly",
      page: {
        id: input.pageId,
        label: input.label,
        platformAccountId: input.accountRef,
        metadata: {},
      },
      session: { authorization: "token" },
      proxy: { url: "socks5://proxy.example:1080" },
      egressKey: input.egressKey,
    },
    telemetry: input.telemetry,
    streamState: { requestSeq: 1 },
    syncRunId: input.syncRunId,
    now: input.now,
  };
}

/** Model physical retries the same way the adapter does: clip them to the
 * durable allowance and fail the logical request if its successful attempt
 * would have crossed the cap. */
export async function observeFanslyLaneAttempts(
  context: {
    requestObserver?: { onRequestEvent: (event: unknown) => Promise<void> } | null;
    remainingAttempts?: (() => number) | null;
  },
  input: {
    attempts: number;
    operation: string;
    endpointTemplate: string;
    requestId: string;
    onAttempt?: () => void;
  },
) {
  const permitted = Math.min(
    input.attempts,
    Math.max(0, context.remainingAttempts?.() ?? input.attempts),
  );
  for (let attempt = 1; attempt <= permitted; attempt += 1) {
    input.onAttempt?.();
    await context.requestObserver?.onRequestEvent({
      requestId: input.requestId,
      state: "started",
      operation: input.operation,
      endpointTemplate: input.endpointTemplate,
      method: "GET",
      attemptNumber: attempt,
    });
  }
  if (permitted < input.attempts) {
    throw new FanslyApiError("retry allowance exhausted", 503);
  }
}
