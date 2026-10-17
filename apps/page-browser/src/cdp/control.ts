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
//   §4.14), in every tab Page.enable;
// - the page's position (plan §4.1, step 2; PR 5): before anything else may
//   run, the site's origin is granted geolocation (Browser.grantPermissions:
//   nobody would answer its prompt), and every tab and frame gets
//   Emulation.setGeolocationOverride before it runs. Workers have neither
//   the Emulation domain nor navigator.geolocation (Chrome 155 on the
//   image): nothing to set there.
// The work tab is opened only after Fetch.enable: a tab Chrome started with
// had its loaders before the interception existed and is not intercepted
// (stage 1, amendment 1), so it is closed.
//
// - the socket guard (PR 10; ws/install.ts, `targetSetup`): in every tab,
//   frame and worker, before it may run — Runtime.enable and the guard's
//   binding everywhere, the guard as a script of every new document in tabs
//   and frames, and a pause before the first script of every worker.
// A web target whose setup fails is never let run.

import { CdpError, CdpUnanswered, type Cdp, type CdpEvent } from "./client.ts";
import { FANSLY_HOSTS } from "../egress/hosts.ts";
import { CHECK_PATH } from "../env/check.ts";
import { PLACEHOLDER_SUFFIX } from "../hub-requests/page.ts";
import type { Geolocation } from "../env/rules.ts";
import { errorMessage, makeLog, sleep, urlForLogLine, type Logger } from "../shared/util.ts";

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
  /** More of a web target's setup (the socket guard), before auto-attach
   *  and before it may run; a throw fails the setup. */
  targetSetup?: (target: TargetInfo, kind: "page" | "worker", waiting: boolean) => Promise<void>;
  /** The origin the page's position is granted to (the site's). */
  siteOrigin?: string;
  log?: Logger;
}

export const SITE_ORIGIN = `https://${FANSLY_HOSTS.site[0]}`;

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

/** What stops in Fetch (variant Б): Hub's requests by their placeholder
 *  host (hub-requests/page.ts), the environment check's page
 *  (env/check.ts), the self-test's probes by their mark (selftest/probes.ts). */
export const FETCH_PATTERNS = [
  { urlPattern: `*://*${PLACEHOLDER_SUFFIX}/*`, requestStage: "Request" },
  { urlPattern: `http://127.0.0.1${CHECK_PATH}*`, requestStage: "Request" },
  { urlPattern: "*?pbst=*", requestStage: "Request" },
] as const;

export class BrowserControl {
  readonly #cdp: Cdp;
  readonly #options: ControlOptions;
  readonly #log: Logger;
  readonly #targets = new Map<string, TargetInfo>();
  #workTab: TargetInfo | null = null;
  /** Chrome's body buffers for the next targets (the engine's params). */
  networkBuffer: { totalBytes: number; perResponseBytes: number };
  /** The page's position for every tab and frame (its hello's env); a
   *  start sets it before attach(), and no tab runs without it. */
  geolocation: Geolocation | null = null;

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

  /** Interception, the site's geolocation grant and auto-attach on the
   *  browser target, then the work tab: a fresh about:blank opened after
   *  Fetch.enable; the others are closed. */
  async attach(timeoutMs = 5000): Promise<TargetInfo> {
    if (this.geolocation === null) throw new Error("no position of the page for its tabs");
    // Variant Б (plan-b §4.1.1): only the operator's own requests stop in
    // Fetch — Hub's (its placeholder host), the environment check's page and
    // the self-test's probes. The site's own requests go as a browser's do.
    await this.#cdp.send("Fetch.enable", { patterns: FETCH_PATTERNS });
    await this.#cdp.send("Browser.grantPermissions", { permissions: ["geolocation"], origin: this.#options.siteOrigin ?? SITE_ORIGIN });
    await this.#cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const created = await this.#cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const tab = await this.waitForTarget(created.targetId, timeoutMs, "the work tab");
    this.#workTab = tab;
    for (const other of this.targets) {
      if (other !== tab && other.type === "page" && other.parentSessionId === null) {
        await this.#cdp.send("Target.closeTarget", { targetId: other.targetId }).catch((error: unknown) => this.#log("close_tab.failed", { error: errorMessage(error) }));
      }
    }
    return tab;
  }

  /** A target this control created: attached, set up and let run. */
  async waitForTarget(targetId: string, timeoutMs: number, what = "the tab"): Promise<TargetInfo> {
    const deadline = Date.now() + timeoutMs;
    let tab: TargetInfo | undefined;
    while (!(tab = this.targets.find((target) => target.targetId === targetId)) && Date.now() < deadline) await sleep(20);
    if (!tab) throw new Error(`${what} was not attached`);
    const ready = await Promise.race([tab.setup, sleep(Math.max(0, deadline - Date.now())).then(() => false)]);
    if (!ready) throw new Error(`${what} was not set up`);
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

  /** "Chrome/155.0.8059.84" */
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
    this.#log("target.attached", { type: target.type, url: urlForLogLine(target.url), waiting: params.waitingForDebugger, nested: target.parentSessionId !== null });
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
      // The site's sign-out and its live session show in its storage
      // (plan-b §4.1.6, §4.1.9): the tab's events, and a read of its live
      // session for the socket's authorization size (operator.ts).
      if (page && target.type === "page") await this.#cdp.send("DOMStorage.enable", {}, session);
      if (page && target.type === "page") {
        // The tab's position, which its frames inherit. Chrome keeps the
        // override on the tab itself (its WebContents), whichever session
        // set it, and a frame session's detach clears it: set through a
        // frame, the tab would show the server's own position once that
        // frame is gone (Chrome 155, emulation_handler.cc).
        const position = this.geolocation;
        if (position === null) throw new Error("no position of the page");
        await this.#cdp.send("Emulation.setGeolocationOverride", { latitude: position.latitude, longitude: position.longitude, accuracy: position.accuracyM }, session);
      }
      if ((page || worker) && this.#options.targetSetup) await this.#options.targetSetup(target, page ? "page" : "worker", waiting);
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
