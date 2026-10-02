import {
  getSyncPage,
  importClosedWorkBreaker,
  importWorkCursor,
  listUnconfirmedOverlayChats,
  markPageThreadsUnverified,
  markSyncPageLegacyImported,
  readActiveLegacyProviderHold,
  readLegacyAuthBlocker,
  setPageHold,
  supersedeShadowWork,
  upsertDemands,
  type Database,
  type SyncPageRow,
  type SyncSwitchCapability,
  type UpsertDemandInput,
} from "@agency_hub_core/db";

import { readFanslyPageGeneration } from "../../services/egress/fansly-probe-context.ts";
import { demandToUpsert, type DemandSignal, type EngineRegistry, type ResourceModule } from "../engine/resource.ts";
import { readSwitchStartedAt } from "./audit.ts";
import type { SwitchContext } from "./context.ts";

// Switch phase I (design step 3 §3.5 item 7, E5): the legacy state the
// engine's live work starts from, imported in `handover` after the legacy
// engine is confirmed stopped (B) and before any engine send. Each step is its
// own transaction and idempotent; `legacy_imported_at` is written last, so an
// interrupted import is simply run again — and the host starts no live loop
// without it (J3). Read-only towards the legacy tables (J5).

export interface LegacyImportReport {
  supersededShadowWork: number;
  /** Per module: the keys it seeded and where their values came from. */
  modules: Array<{ resources: string[]; notes: Readonly<Record<string, unknown>> }>;
  breakers: number;
  demands: number;
  /** I.3b: chats with an unconfirmed overlay row from before the switch. */
  unconfirmedOverlayChats: number;
  holds: { rateLimitUntil: string | null; auth: boolean };
  threadsMarkedUnverified: number;
  takeoverVerify: boolean;
}

async function inTx<T>(db: Database, body: (tx: Database) => Promise<T>): Promise<T> {
  return db.transaction(async (raw) => body(raw as unknown as Database));
}

/** Demand signals → upserts of the page's live journal (unknown or
 *  switched-off keys are dropped, as for every follow-up). */
function upsertsOf(registry: EngineRegistry, page: SyncPageRow, signals: readonly DemandSignal[], now: Date): UpsertDemandInput[] {
  const upserts: UpsertDemandInput[] = [];
  for (const signal of signals) {
    const spec = registry.spec(signal.resource);
    if (spec === null) continue;
    const upsert = demandToUpsert(signal, spec, { pageId: page.pageId, shadow: false, now, page });
    if (upsert !== null) upserts.push(upsert);
  }
  return upserts;
}

/** Every module with an `importLegacy`, once (several keys may share one). */
async function importingModules(registry: EngineRegistry): Promise<ResourceModule[]> {
  const modules: ResourceModule[] = [];
  const seen = new Set<ResourceModule>();
  for (const spec of registry.specs) {
    if (spec.module === undefined) continue;
    const module = await registry.module(spec.key);
    if (module.importLegacy === undefined || seen.has(module)) continue;
    seen.add(module);
    modules.push(module);
  }
  return modules;
}

/**
 * Import the legacy state of a page in `handover` (steps 1–7 of design
 * §3.5 item 7, phase I). Throws when the page is not in `handover`.
 */
export async function importLegacyState(
  ctx: SwitchContext,
  input: { pageId: number; registry: EngineRegistry; capability: SyncSwitchCapability },
): Promise<LegacyImportReport> {
  const { db } = ctx;
  const page = await getSyncPage(db, input.pageId);
  if (page === null || page.mode !== "handover") {
    throw new Error(`the legacy import runs in handover (page ${input.pageId} is ${page?.mode ?? "missing"})`);
  }
  const now = page.dbNow;
  const report: LegacyImportReport = {
    supersededShadowWork: 0,
    modules: [],
    breakers: 0,
    demands: 0,
    unconfirmedOverlayChats: 0,
    holds: { rateLimitUntil: null, auth: false },
    threadsMarkedUnverified: 0,
    takeoverVerify: false,
  };

  // 1. The shadow journal ends.
  report.supersededShadowWork = await supersedeShadowWork(db, { pageId: page.pageId });

  // 2./3. Every module's legacy state: cursors, carried breakers, demand.
  const switchStartedAt = await readSwitchStartedAt(db, page.pageId);
  for (const module of await importingModules(input.registry)) {
    await inTx(db, async (tx) => {
      const imported = await module.importLegacy!(tx, { pageId: page.pageId, switchStartedAt });
      const resources: string[] = [];
      for (const cursor of imported.cursors) {
        const spec = input.registry.spec(cursor.resource);
        if (spec === null) continue;
        await importWorkCursor(tx, {
          pageId: page.pageId,
          resource: cursor.resource,
          subject: cursor.subject,
          kind: spec.kind,
          class: spec.class,
          cursor: cursor.cursor,
          ...(cursor.dueAt === undefined ? {} : { dueAt: cursor.dueAt }),
        });
        resources.push(cursor.resource);
      }
      for (const breaker of imported.breakers ?? []) {
        const spec = input.registry.spec(breaker.resource);
        if (spec === null) continue;
        if (await importClosedWorkBreaker(tx, { pageId: page.pageId, ...breaker, kind: spec.kind, class: spec.class })) {
          report.breakers += 1;
        }
      }
      const demands = upsertsOf(input.registry, page, imported.demands ?? [], now);
      if (demands.length > 0) await upsertDemands(tx, demands);
      report.demands += demands.length;
      report.modules.push({ resources: [...new Set(resources)].sort(), notes: imported.notes });
    });
  }

  // 3b. Confirmations the legacy engine owed (G22): one urgent head read per
  // chat with an unconfirmed overlay row of the last 24 h.
  await inTx(db, async (tx) => {
    const chats = await listUnconfirmedOverlayChats(tx, { pageId: page.pageId });
    const upserts = upsertsOf(input.registry, page, chats.map((chat) => ({
      resource: "dm-messages.head",
      subject: chat.groupId,
      demand: { messageIds: chat.messageIds, reason: "takeover_unconfirmed" },
    })), now);
    if (upserts.length > 0) await upsertDemands(tx, upserts);
    report.unconfirmedOverlayChats = chats.length;
  });

  // 4. Holds: a legacy 429 hold in force becomes the page's rate_limit hold
  // (same end); a legacy auth block an auth hold keyed on the stored
  // credentials that failed — it lifts when the owner's identity-checked
  // credentials change them, never on a takeover verify of the same session.
  await inTx(db, async (tx) => {
    const providerHold = await readActiveLegacyProviderHold(tx, page.pageId);
    if (providerHold !== null) {
      await setPageHold(tx, {
        pageId: page.pageId,
        kind: "rate_limit",
        until: providerHold.holdUntil,
        step: page.holdStep,
        detail: { importedFrom: "page_sync_provider_holds", reason: providerHold.reason, stream: providerHold.stream },
      });
      report.holds.rateLimitUntil = providerHold.holdUntil.toISOString();
    }
    const authBlocker = await readLegacyAuthBlocker(tx, page.pageId);
    if (authBlocker !== null && page.pageLabel !== null) {
      const failed = await readFanslyPageGeneration(tx, page.pageLabel).catch(() => null);
      await setPageHold(tx, {
        pageId: page.pageId,
        kind: "auth",
        until: "infinity",
        step: page.holdStep,
        detail: { importedFrom: "page_sync_states.blocker_kind", streams: authBlocker.streams, credentialsGeneration: failed },
      });
      report.holds.auth = true;
    }
  });

  // 5. The 0231 marking for the page.
  report.threadsMarkedUnverified = await markPageThreadsUnverified(db, page.pageId);

  // 6. The new owner's first request proves the session (G1).
  await inTx(db, async (tx) => {
    const upserts = upsertsOf(input.registry, page, [{ resource: "account.verify", demand: { reason: "takeover" } }], now);
    if (upserts.length > 0) await upsertDemands(tx, upserts);
    report.takeoverVerify = upserts.length > 0;
  });

  // 7. Done: the host may start the live loop.
  if (!(await markSyncPageLegacyImported(db, { pageId: page.pageId, capability: input.capability }))) {
    throw new Error(`page ${page.pageLabel ?? page.pageId} left handover during the legacy import`);
  }
  return report;
}
