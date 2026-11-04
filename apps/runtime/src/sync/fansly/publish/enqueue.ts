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
import { isFanslyWriteSendable, type FanslyWireId } from "@agency_hub_core/fansly";
import type { AppConfig } from "@agency_hub_core/shared";

import { fanslyStepSendable } from "./commands.ts";
import { writeGuard } from "./guard.ts";

// The only way a Fansly write command comes to be (wall posts PR 6): its
// producer — the publications sender (services/publications-fansly.ts, PR 9)
// — calls this for one step of a dispatch it holds. It refuses before anything is
// written unless every switch is on and the route can be sent at all (the
// same guard the engine's plan and admission pass again before the send):
// the global `publishingEnabled`, the page's own publishing, a page on its
// browser, and a route the stand verified — none is, until session 0.2.

/** The registry key a command of `priority` runs under: an upload's part its
 *  own (0347) — a PUT to the storage, not Fansly: the page's storage lane
 *  sends a few at once outside its pause where its browser takes them
 *  (engine/part-lane.ts), else its turn as any write. */
export function fanslyWriteResource(priority: FanslyWritePriority, step?: FanslyWriteStep): "publish.background" | "publish.urgent" | "publish.part" {
  if (step === "upload_part") return "publish.part";
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
  /** Whether a route's contract is verified: `isFanslyWriteSendable` (the
   *  one list, `FANSLY_VERIFIED_WRITE_ROUTES`); integration tests pass their own. */
  isSendable?: (spec: FanslyWireId) => boolean;
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
  // No engine row: no actor of the page would ever run the command.
  if (transport === null) throw new FanslyWriteRefusedError("no_sync_page");
  const verdict = writeGuard({
    step: input.step,
    now,
    notBefore: input.notBefore,
    notAfter: input.notAfter,
    publishingEnabled: input.config.publishingEnabled === true,
    page: { enabled: page.enabled, autostopReason: page.autostopReason },
    // Whether the browser takes writes is the actor's to see at the plan.
    transportWrites: true,
    contractVerified: fanslyStepSendable(input.step, input.isSendable ?? isFanslyWriteSendable),
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
    const resource = fanslyWriteResource(input.priority, input.step);
    const urgent = resource === "publish.urgent";
    const work = await upsertDemand(tx, {
      pageId: command.pageId,
      resource,
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
