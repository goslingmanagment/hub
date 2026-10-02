import type { OutcomeDecision } from "../../engine/errors.ts";
import type { WsSourceState } from "../../engine/ports.ts";
import type {
  AnswerApplyInput,
  ApplyResult,
  PlanContext,
  RequestPlan,
  ResourceModule,
  ShadowResult,
  StepPlan,
} from "../../engine/resource.ts";

// `ws.connect` (live only, step 3; design S3-04 item 4, §5.2): the page's
// WebSocket Upgrade as an admitted request of the page. The page's socket
// owner (S3-03's `FanslyWsSource`, in the `sync` process) asks for it — at
// start, and after every close with the reconnect ladder's due time — and the
// actor admits it through the pacer like any request: the Upgrade's headers
// are written only when the admission's send check passes (I1–I3), and one
// admission is one Upgrade. The frames that follow are not requests.
//
// - plan: an Upgrade only when the owner holds the socket lock and has no
//   socket (`owning`, `down`), and never before the owner's reconnect ladder
//   allows (`connectNotBefore`: the row may be due sooner — a refused
//   admission reopens it at once); an open socket satisfies the work;
//   otherwise (connecting, the session refused at the auth frame, no owner in
//   this process) it waits on `dependency` — the owner raises demand again.
// - apply: the 101 closes the work; the connection row
//   (`fansly_ws_connections`) is the record.
// - outcome: a 401/403 at the handshake is the page's `auth` hold and a 429
//   (or a 5xx naming its `Retry-After`) the page's `rate_limit` hold with
//   alert 1 — plan §9 names the socket connection among the held requests, so
//   neither goes to the reconnect ladder. Any other status, a transport error
//   or a timeout failed the handshake only: the work closes
//   `failed_handshake` and the socket owner schedules the next attempt on its
//   ladder — no page network streak, no subject or resource breaker (a
//   WS-host outage must not hold the page's REST work).

export const WS_CONNECT_KEY = "ws.connect";

/** A connecting owner is looked at again this soon. */
export const WS_CONNECT_RECHECK_MS = 5_000;
/** No owner, or one that cannot connect now: looked at again this often (the
 *  owner raises demand itself when it can). */
export const WS_CONNECT_IDLE_RECHECK_MS = 60_000;

export const WS_UPGRADE_REQUEST: RequestPlan<"ws.upgrade"> = { spec: "ws.upgrade", params: {} };

/** The step for the owner's state and its ladder's instant (pure). */
export function wsConnectPlan(state: WsSourceState | null, now: Date, notBefore: Date | null = null): StepPlan {
  switch (state) {
    case "owning":
    case "down":
      if (notBefore !== null && notBefore.getTime() > now.getTime()) return { kind: "wait", reason: "not_due", until: notBefore };
      return { kind: "request", request: WS_UPGRADE_REQUEST };
    case "open":
      return { kind: "done", reason: "socket_open" };
    case "connecting":
    case "idle":
      return { kind: "wait", reason: "dependency", until: new Date(now.getTime() + WS_CONNECT_RECHECK_MS) };
    case "blocked_generation":
    case "stopped":
    case null:
      return { kind: "wait", reason: "dependency", until: new Date(now.getTime() + WS_CONNECT_IDLE_RECHECK_MS) };
  }
}

/** The error classes that are the handshake's own failure (the ladder's),
 *  never the page's: everything but a held page (auth, rate limit) and a
 *  success. */
const HANDSHAKE_FAILURES: ReadonlySet<string> = new Set([
  "network",
  "subject_failure",
  "subject_terminal",
  "envelope_unsuccessful",
  "contract",
  "cursor_stuck",
]);

/** The consequences of a handshake outcome (pure; `errors.onOutcome`'s
 *  decision for every other class stands). */
export function wsConnectOutcome(decision: OutcomeDecision): OutcomeDecision {
  if (!HANDSHAKE_FAILURES.has(decision.errorClass)) return decision;
  return {
    ...decision,
    pageHold: { action: "keep" },
    networkFailureStreak: null,
    subjectBreaker: null,
    resourceHold: { action: "keep" },
    quarantineAttempt: false,
    work: { action: "close", closeReason: "failed_handshake" },
    alerts: [],
  };
}

export const wsConnectModule: ResourceModule = {
  async plan(_work, ctx: PlanContext): Promise<StepPlan> {
    // Live only: a shadow page never owns a socket (I14).
    if (ctx.shadow) return { kind: "done", reason: "shadow_no_socket" };
    return wsConnectPlan(ctx.socket?.state ?? null, ctx.now, ctx.socket?.connectNotBefore ?? null);
  },

  async apply(): Promise<ApplyResult> {
    throw new Error("ws.connect journals nothing: its answer is applied from memory (applyAnswer)");
  },

  async applyAnswer(_tx, input: AnswerApplyInput): Promise<ApplyResult> {
    return {
      work: { satisfiesRevision: true, close: "done", closeReason: "socket_opened", result: { status: 101, at: input.now.toISOString() } },
      followups: [],
      counters: { upgrades: 1 },
    };
  },

  outcome: (decision) => wsConnectOutcome(decision),

  async shadow(): Promise<ShadowResult> {
    // Live only (the registry's `liveOnly`): a shadow page never runs it.
    return { work: { satisfiesRevision: true, close: "done", closeReason: "shadow" }, followups: [] };
  },
};
