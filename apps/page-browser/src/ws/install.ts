// The socket guard into every context the site can open a socket from (plan
// §4.1, step 4; §4.3), before any script of the site runs there. It is part
// of each web target's setup (cdp/control.ts, `targetSetup`): a target whose
// setup failed is never let run.
//
// - Every tab and frame (out-of-process frames are targets of their own):
//   Runtime.enable — without it V8 puts no binding into new contexts (stage
//   1, amendment 4) — the binding the guard reports through, and the guard
//   by Page.addScriptToEvaluateOnNewDocument with runImmediately: it runs in
//   every new document of the target, a fresh about:blank or sandboxed frame
//   included (`ws-blank-iframe`), and in the one there now.
// - Every dedicated, shared and service worker: a worker waiting for the
//   debugger has no context yet, and Runtime.evaluate there never returns
//   (amendment 5). So the debugger stops it before its first script
//   (Debugger.setInstrumentationBreakpoint, beforeScriptExecution); the guard
//   is evaluated on that frame, then the debugger goes (Debugger.disable
//   resumes the worker and leaves no pause on the site's own `debugger;`).
// - A service worker Chrome stops and starts again stays in the same CDP
//   session (Inspector.targetCrashed → targetReloadedAfterCrash, no new
//   attach): its debugger and breakpoint live as long as the session, and
//   the guard goes in again at the first pause after every start (FINDINGS
//   15, `ws-sw-restart`). Other pauses there are let go at once.
// - A worker that already runs when it is attached (none should: the site
//   loads after the control is in place) gets the guard at once, in its
//   context, and the breakpoint for anything it starts later.
//
// A guard that cannot go in — the evaluation throws, the command fails on a
// live target — stops the page (`onFailed`). The guard's own reports come
// back as Runtime.bindingCalled with the binding's name and go to `onReport`
// read as untrusted text.

import { CdpError, type CdpEvent, type CdpPort } from "../cdp/client.ts";
import { targetGone } from "../cdp/control.ts";
import { errorMessage, makeLog, urlForLogLine, type Logger } from "../shared/util.ts";
import { parseGuardReport, type GuardReport } from "./guard.ts";

export type GuardContextKind = "page" | "worker";

/** The target a report came from. */
export interface GuardTarget {
  sessionId: string | null;
  type: string;
}

export interface InstallerDeps {
  cdp: CdpPort;
  /** The binding's name and the guard's expression (ws/guard.ts). */
  binding: string;
  expression: string;
  onReport: (report: GuardReport, target: GuardTarget) => void;
  /** The guard did not go into a live target: the page must stop. */
  onFailed: (target: GuardTarget, why: string) => void;
  log?: Logger;
}

interface Worker {
  sessionId: string;
  type: string;
  url: string;
  breakpointId: string;
  /** The next pause before a script is the first of a (re)started worker. */
  needsGuard: boolean;
  /** A service worker: the debugger stays for the session's life. */
  persistent: boolean;
}

export class GuardInstaller {
  readonly #deps: InstallerDeps;
  readonly #log: Logger;
  readonly #workers = new Map<string, Worker>();
  /** Types of the targets set up, by session (for reports). */
  readonly #types = new Map<string, string>();
  #installed = 0;

  constructor(deps: InstallerDeps) {
    this.#deps = deps;
    this.#log = deps.log ?? makeLog("ws-guard");
    const cdp = deps.cdp;
    cdp.on("Debugger.paused", (event) => this.#onPaused(event));
    cdp.on("Inspector.targetCrashed", (event) => this.#onWorkerStopped(event));
    cdp.on("Inspector.targetReloadedAfterCrash", (event) => this.#onWorkerRestarted(event));
    cdp.on("Target.detachedFromTarget", (event) => this.#forget((event.params as { sessionId?: string }).sessionId));
    cdp.on("Runtime.bindingCalled", (event) => this.#onBinding(event));
  }

  /** Contexts that said the guard is in (diagnostics, tests). */
  get installed(): number {
    return this.#installed;
  }

  /** A new Chrome: its targets are another browser's. */
  reset(): void {
    this.#workers.clear();
    this.#types.clear();
  }

  /** The guard's part of a web target's setup, before it may run. Throws
   *  when it could not be put in place (the target never runs then). */
  async setUp(target: { sessionId: string; type: string; url: string }, kind: GuardContextKind, waiting: boolean): Promise<void> {
    const cdp = this.#deps.cdp;
    const session = target.sessionId;
    this.#types.set(session, target.type);
    await cdp.send("Runtime.enable", {}, session);
    await cdp.send("Runtime.addBinding", { name: this.#deps.binding }, session);
    if (kind === "page") {
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: this.#deps.expression, runImmediately: true }, session);
      return;
    }
    await cdp.send("Debugger.enable", {}, session);
    const breakpoint = await cdp.send<{ breakpointId?: string }>("Debugger.setInstrumentationBreakpoint", { instrumentation: "beforeScriptExecution" }, session);
    const worker: Worker = {
      sessionId: session,
      type: target.type,
      url: target.url,
      breakpointId: String(breakpoint.breakpointId ?? ""),
      needsGuard: true,
      persistent: target.type === "service_worker",
    };
    this.#workers.set(session, worker);
    if (!waiting) {
      // Already running: its context is there, the guard goes in now.
      worker.needsGuard = false;
      this.#log("guard.late_worker", { type: worker.type, url: urlForLogLine(worker.url) });
      const result = await cdp.send<{ exceptionDetails?: unknown }>("Runtime.evaluate", { expression: this.#deps.expression, silent: true }, session);
      if (result.exceptionDetails) throw new Error("the socket guard threw in a running worker");
    }
  }

  #forget(sessionId: string | undefined): void {
    if (sessionId === undefined) return;
    this.#workers.delete(sessionId);
    this.#types.delete(sessionId);
  }

  #onPaused(event: CdpEvent): void {
    const session = event.sessionId;
    if (session === undefined) return;
    const worker = this.#workers.get(session);
    const cdp = this.#deps.cdp;
    if (!worker || !worker.needsGuard) {
      // A later script of a service worker, or the site's own `debugger;`.
      void cdp.send("Debugger.resume", {}, session).catch(() => undefined);
      return;
    }
    worker.needsGuard = false;
    const frame = (event.params as { callFrames?: Array<{ callFrameId?: string }> }).callFrames?.[0];
    void (async () => {
      try {
        const result =
          typeof frame?.callFrameId === "string"
            ? await cdp.send<{ exceptionDetails?: unknown }>("Debugger.evaluateOnCallFrame", { callFrameId: frame.callFrameId, expression: this.#deps.expression, silent: true }, session)
            : await cdp.send<{ exceptionDetails?: unknown }>("Runtime.evaluate", { expression: this.#deps.expression, silent: true }, session);
        if (result.exceptionDetails) throw new Error("the socket guard threw");
      } catch (error) {
        // The worker stays paused before its first script; the page stops
        // (unless the worker, or CDP, is gone already).
        if (targetGone(error)) return;
        this.#log("guard.worker_failed", { type: worker.type, error: errorMessage(error) });
        this.#deps.onFailed({ sessionId: session, type: worker.type }, `the socket guard did not go into a ${worker.type}: ${errorMessage(error)}`);
        return;
      }
      try {
        if (worker.persistent) {
          // The breakpoint stays for the worker's next start.
          await cdp.send("Debugger.resume", {}, session);
        } else {
          // Disabling the debugger resumes the worker and drops the breakpoint.
          this.#workers.delete(session);
          await cdp.send("Debugger.disable", {}, session);
        }
      } catch (error) {
        if (!targetGone(error) && error instanceof CdpError) this.#log("guard.resume_failed", { type: worker.type, error: errorMessage(error) });
      }
    })();
  }

  /** A service worker Chrome stopped: its next start needs the guard. */
  #onWorkerStopped(event: CdpEvent): void {
    const worker = event.sessionId === undefined ? undefined : this.#workers.get(event.sessionId);
    if (worker?.persistent) worker.needsGuard = true;
  }

  /** ...and started again, in the same session: the breakpoint stops it
   *  before its first script, the guard goes in there. */
  #onWorkerRestarted(event: CdpEvent): void {
    const session = event.sessionId;
    const worker = session === undefined ? undefined : this.#workers.get(session);
    if (!worker?.persistent || session === undefined) return;
    worker.needsGuard = true;
    this.#log("guard.worker_restarted", { type: worker.type, url: urlForLogLine(worker.url) });
    void this.#deps.cdp.send("Runtime.runIfWaitingForDebugger", {}, session).catch(() => undefined);
  }

  #onBinding(event: CdpEvent): void {
    const params = event.params as { name?: unknown; payload?: unknown };
    if (params.name !== this.#deps.binding || typeof params.payload !== "string") return;
    const report = parseGuardReport(params.payload);
    if (report === null) {
      this.#log("guard.bad_report", { bytes: params.payload.length });
      return;
    }
    if (report.k === "installed") this.#installed += 1;
    const session = event.sessionId ?? null;
    this.#deps.onReport(report, { sessionId: session, type: session === null ? "browser" : (this.#types.get(session) ?? "unknown") });
  }
}
