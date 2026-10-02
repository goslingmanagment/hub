import { NOT_IMPLEMENTED_RECHECK_MS, type ResourceModule } from "../../engine/resource.ts";

// `dm-live.deletions` (design §5.5, §6.3 step 4, D24): the socket said a
// message was deleted. The overlay's sticky mark is already written by the
// step-1 apply in the transaction that acked the frame; this work carries the
// deletion to the hot table and the archive (`markFanslyWsHotDeletion`, a
// deliverable `message.deleted`, the archive tombstone) WITHOUT a request,
// a few seconds after the ack — outside the ack transaction so the lock order
// holds (hot tables before `domain_event_seq`).
//
// Shadow (step 2): the router creates the work from real deletion frames so
// the shadow report sees the demand, and the step closes at once — a shadow
// page never writes a hot table, the archive or an event (I14).
//
// Live: the writes land with the socket's live ownership (S3-03, §12.2); until
// then a live page's deletion work waits on that dependency. No build of step 2
// runs a live loop (I17), so nothing waits in practice.

export const dmLiveDeletionsModule: ResourceModule = {
  async plan(_work, ctx) {
    if (ctx.shadow) return { kind: "done", reason: "shadow_no_writes" };
    return { kind: "wait", reason: "dependency", until: new Date(ctx.now.getTime() + NOT_IMPLEMENTED_RECHECK_MS) };
  },
  async apply() {
    throw new Error("dm-live.deletions makes no request: there is no answer to apply");
  },
  async shadow() {
    throw new Error("dm-live.deletions makes no request: there is no step to estimate");
  },
};
