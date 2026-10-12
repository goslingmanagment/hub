// Control of a started Chrome (plan §4.1, step 4), one flatten session per
// target through the holder:
// - Fetch.enable on the browser target with the pattern `*` at the request
//   stage: every loader of every tab, frame, worker and service worker stops
//   (cdp/paused.ts decides);
// - Target.setAutoAttach (autoAttach, waitForDebuggerOnStart, flatten) on
//   the browser target and then in every tab and worker: a new target stays
//   paused until it is set up here and Runtime.runIfWaitingForDebugger lets
//   it run;
// - in every tab and worker Network.enable (Chrome's body buffers of plan
//   §4.14), in every tab Page.enable.
// The work tab is opened only after Fetch.enable: a tab Chrome started with
// had its loaders before the interception existed and is not intercepted
// (stage 1, amendment 1), so it is closed.
//
// Later PRs add their steps to the same setup (the socket guard, PR 10; the
// page's environment, PR 5). A web target whose setup fails is never let run.

import { CdpError, CdpUnanswered, type Cdp, type CdpEvent } from "./client.ts";
import { errorMessage, makeLog, sleep, type Logger } from "../shared/util.ts";

export interface TargetInfo {
  sessionId: string;
  targetId: string;
  type: string;
  url: string;
  /** The session that auto-attached it; null for the browser target's. */
  parentSessionId: string | null;
  mainFrameId: string | null;
  /** Isolated worlds of the main frame's current document, by name. */
  worlds: Map<string, number>;
  /** Settles when the target was set up (true) or not (false). */
  setup: Promise<boolean>;
}

export interface ControlOptions {
  /** Chrome's buffers for response bodies (plan §4.14). */
  networkBuffer: { totalBytes: number; perResponseBytes: number };
  /** A web target could not be set up (and stays paused). */
  onSetupFailed: (target: TargetInfo, error: Error) => void;
  log?: Logger;
}

/** Targets of Chrome's own UI and of extensions are only let run. */
function isWebTarget(target: TargetInfo): boolean {
  return target.url === "" || /^(https?:|about:|blob:|data:)/.test(target.url);
}

const PAGE_TYPES = new Set(["page", "iframe"]);
const WORKER_TYPES = new Set(["worker", "shared_worker", "service_worker"]);

/** The command failed because its target, or CDP itself, is gone. */
export function targetGone(error: unknown): boolean {
  if (error instanceof CdpUnanswered) return true;
  return error instanceof CdpError && /session with given id not found|target closed|no target with given id|not attached to an active page/i.test(error.message);
}

export class BrowserControl {
  readonly #cdp: Cdp;
  readonly #options: ControlOptions;
  readonly #log: Logger;
  readonly #targets = new Map<string, TargetInfo>();
  #workTab: TargetInfo | null = null;
  /** Chrome's body buffers for the next targets (the engine's params). */
  networkBuffer: { totalBytes: number; perResponseBytes: number };

  constructor(cdp: Cdp, options: ControlOptions) {
    this.#cdp = cdp;
    this.#options = options;
    this.networkBuffer = options.networkBuffer;
    this.#log = options.log ?? makeLog("control");
    cdp.on("Target.attachedToTarget", (event) => this.#onAttached(event));
    cdp.on("Target.detachedFromTarget", (event) => this.#onDetached(event));
    cdp.on("Page.frameNavigated", (event) => this.#onFrameNavigated(event));
  }

  get workTab(): TargetInfo | null {
    return this.#workTab;
  }

  get targets(): TargetInfo[] {
    return [...this.#targets.values()];
  }

  /** A new Chrome (or none): its targets are another browser's. */
  reset(): void {
    this.#targets.clear();
    this.#workTab = null;
  }

  /** Interception and auto-attach on the browser target, then the work tab:
   *  a fresh about:blank opened after Fetch.enable; the others are closed. */
  async attach(timeoutMs = 5000): Promise<TargetInfo> {
    await this.#cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    await this.#cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const created = await this.#cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const deadline = Date.now() + timeoutMs;
    let tab: TargetInfo | undefined;
    while (!(tab = this.targets.find((target) => target.targetId === created.targetId)) && Date.now() < deadline) await sleep(20);
    if (!tab) throw new Error("the work tab was not attached");
    const ready = await Promise.race([tab.setup, sleep(Math.max(0, deadline - Date.now())).then(() => false)]);
    if (!ready) throw new Error("the work tab was not set up");
    this.#workTab = tab;
    for (const other of this.targets) {
      if (other !== tab && other.type === "page" && other.parentSessionId === null) {
        await this.#cdp.send("Target.closeTarget", { targetId: other.targetId }).catch((error: unknown) => this.#log("close_tab.failed", { error: errorMessage(error) }));
      }
    }
    return tab;
  }

  /** An isolated world in the main frame of `tab` (plan §4.2, step 3): the
   *  same tab for the network, a JS realm the site's code never sees. It
   *  dies with the document (Page.frameNavigated drops it). */
  async isolatedWorld(tab: TargetInfo, name: string): Promise<number> {
    const known = tab.worlds.get(name);
    if (known !== undefined) return known;
    if (tab.mainFrameId === null) {
      const tree = await this.#cdp.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree", {}, tab.sessionId);
      tab.mainFrameId = tree.frameTree.frame.id;
    }
    const world = await this.#cdp.send<{ executionContextId: number }>(
      "Page.createIsolatedWorld",
      { frameId: tab.mainFrameId, worldName: name, grantUniveralAccess: false },
      tab.sessionId,
    );
    tab.worlds.set(name, world.executionContextId);
    return world.executionContextId;
  }

  /** "Chrome/155.0.8059.39" */
  async version(): Promise<string> {
    const version = await this.#cdp.send<{ product?: string }>("Browser.getVersion");
    return String(version.product ?? "");
  }

  #onAttached(event: CdpEvent): void {
    // A previous instance's: the operator restarts that browser anyway.
    if (event.replayed) return;
    const params = event.params as { sessionId: string; targetInfo: { targetId: string; type: string; url: string }; waitingForDebugger: boolean };
    let settle: (ok: boolean) => void = () => undefined;
    const target: TargetInfo = {
      sessionId: params.sessionId,
      targetId: params.targetInfo.targetId,
      type: params.targetInfo.type,
      url: params.targetInfo.url,
      parentSessionId: event.sessionId ?? null,
      mainFrameId: null,
      worlds: new Map(),
      setup: new Promise<boolean>((resolve) => (settle = resolve)),
    };
    this.#targets.set(target.sessionId, target);
    this.#log("target.attached", { type: target.type, url: target.url.split("?")[0], waiting: params.waitingForDebugger, nested: target.parentSessionId !== null });
    void this.#setUp(target, params.waitingForDebugger).then(settle);
  }

  async #setUp(target: TargetInfo, waiting: boolean): Promise<boolean> {
    const session = target.sessionId;
    const web = isWebTarget(target);
    const page = web && PAGE_TYPES.has(target.type);
    const worker = web && WORKER_TYPES.has(target.type);
    try {
      if (page || worker) {
        const { totalBytes, perResponseBytes } = this.networkBuffer;
        await this.#cdp.send("Network.enable", { maxTotalBufferSize: totalBytes, maxResourceBufferSize: perResponseBytes }, session);
      }
      if (page) await this.#cdp.send("Page.enable", {}, session);
      if (page || worker) {
        // Service workers are attached once, by the browser target: a second
        // session to the same worker (from a page) deadlocks its start
        // (stage 1, FINDINGS 6).
        await this.#cdp.send(
          "Target.setAutoAttach",
          { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "service_worker", exclude: true }, {}] },
          session,
        );
      }
    } catch (error) {
      if (targetGone(error)) return false;
      this.#log("target.setup_failed", { type: target.type, error: errorMessage(error) });
      if (page || worker) {
        // Never let it run without its control in place.
        this.#options.onSetupFailed(target, error as Error);
        return false;
      }
    }
    if (waiting) {
      try {
        await this.#cdp.send("Runtime.runIfWaitingForDebugger", {}, session);
      } catch (error) {
        if (!targetGone(error)) this.#log("target.resume_failed", { type: target.type, error: errorMessage(error) });
        return false;
      }
    }
    return true;
  }

  #onDetached(event: CdpEvent): void {
    const sessionId = (event.params as { sessionId?: string }).sessionId;
    if (sessionId === undefined) return;
    this.#targets.delete(sessionId);
    if (this.#workTab?.sessionId === sessionId) {
      this.#log("work_tab.detached");
      this.#workTab = null;
    }
  }

  #onFrameNavigated(event: CdpEvent): void {
    const frame = (event.params as { frame?: { id: string; parentId?: string; url: string } }).frame;
    const target = event.sessionId ? this.#targets.get(event.sessionId) : undefined;
    if (!frame || !target || frame.parentId) return;
    target.mainFrameId = frame.id;
    target.url = frame.url;
    // The isolated worlds died with the document.
    target.worlds.clear();
  }
}
