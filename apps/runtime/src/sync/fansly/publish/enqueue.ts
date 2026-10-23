import {
  getFanslyWriteDispatch,
  getPagePublishingSettings,
  getSyncPageTransport,
  insertFanslyWriteCommand,
  setFanslyWriteCommandWork,
  upsertDemand,
  type Database,
  type FanslyWriteCommandRecord,
  type FanslyWritePriority,
  type FanslyWriteStep,
} from "@agency_hub_core/db";
import { isFanslyWriteSendable } from "@agency_hub_core/fansly";
import type { AppConfig } from "@agency_hub_core/shared";

import { FANSLY_WRITE_STEP_ROUTES } from "./commands.ts";
import { writeGuard } from "./guard.ts";

// The only way a Fansly write command comes to be (wall posts PR 6): its
// producer — the publications sender of PR 9 — calls this for one step of a
// dispatch it holds. Nothing calls it yet. It refuses before anything is
// written unless every switch is on and the route can be sent at all (the
// same guard the engine's plan and admission pass again before the send):
// the global `publishingEnabled`, the page's own publishing, a page on its
// browser, and a route the stand verified — none is, until session 0.2.

/** The registry key a command of `priority` runs under. */
export function fanslyWriteResource(priority: FanslyWritePriority): "publish.background" | "publish.urgent" {
  return priority === "urgent" ? "publish.urgent" : "publish.background";
}

export class FanslyWriteRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`A Fansly write command is not queued: ${reason}`);
    this.name = "FanslyWriteRefusedError";
  }
}

export interface EnqueueFanslyWriteInput {
  dispatchId: number;
  step: FanslyWriteStep;
  /** `media:<position>`, `preview:<position>`, or '' for the publication. */
  item: string;
  /** `urgent` only for a story in its window (spec §3.5). */
  priority: FanslyWritePriority;
  notBefore: Date;
  notAfter: Date | null;
  /** The live effective config (`loadEffectiveConfig`). */
  config: Pick<AppConfig, "publishingEnabled">;
  now?: Date;
}

/**
 * Queue one request of a Fansly dispatch and the work row its page's actor
 * runs it under, in one transaction. Null: that step of the dispatch is
 * queued, sent or settled already (never twice). Throws
 * `FanslyWriteRefusedError` when a guard says no; nothing is written then.
 */
export async function enqueueFanslyWriteCommand(db: Database, input: EnqueueFanslyWriteInput): Promise<FanslyWriteCommandRecord | null> {
  const now = input.now ?? new Date();
  const dispatch = await getFanslyWriteDispatch(db, input.dispatchId);
  if (dispatch === null || dispatch.platform !== "fansly") throw new FanslyWriteRefusedError("dispatch_not_fansly");
  const [page, transport] = await Promise.all([
    getPagePublishingSettings(db, dispatch.pageId),
    getSyncPageTransport(db, dispatch.pageId),
  ]);
  const verdict = writeGuard({
    step: input.step,
    now,
    notBefore: input.notBefore,
    notAfter: input.notAfter,
    publishingEnabled: input.config.publishingEnabled === true,
    page: { enabled: page.enabled, autostopReason: page.autostopReason },
    transport: transport ?? "node",
    // Whether the browser takes writes is the actor's to see at the plan.
    transportWrites: true,
    contractVerified: isFanslyWriteSendable(FANSLY_WRITE_STEP_ROUTES[input.step]),
  });
  if (verdict.kind === "refuse") throw new FanslyWriteRefusedError(verdict.reason);
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    const command = await insertFanslyWriteCommand(tx, {
      dispatchId: input.dispatchId,
      step: input.step,
      item: input.item,
      priority: input.priority,
      notBefore: input.notBefore,
      notAfter: input.notAfter,
    });
    if (command === null) return null;
    const urgent = input.priority === "urgent";
    const work = await upsertDemand(tx, {
      pageId: command.pageId,
      resource: fanslyWriteResource(input.priority),
      subject: String(command.id),
      kind: "goal",
      class: urgent ? "urgent" : "planned",
      dueAt: input.notBefore,
      // A story's result is due by the end of its window: the urgent class
      // serves the nearest deadline first.
      deadlineAt: urgent ? input.notAfter : null,
      demand: { reasons: [`publication:${command.publicationId}:${command.step}`] },
      createOnly: true,
    });
    await setFanslyWriteCommandWork(tx, { id: command.id, workId: work.id });
    return { ...command, workId: work.id };
  });
}
