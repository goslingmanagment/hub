// The page operator (plan §3.1, §4.1, §4.9, §4.13): Chrome's only way out
// (egress/), its control over CDP through the holder (cdp/), the self-test
// (selftest/), the engine's RPC (rpc/), the journals (logs/), the buffer and
// its stream to the engine (buffer/) — and the start of plan §4.1, step by
// step:
//
//   1 exit closed → 2 environment → 3 Chrome started (by s6, on the
//   operator's command) → 4 control attached → 5 self-test with the exit
//   closed → 6 exit IP verified through the page's SOCKS5 → 7 exit open.
//
// Step 2 (env/): the page's time zone and languages from the engine's hello
// are handed to Chrome's start (env/handover.ts); once control is attached,
// what the browser shows is compared with them (env/check.ts) on every
// start, and a difference fails it (`env_mismatch`). A hello that changes
// them starts the page again: Chrome takes them only when it starts. The
// hello's position is not used: the site never asks for one, so no tab is
// granted geolocation or given a position — it stays Chrome's own prompt, as
// a person's browser has it. A screen that is not the page's (the X
// server's geometry, or what Chrome shows) is alarmed (`env_mismatch`,
// minor 7) and the start goes on: the size of a window is no reason for the
// page to stand.
//
// Steps 8–10 (PR 7): with the exit open, the work tab loads the site
// (`https://fansly.com/`, step 8 once its document committed); the engine's
// identity read through the browser (`account.me`, a Hub request) naming the
// expected account under the live session confirms the session (9), and the
// page is ready (10). A session that changes goes back to step 8; a site
// that does not load fails the start (`proxy_unavailable`: the network
// between the page and Fansly) and it is tried again after the backoff.
// Until the engine has that identity read it admits nothing of the site
// (checks-only), so the site's first load may see its API requests fail —
// in the interception: none of them left. When the session is confirmed and
// any did, the work tab is loaded anew, once a start, so the site starts
// under an engine that admits; what still waited is closed first, and
// nothing admitted before the reload is released into it.
//
// Hub's requests (hub-requests/, PR 9; plan §4.2): the engine's `send` runs
// in the site's tab under the engine's admission (`check`), the gate's
// window holding its deadline; its outcome is kept in the buffer and sent
// once durable, the body first. They need the site in the work tab and its
// live session (plan §4.7): until then every `send` is answered, not sent
// ("the site is not loaded").
//
// The site's own requests (intercept/, PR 7; plan §4.3): the map of
// operations decides each (policy/operations.ts) — the page, static files
// and other hosts on at once and journaled; the API by the engine's
// admission (`siteAdmit`), waiting at most 60 s; what the map closes failed
// and journaled. Their answers with platform data go to the buffer whole or
// as a mark (`site.response`), their ends to the engine (`siteDone`).
//
// The writes the map opens by their body (owner decision 2026-10-23: the
// site's delivered marks, its read marks closed; intercept/checked.ts): every
// request on their path stops in Fetch and is decided at once, the same in
// both modes — on, unchanged, only when its body passes the check; failed
// and journaled otherwise. What goes is the site's own request, observed and
// told to the engine as its others are.
//
// The site's socket (ws/, PR 10; plan §4.3, §4.4; mandatory condition №3;
// variant Б, plan-b §4.1.9): the guard (inpage/ws-guard.js) goes into every
// tab, frame and worker before the site's code, and lets no message but spec
// §2.6's leave — the first other one stops the page; the proxy's socket gate
// holds the same allow-list outside the page's JavaScript, record by record,
// the authorization's size from the site's own `session_active_session`
// (DOMStorage). Each socket's CONNECT goes on at once — the engine admits
// none; its handshake goes to the engine as an observed send of the site's
// (`siteSent`/`siteEnded`, route `ws.upgrade`), its frames from CDP into the
// buffer — acknowledged to the holder once durable — and gaps mark where
// frames may be missing. After a restart, what the holder delivers again of
// the previous Chrome's sockets is dropped, and the connections the buffer
// kept from before are ended there.
//
// The manual login (login/, PR 15; plan §4.8; spec §7): the engine's
// `setMode` of the current owner generation switches it on — the map lets
// the login operations through beside the interface's reads, Hub's
// requests and the site's socket stay out, the page is never ready — and
// off again, with the checks before the page resumes: the exit IP now, the
// session and the account by an identity read of the engine's under the
// live session sent after the mode changed (what was confirmed before a
// person could be in the page confirms nothing). The API's calls of the
// login form (`login.*`, their own token) are taken only while the mode is
// that owner's: the screen, its screenshot, the owner's input typed in as a
// person types it. What was typed lives in the call for the time of the
// hand-over: never in a log line, a journal, the buffer or an error.
//
// For audits (protocol minor 5): every `state` says whether a Hub request
// can go now — a page may be `ready` while the transport refuses them (a
// client header the site computes otherwise) — with the reason and since
// when; and Chrome's crash dumps on the profile, as root counted them. Every
// transition of the page's step goes to Hub besides the states journal: an
// event of the buffer (`browser.transition`), acknowledged with the stream,
// its note's IPs masked. They wait in memory (the newest few hundred) while
// the buffer takes no writes or no engine that reads them (minor 5) is linked.
// Every `state` also counts the exit's refusals since the operator started
// (`egressFailures`): the page's SOCKS5 failing a tunnel by how, at which
// step, its reply and the host's class; the rules extension's blocks by the
// host's class, the self-test's probes apart.
//
// The page's SOCKS5 failing one tunnel (variant Б: the site goes as a
// browser's): on a tunnel to Fansly, the greeting or the login failing is the
// proxy failing the site — the page fails (`proxy_unavailable`,
// `proxy_auth`); a CONNECT the server dropped or refused there, or any failure
// on a third party's tunnel but a refusal of its destination, runs the exit
// IP check out of turn (at most every `proxyRecheckMs`); a third party's
// destination refused is that tunnel's alone. Chrome sees each such tunnel
// failed.
//
// The exit IP (plan §4.5): a start checks it before the exit first opens —
// strictly: no answer, no open exit; the engine's openExit checks it again.
// While the page is up it is checked hourly, out of turn after a failed
// tunnel, and as the manual login ends: an IP not the pinned one stops the
// page until the owner decides (`exit_ip_changed`); a check that gets no
// answer it can judge (a timeout, ipify not reached or not answering an
// address, the SOCKS5 failing that check's own tunnel) says nothing of the
// IP — Hub's requests are held (`hubSend`: `exit_ip_unknown`), the engine is
// alarmed (minor 7), Chrome and the site go on, and the check is tried again
// after the restart backoff until one names the pinned IP, which lets Hub's
// requests go again — for 30 min at most without a break: then the page
// fails as before (`proxy_unavailable`: the exit closes, Chrome stops, the
// start's strict check retries). A proxy that is down indeed fails the page
// by the site's own tunnels (above).
//
// A Hub request goes only after the page's quiet by the operator's own sight
// (plan-b Б12; hub-requests/hub.ts): the admission's pause since the last
// write to the API by the proxy's bytes, the last send of the site's own and
// its socket's handshake, with no request of the site's own in flight.
//
// What holds, whatever happens:
// - No Hub request leaves without the engine's admission: only by its
//   `check` and through the gate's window. The site's own requests and its
//   socket go as a browser's do and are observed (variant Б). Nothing the map
//   closes leaves, and no socket message off spec §2.6's list. Nothing of the
//   site goes before the exit opens.
// - A page starts only on the engine's restartBrowser; a failure stops it
//   and retries after 10 s, 30 s, 2 min, then every 5 min; a halt (the
//   engine's stopPage, a changed exit IP) holds until the next
//   restartBrowser. An operator that starts again stands until the engine
//   starts the page (stage 1, amendment 17). A halt only the owner can
//   decide is held besides on the volume (state/halt-store.ts, PR 17):
//   every start and the exit's opening are refused until a clearHalt names
//   it (or, for login_required, the expected account is confirmed after the
//   owner's login).
// - A planned stop closes the exit before CDP goes (plan §4.1). A lost
//   control — CDP, the holder, its overflow, a browser that stops answering —
//   closes the exit at once, gives Chrome a bounded quit then kills if needed, and retries.
// - Nothing passes that could not be kept (spec §5): a start waits for the
//   buffer to be written and to have room; a buffer that fills up (its caps,
//   the disk) closes the exit and fails the page with `buffer_full` or
//   `disk_full`, and the page starts again once there is room. No admission
//   while the buffer refuses writes (plan §4.3). The JSONL journals (logs/)
//   are the operator's diagnostics, not that store: one that falls behind
//   the disk or fails to write drops its lines, counts them (a gap line when
//   it writes again) and alarms the engine (minor 7); the page goes on, and
//   no start waits for them.
// - A buffer that cannot be opened (locked, a failing disk, a corrupt or too
//   new file) does not take the operator down: the RPC, the heartbeat and
//   the proxy (refusing) run, the page stands with `buffer_unavailable`,
//   the engine is alarmed, no start passes the gate, and the buffer is
//   opened again when that may help — its file is never touched.

import { closeSync, mkdirSync, openSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";

import { EventBuffer, type BufferAlarm, type BufferOptions, type BufferUnavailable, type FullReason } from "../buffer/buffer.ts";
import { OutcomeReplay } from "../buffer/replay.ts";
import { EventStream } from "../buffer/stream.ts";
import { Cdp, CdpError, type CdpEvent, type HolderLink } from "../cdp/client.ts";
import { BrowserControl, SITE_ORIGIN } from "../cdp/control.ts";
import { PausedRequests, type PausedDecision, type PausedRequest } from "../cdp/paused.ts";
import { HubRequests, isChallenge, type HubTimings, type PageQuiet } from "../hub-requests/hub.ts";
import { sessionFingerprint } from "../hub-requests/session.ts";
import { LoginDesk, type LoginGuard, type LoginOutcome, type LoginTimings } from "../login/desk.ts";
import { SiteRequests, type SiteTimings } from "../intercept/site.ts";
import { OBSERVED_ACK_MINOR, SITE_STALE_IN_FLIGHT_MS, SiteObserver } from "../intercept/observe.ts";
import { BlockedRequests } from "../intercept/blocked.ts";
import { publishCaptureBuilt } from "../capture/mode.ts";
import { PublishCapture } from "../capture/publish.ts";
import { checkedPath, decideChecked, describeChecked } from "../intercept/checked.ts";
import { guardExpression, newBindingName } from "../ws/guard.ts";
import { GuardInstaller } from "../ws/install.ts";
import { BoundaryFile } from "../ws/boundary.ts";
import { SiteSockets, type SocketStop, type SocketTimings } from "../ws/sockets.ts";
import { PLACEHOLDER_SUFFIX, WORLD } from "../hub-requests/page.ts";
import { EnvCheck } from "../env/check.ts";
import { readXGeometry, type XGeometry } from "../env/display.ts";
import { SCREEN } from "../env/rules.ts";
import { writeHandover } from "../env/handover.ts";
import { describeEnv, sameEnv } from "../env/rules.ts";
import { checkExitIp, IPIFY, normalizeIp, type ExitIpTarget } from "../egress/exit-ip.ts";
import { maskIps } from "../egress/ip-mask.ts";
import { ExtensionFiles } from "../egress/extension-files.ts";
import { ApiGate, SLOT_LIMIT_MS } from "../egress/gate.ts";
import { classifyFanslyHost, FANSLY_HOSTS, type HostClass, type HostClassifier } from "../egress/hosts.ts";
import { Egress, type TunnelSocksFailure } from "../egress/proxy.ts";
import { SocksError, type SocksConfig } from "../egress/socks5.ts";
import { hostAndPath, Journals, type JournalTrouble } from "../logs/journal.ts";
import { GenerationStore } from "../rpc/generation.ts";
import type { CommandOutcome } from "../rpc/ledger.ts";
import { DEFAULT_PARAMS, FAULT_ALARMS, FAULTS_MINOR, WRITES_MINOR, type AlarmKind, type BufferMessage, type BufferEvent, type Command, type Hello, type HubSendBlock, type LoginRequest, type Mode, type OperatorParams, type SelfTestMechanism, type State } from "../rpc/protocol.ts";
import { RpcServer } from "../rpc/server.ts";
import { EXTENSION_CHECKS, runSelfTest, type ExtensionChecks, type SelfTestResult } from "../selftest/selftest.ts";
import { ProbeDriver } from "../selftest/probes.ts";
import { HaltStore, heldForTheOwner, LOGIN_DECIDES, newHalt, replacesHeld, type HeldHalt } from "../state/halt-store.ts";
import { PageState, type Transition } from "../state/page-state.ts";
import { readCrashDumps, transitionNote } from "../state/telemetry.ts";
import { EgressFailureCounts } from "../state/egress-failures.ts";
import { atLeast, RESTART_BACKOFF_MS, restartDelayMs, type StopReason } from "../state/steps.ts";
import { classifyCaptureHost, FANSLY_DOMAIN, normalHost, UPLOAD_HOST, type OperatorMode } from "../policy/operations.ts";
import { registerSecret } from "../shared/secrets.ts";
import { errorMessage, makeLog, monoMs, sleep, wallMs, type Logger } from "../shared/util.ts";
import type { ChromeControl } from "./chrome.ts";
import { quitChromeAfterFailure } from "./quit.ts";
import type { OperatorConfig } from "./config.ts";
import { HealthProbe } from "./health.ts";

export interface OperatorTimings {
  /** Between attempts to link to the holder. */
  holderRelinkMs: number;
  /** How long a new link waits for the holder's replay to be handled. */
  replayWaitMs: number;
  /** From Chrome's start to its DevTools connection held. */
  chromeUpMs: number;
  /** The control's setup and the work tab. */
  attachMs: number;
  /** The environment's check in the browser (env/check.ts). */
  envCheckMs: number;
  heartbeatMs: number;
  /** A `state` at least this often (the engine alarms after 2 min without). */
  stateEveryMs: number;
  healthEveryMs: number;
  healthAnswerMs: number;
  selfTestProbeMs: number;
  exitIpTimeoutMs: number;
  /** A planned stop waits this long for Chrome to quit by itself. */
  quitWaitMs: number;
  /** The operator's stop waits this long for the engine to confirm the
   *  site's observations it keeps (minor 6) — within s6's grace (6 s). */
  observedDrainMs: number;
  /** One total close-and-exit deadline on a failure (at most 2 s). */
  failureQuitMs: number;
  /** The site's document in the work tab (plan §4.1, step 8). */
  siteLoadMs: number;
  /** A tunnel the page's SOCKS5 failed runs the exit IP check out of turn at
   *  most this often. */
  proxyRecheckMs: number;
  /** The exit IP unknown this long without a break: the page fails as
   *  before (#exitIpUnknown). */
  exitIpUnknownMaxMs: number;
  /** Before the work tab is loaded anew, how long a request of the site
   *  that is in flight is waited out. */
  reloadWaitMs: number;
  /** The page's slot past its admission's deadline (egress/gate.ts). */
  slotLimitMs: number;
  /** A profile no page has (page 0): how long its mode's document may stand
   *  without the operator having seen its session before an identity read
   *  that cannot be confirmed loads the site anew, once a document. */
  sessionShowWaitMs: number;
}

/** How long a page goes on with its exit IP unknown (#exitIpUnknown). A
 *  check that gets no answer says nothing of the IP, and stopping Chrome for
 *  one would not change what Fansly saw — but a provider that silently moved
 *  the exit, with ipify unreachable through the new one, would leave Chrome
 *  and the site running from an IP nobody confirmed for as long as that
 *  lasts. 30 min is well past a passing outage of ipify or a flaky refusal
 *  of the check's tunnel (the retries at 10 s, 30 s, 2 min, 5 min see one
 *  through), and short of hours on an unconfirmed exit: then the page does
 *  what it did before — its exit closes and Chrome stops
 *  (`proxy_unavailable`, a failure the start retries, never a halt), and the
 *  start's strict check opens the exit again only on the pinned IP. */
export const EXIT_IP_UNKNOWN_MAX_MS = 30 * 60_000;

const DEFAULT_TIMINGS: OperatorTimings = {
  holderRelinkMs: 100,
  replayWaitMs: 10_000,
  chromeUpMs: 30_000,
  attachMs: 10_000,
  envCheckMs: 10_000,
  heartbeatMs: 1000,
  stateEveryMs: 5000,
  healthEveryMs: 2000,
  healthAnswerMs: 5000,
  selfTestProbeMs: 4000,
  exitIpTimeoutMs: 15_000,
  quitWaitMs: 5000,
  observedDrainMs: 3000,
  failureQuitMs: 2000,
  siteLoadMs: 30_000,
  proxyRecheckMs: 30_000,
  exitIpUnknownMaxMs: EXIT_IP_UNKNOWN_MAX_MS,
  reloadWaitMs: 30_000,
  slotLimitMs: SLOT_LIMIT_MS,
  sessionShowWaitMs: 3_000,
};

/** The site the work tab loads (plan §4.1, step 8). */
export const SITE_URL = `${SITE_ORIGIN}/`;

/** The stop's wait for the engine's confirmations looks again this often. */
const OBSERVED_DRAIN_POLL_MS = 50;

/** The work tab's storage events the site's sign-out and its live session
 *  show in (DOMStorage). */
const SITE_STORAGE_EVENTS = ["DOMStorage.domStorageItemAdded", "DOMStorage.domStorageItemUpdated", "DOMStorage.domStorageItemRemoved", "DOMStorage.domStorageItemsCleared"] as const;
// Fansly's StorageHelper("session_") prefixes these keys; see
// artifacts/fansly-app-bundle-2026-10-08/analysis/main.2e6b96097a4bb73b.pretty.js:35051 (helper :863).
const SITE_ACTIVE_SESSION_KEY = "session_active_session";
const SITE_ACTIVE_SESSION_CLEAR_INFO_KEY = "session_active_session_clear_info";
/** An identity answer is read for its account id up to this size. */
const IDENTITY_BODY_MAX = 1024 * 1024;
/** A discarded work tab's blank document comes within this, or the
 *  browser goes (#discardDocument). */
const DISCARD_WAIT_MS = 5_000;
/** Transitions not in the buffer yet kept at most (the newest). */
const TRANSITIONS_KEPT = 256;
/** The protocol minor from which an engine reads `browser.transition`. */
const TRANSITIONS_MINOR = 5;
/** Chrome's crash dumps' count is read again at most this often. */
const CRASH_DUMPS_READ_MS = 5_000;
/** A request of the site's own counts as in flight for a Hub request's quiet
 *  this long at most (the engine's bound of a foreign send, its request
 *  timeout): a lost end stands Hub's requests no longer. */
const SITE_QUIET_IN_FLIGHT_MS = 20_000;
/** A diagnostic journal's trouble alarms the engine at most this often (its
 *  alarm holds Hub's alert 10 min: one that goes on keeps it open). */
const JOURNAL_ALARM_EVERY_MS = 5 * 60_000;
/** The hosts of Fansly's own classes: the proxy failing a tunnel to one is the
 *  proxy failing the site. */
const FANSLY_CLASSES: ReadonlySet<HostClass> = new Set(["site", "api", "ws", "cdn"]);

type TransitionEvent = Omit<Extract<BufferEvent, { kind: "browser.transition" }>, "seq" | "atMono" | "atWall">;

export interface OperatorDeps {
  config: OperatorConfig;
  chrome: ChromeControl;
  /** Tests provide their X server; production reads :99 with xdpyinfo. */
  display?: () => Promise<XGeometry>;
  classify?: HostClassifier;
  /** The stand's publish capture (capture/mode.ts); absent: as the image's
   *  extension directory says — a production image's says no. */
  publishCapture?: boolean;
  /** The host of the self-test's probes: the API host. */
  apiHost?: string;
  exitIpTarget?: ExitIpTarget;
  extension?: ExtensionChecks;
  timings?: Partial<OperatorTimings>;
  /** Tests: the buffer's disk, its room, how often it looks, its retries. */
  buffer?: Pick<BufferOptions, "diskFree" | "minFreeBytes" | "checkEveryMs" | "resumePercent" | "maxPages" | "openRetryMs" | "retryMs">;
  /** Tests: the Hub requests' waits and limits. */
  hubTimings?: Partial<HubTimings>;
  /** Tests: the socket's waits. */
  socketTimings?: Partial<SocketTimings>;
  /** Tests: the site requests' waits and limits. */
  siteTimings?: Partial<SiteTimings>;
  /** TESTS ONLY: false keeps the strict gate of the site's admitted path
   *  (variant Б's production gate is passive). */
  gatePassive?: boolean;
  /** Tests: the login desk's waits. */
  loginTimings?: Partial<LoginTimings>;
  /** Tests: where the held halt is kept (else `stateDir/halt.json`). */
  haltStore?: HaltStore;
  log?: Logger;
}

interface EngineSettings {
  pageId: number;
  expectedAccountId: string;
  pinnedExitIp: string;
  socks: SocksConfig;
  env: Hello["env"];
}

/** A step of the start failed, and why the page stands. */
class StartFailure extends Error {
  readonly reason: StopReason;
  constructor(reason: StopReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** The start was superseded (a newer start, a stop, a failure elsewhere). */
class Cancelled extends Error {}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class Operator {
  readonly config: OperatorConfig;
  readonly chrome: ChromeControl;
  readonly egress: Egress;
  /** The rules extension's package on the proxy's port (plan §4.6). */
  readonly extension: ExtensionFiles;
  readonly rpc: RpcServer;
  readonly cdp: Cdp;
  readonly control: BrowserControl;
  readonly probes: ProbeDriver;
  readonly envCheck: EnvCheck;
  readonly page: PageState;
  readonly journals: Journals;
  /** What the page captured, until the engine has it (plan §4.4): the
   *  producers of PRs 7, 9 and 10 write here. */
  readonly buffer: EventBuffer;
  readonly stream: EventStream;
  readonly replay: OutcomeReplay;
  readonly paused: PausedRequests;
  /** Hub's requests through the site's tab (plan §4.2). */
  readonly hub: HubRequests;
  /** The socket guard in every context of the page (plan §4.3). */
  readonly guard: GuardInstaller;
  /** The site's socket: admissions, frames, outcomes (plan §4.4). */
  readonly sockets: SiteSockets;
  /** The site's own requests: the map, the engine's admission, the
   *  answers (plan §4.3). */
  readonly site: SiteRequests;
  /** Variant Б: the site's own API traffic, observed. */
  readonly observer: SiteObserver;
  /** The stand's publish capture (capture/publish.ts): only in an image
   *  built for it; null in every production image. */
  readonly publishCapture: PublishCapture | null;
  /** The exit's refusals since this operator started (`state.egressFailures`). */
  readonly egressFailures = new EgressFailureCounts();
  /** The rules extension's blocks, as Chrome reports them. */
  readonly blocked: BlockedRequests;
  /** The login form's desk (plan §4.8): the screen, its screenshot, the
   *  owner's input. */
  readonly login: LoginDesk;
  readonly #health: HealthProbe;
  readonly #timings: OperatorTimings;
  readonly #log: Logger;
  readonly #display: () => Promise<XGeometry>;
  readonly #apiHost: string;
  readonly #exitIpTarget: ExitIpTarget;
  readonly #extension: ExtensionChecks;
  readonly #classify: HostClassifier;
  #params: OperatorParams = DEFAULT_PARAMS;
  /** The operator's mode (spec §6.1; plan §4.8): `manual_login` only by the
   *  engine's `setMode`, for the owner generation that set it. */
  #mode: OperatorMode = "automation";
  /** The owner generation whose `setMode` switched the manual login on: the
   *  login form's calls are taken only while it is the current one. */
  #modeGeneration: number | null = null;
  /** The work tab is loaded anew for a change of the mode (it waits out
   *  what is in flight first). */
  #modeReload = 0;
  /** Changes whenever what a login call was taken under may have: a change
   *  of the mode, a hand-over, the engine's link lost or found. A step of
   *  the login form taken before stops at its next input step (Astra's
   *  review of PR 15, item 3). */
  #loginEpoch = 0;
  /** The account the engine's identity read named, and under which
   *  session (plan §4.1, step 9). */
  #identity: { accountId: string; fingerprint: string } | null = null;
  /** An identity read sent before this instant (CLOCK_MONOTONIC ms) names
   *  nothing: what it confirmed was before the last change of the mode — a
   *  person may have been in the page since (Astra's review of PR 15,
   *  item 6). */
  #identityFloorMono = Number.NEGATIVE_INFINITY;
  /** A profile no page has yet (page 0: its onboarding, Project Browser PR
   *  16): its identity read names whatever account the browser is logged
   *  into — so it confirms only the session that exists after the person's
   *  login: the one the site's own authorized GET showed from the document
   *  the operator loaded after the mode last changed (Astra's review of PR
   *  16, rounds 2–3: until then the Hub requests' headers may still be the
   *  session of before the login, and a late request of the replaced
   *  document still carries it). The document is bound by Chrome's loader:
   *  the one Chrome named in answer to the navigation started in this mode,
   *  committed and still the frame's; the GET is of that loader. The changes
   *  of the mode are counted. */
  #modeChanges = 0;
  #modeDocument: { mode: number; loaderId: string } | null = null;
  #sessionShownInMode: { fingerprint: string; loaderId: string } | null = null;
  /** An authorized GET of the automation whose document Chrome had not named
   *  when it paused: judged once Chrome does. */
  #sessionNoteWaiting: { networkId: string; fingerprint: string } | null = null;
  /** The session each top-frame document's authorized GETs of this mode
   *  showed (the latest; a few documents — never the frame's current one
   *  evicted): a GET can come before the answer to its document's navigation
   *  is taken (one batch of Chrome's messages — Astra's review of PR 16,
   *  rounds 4–5), and counts once that answer names it. A child frame's
   *  document is never the mode's: its GETs are not kept. */
  readonly #sessionsShown = new Map<string, string>();
  /** When the mode's document came in (monotonic ms), and the document an
   *  unconfirmable identity read had the site loaded anew for (once). */
  #modeDocumentLoadedMono: number | null = null;
  #loadedAnewFor: string | null = null;
  /** The work tab was loaded anew at a confirmation of this start: once. */
  #siteReloaded = false;
  /** That reload is under way (it waits out what is in flight first). */
  #reloadPending = false;
  #settings: EngineSettings | null = null;
  /** The current start; a newer one, a stop or a failure supersedes it. */
  #run = 0;
  #starting = false;
  /** The start that runs now, or the last one: settles when it ended. */
  #runDone: Promise<void> = Promise.resolve();
  /** A start being ended for a new owner (#stand): settles when it ended. */
  #standing: Promise<void> = Promise.resolve();
  /** The holder is stopping: the exit stays closed until a holder links
   *  again — nothing may open it between "exit.closed" and the detach. */
  #holderStopping = false;
  /** The linked holder's Chrome connection closed: that holder exits (s6
   *  starts a fresh one), and its link closes soon. */
  #holderSpent = false;
  /** The site socket's part of this operator's start was done (after the
   *  holder's first replay). */
  #socketsRestarted = false;
  #stopped = false;
  #linking = false;
  /** Chrome runs under the operator's control: losing it is a failure. */
  #controlExpected = false;
  /** The engine closed the exit: a start stops short of opening it. */
  #exitHeld = false;
  #selfTest: SelfTestResult | null = null;
  /** The halt held for the owner's decision (Astra round 3): on the volume
   *  (`#haltStore`), read when the operator starts. While it is held no start
   *  runs and the exit does not open — but the owner's login of a browser
   *  that Fansly signed out (`login_required`, in the manual login). */
  #held: HeldHalt | null = null;
  readonly #haltStore: HaltStore;
  /** The held halt is not on the volume yet (its write failed): tried again
   *  with every state the operator says. */
  #heldUnwritten = false;
  /** The id of the last halt cleared (the owner's clearHalt, or the
   *  operator's own login_required clearing), kept with the halt: Hub lets
   *  its mirror of a halt go only on this word (Astra round 4). */
  #lastClearedId: string | null = null;
  /** The id of the held `login_required` the owner's login was opened for:
   *  the expected account confirmed after it clears that halt. */
  #loginForHalt: string | null = null;
  #exitIp: string | null = null;
  #chromeVersion = "";
  #retryTimer: NodeJS.Timeout | null = null;
  /** The next check of the exit IP while the page is up: hourly, or the
   *  restart backoff's next step while the IP is unknown. */
  #ipTimer: NodeJS.Timeout | null = null;
  #ipChecking = false;
  /** The exit IP unknown (minor 7): a check of the page that is up got no
   *  answer it can judge. Hub's requests are held until a check names the
   *  pinned IP — since when, the checks in a row that failed, and why the
   *  last one did. Ends with the page's run (#stopIpTimer). */
  #ipUnknown: { sinceWall: number; sinceMono: number; failures: number; why: string } | null = null;
  /** When a diagnostic journal's trouble last alarmed the engine. */
  #journalAlarmMono = Number.NEGATIVE_INFINITY;
  /** When a failed tunnel last ran the exit IP check out of turn. */
  #proxyRecheckMono = Number.NEGATIVE_INFINITY;
  #heartbeatTimer: NodeJS.Timeout | null = null;
  #stateTimer: NodeJS.Timeout | null = null;
  #commandChain: Promise<void> = Promise.resolve();
  /** Chrome is started, stopped and killed one operation at a time. */
  #chromeChain: Promise<void> = Promise.resolve();
  /** Hub's requests refused: the reason the last state named, and since
   *  when it holds (wall ms; minor 5). */
  #hubBlocked: { reason: HubSendBlock; sinceWall: number } | null = null;
  /** The page's transitions not in the buffer yet, oldest first, and how
   *  many were let go for want of room. */
  #transitions: Array<{ event: TransitionEvent; at: { mono: number; wall: number } }> = [];
  #transitionsDropped = 0;
  /** Chrome's crash dumps as last read (null: none counted), and when. */
  #crashDumps: NonNullable<State["crashDumps"]> | null = null;
  #crashDumpsReadMono = Number.NEGATIVE_INFINITY;

  constructor(deps: OperatorDeps) {
    this.config = deps.config;
    this.chrome = deps.chrome;
    this.#timings = { ...DEFAULT_TIMINGS, ...deps.timings };
    this.#log = deps.log ?? makeLog("operator");
    this.#display = deps.display ?? readXGeometry;
    this.#apiHost = deps.apiHost ?? FANSLY_HOSTS.api[0];
    this.#exitIpTarget = deps.exitIpTarget ?? IPIFY;
    this.#extension = deps.extension ?? EXTENSION_CHECKS;
    // The stand's publish capture is the image's: its marker, next to the
    // rules extension it was built with (capture/mode.ts). It opens the
    // upload host at the proxy; its rules open the site's publishing
    // requests; Hub sends no write in it.
    const capture = deps.publishCapture ?? publishCaptureBuilt(this.config.extensionDir);
    this.#classify = deps.classify ?? (capture ? classifyCaptureHost : classifyFanslyHost);
    registerSecret(this.config.rpcToken);
    mkdirSync(this.config.stateDir, { recursive: true, mode: 0o700 });
    // The halt held from before this operator, read first. A spoilt slot or
    // a file that cannot be read is a halt being written: a strict one of its
    // own (`halt_unreadable`) is held, and written, until the owner clears it.
    this.#haltStore = deps.haltStore ?? new HaltStore(join(this.config.stateDir, "halt.json"));
    const kept = this.#haltStore.read();
    this.#held = kept.halt;
    this.#lastClearedId = kept.lastClearedId;
    if (kept.unreadable === true) this.#writeHeld();

    this.journals = new Journals({
      dir: this.config.logDir,
      // Diagnostics, not the store of what Hub needs (the buffer is, spec
      // §5): a journal in trouble drops and counts its lines, and the engine
      // is alarmed; the exit and the browser stay as they are.
      onTrouble: (trouble) => this.#onJournalTrouble(trouble),
    });
    this.page = new PageState({ backoffMs: DEFAULT_PARAMS.restartBackoffMs });
    this.page.onTransition = (transition) => {
      this.#log("state", { from: transition.from, to: transition.to, stopReason: transition.stopReason, retryAtWall: transition.retryAtWall, halted: transition.halted, note: transition.note });
      this.journals.state({ ...transition });
      this.#noteTransition(transition);
      this.#sendState();
    };

    // The rules extension's package, for Chrome's policy (PR 6).
    this.extension = new ExtensionFiles(this.config.extensionDir, this.#log);
    this.egress = new Egress({
      // Variant Б: the site's own requests go free on the API's connections.
      gate: new ApiGate({ slotLimitMs: this.#timings.slotLimitMs, passive: deps.gatePassive ?? true }),
      classify: this.#classify,
      serve: (req, res) => this.extension.serve(req, res),
      openSocket: (host, port) => this.sockets.openTunnel(host, port),
      // Hub's write to the upload API (closed to the site), while it holds
      // the page's slot (wall posts PR 7).
      admitsClosed: (host) => normalHost(host) === UPLOAD_HOST && this.hub.holdsUpload(),
      onRecord: (record) =>
        this.journals.connection({
          id: record.id,
          host: record.host,
          port: record.port,
          cls: record.cls,
          openedWall: record.openedWall,
          closedWall: record.closedWall,
          durationMs: record.closedMono === null ? null : Math.round(record.closedMono - record.openedMono),
          up: record.up,
          down: record.down,
          held: record.held,
          refused: record.refused,
          result: record.result,
        }),
      onSocksFailure: (failure, message) => this.#onSocksFailure(failure, message),
    });

    this.cdp = new Cdp({ socketPath: this.config.holderSock });
    this.guard = new GuardInstaller({
      cdp: this.cdp,
      ...((binding) => ({ binding, expression: guardExpression(binding) }))(newBindingName()),
      onReport: (report, target) => this.sockets.onGuardReport(report, target),
      onFailed: (target, why) => this.#socketStop("ws_guard_failed", `${why} (${target.type})`, "kill"),
    });
    this.control = new BrowserControl(this.cdp, {
      networkBuffer: DEFAULT_PARAMS.chromeBodyBuffer,
      onSetupFailed: (target, error) => {
        if (!this.#controlExpected) return;
        void this.#fail("cdp_lost", `a ${target.type} could not be set up: ${error.message}`);
      },
      targetSetup: (target, kind, waiting) => this.guard.setUp(target, kind, waiting),
    });
    this.probes = new ProbeDriver(this.cdp, this.control, { apiHost: this.#apiHost, exitClosed: () => !this.egress.exitOpen });
    this.envCheck = new EnvCheck(this.cdp, this.control);
    this.paused = new PausedRequests(this.cdp, {
      decide: (request) => this.#decide(request),
      // A write the map opens by its body: its check reads the body; so
      // does a write of Hub's own (its fingerprint, PR 7).
      readsBody: (request) => checkedPath(request.url) || HubRequests.readsBody(request),
      onDecided: (request, decision) => {
        // Failed here, not by the rules extension: no block of its to count.
        if (decision.action === "fail" && request.networkId !== null) this.blocked.failedHere(request.networkId);
        this.#journalRequest(request, decision);
      },
      // An answer resolved at the response stage — and confirmed by Chrome,
      // never merely decided — ends its request for the page's slot,
      // whoever decided it (a path, or a decision for an operation that
      // already ended). Unanswered or refused, the request stays pending
      // and the slot's bound runs.
      onResolved: (request, decision, resolution) => {
        if (resolution === "answered" && request.stage === "response" && (decision.action === "fail" || decision.action === "fulfill")) this.egress.gate.requestEnded(request.networkId);
      },
      // With CDP or the holder link down, their own loss handles it; with
      // both up, Chrome is not answering for its paused requests.
      onIndeterminate: (_request, why) => {
        if (this.cdp.cdpUp && this.cdp.linked) this.#controlLost("cdp_lost", `a paused request's resolution got no answer (${why})`);
      },
    });
    this.#health = new HealthProbe(this.cdp, this.control, this.chrome, {
      everyMs: this.#timings.healthEveryMs,
      answerMs: this.#timings.healthAnswerMs,
      onUnhealthy: (reason) => this.#controlLost("cdp_lost", reason),
    });
    this.cdp.onHolderEvent = (event) => {
      switch (event.t) {
        case "cdp.down":
          this.#holderSpent = true;
          this.#controlLost("cdp_lost", `Chrome's DevTools connection closed (${event.reason})`);
          return;
        case "overflow":
          this.#controlLost("holder_overflow", "the holder's store overflowed: the operator fell behind");
          return;
        case "stopping":
          // The holder is told to stop: the exit closes before it lets go of
          // CDP, and stays closed — a start or an openExit under way ends
          // here, none may open it before the detach.
          this.#holderStopping = true;
          this.#cancelRun();
          this.#clearRetry();
          this.egress.closeExit("the holder stops");
          this.cdp.holderCommand("exit.closed");
          return;
        case "cdp.up":
          if (!this.#controlExpected) this.#log("chrome.up_without_a_start", { note: "left alone: the exit is closed" });
          return;
      }
    };
    this.cdp.onHolderGone = () => {
      this.#controlLost("cdp_lost", "the holder link closed");
      if (!this.#stopped) void this.#linkHolder(false);
    };

    this.rpc = new RpcServer({
      token: this.config.rpcToken,
      apiToken: this.config.apiToken ?? null,
      generations: new GenerationStore(join(this.config.stateDir, "owner-generation")),
      pingMs: DEFAULT_PARAMS.pingMs,
      linkLossMs: DEFAULT_PARAMS.linkLossMs,
      handlers: {
        onHello: (hello) => this.#onHello(hello),
        quiesce: () => this.#quiesce(),
        onCommand: (command) => this.#onCommand(command),
        onBuffer: (message) => this.#onBuffer(message),
        onHub: (message) => {
          if (message.type === "send") this.hub.onSend(message);
          else this.hub.onCheckResult(message);
        },
        // Variant Б: no socket is admitted, so none is asked for.
        onSocket: (message) => this.#log("socket.admission_unasked", { connectionId: message.connectionId, admit: message.admit }),
        onSite: (message) => this.site.onAdmitResult(message),
        onObservedAck: (message) => this.observer.confirmed(message.deliverySeqs),
        onLogin: (request) => this.#onLogin(request),
        onLink: (up, reason) => {
          // What the login form was typing for the engine of before stops.
          this.#cancelLogin(up ? "a new engine connection" : "the engine's link was lost");
          // A new connection subscribes anew; the outcomes not acknowledged
          // go to it again (spec §6.2), a page at a time.
          this.stream.reset();
          // The site's requests still waiting are asked on the new one — or
          // wait for one (plan §4.9).
          this.site.linkChanged(up);
          this.observer.linkChanged(up);
          this.#log(up ? "engine.linked" : "engine.lost", { reason, admissionsOpen: this.admissionsOpen() });
          if (!up) {
            this.replay.disconnected();
            // No check is answered any more: what waits for one fails.
            this.hub.linkLost();
            return;
          }
          this.#sendState();
          this.replay.connected();
          // A buffer that filled up, or could not be opened, before this
          // engine came: it is told.
          const full = this.buffer.fullness;
          if (full) this.#alarm("buffer", { ...alarmDetail(full.alarm), full: true, reason: full.reason, detail: full.detail });
          const unavailable = this.buffer.unavailable;
          if (unavailable) this.#alarm("buffer", unavailableDetail(unavailable));
          // The transitions that waited for an engine that reads them.
          this.#flushTransitions();
        },
      },
    });

    // Last: its handlers use everything above.
    this.buffer = new EventBuffer({
      dir: this.config.bufferDir,
      idFile: join(this.config.stateDir, "buffer-id"),
      operatorVersion: this.config.operatorVersion,
      batchMs: DEFAULT_PARAMS.bufferBatchMs,
      caps: DEFAULT_PARAMS.bufferCap,
      ...deps.buffer,
      onAlarm: (alarm) => this.#alarm("buffer", alarmDetail(alarm)),
      onFull: (reason, alarm, detail) => {
        // Spec §5, steps 1–2: writes are refused already; the exit closes
        // and the page stops — it starts again once there is room.
        this.egress.closeExit(`the buffer takes no writes: ${detail}`);
        this.#alarm("buffer", { ...alarmDetail(alarm), full: true, reason, detail });
        if (this.#controlExpected || this.#starting) void this.#fail(reason, `the buffer takes no writes: ${detail}`);
        this.#sendState();
      },
      onRoom: (reason) => this.#onBufferRoom(reason),
      onUnavailable: (unavailable) => this.#onBufferUnavailable(unavailable),
      onOpened: () => this.#onBufferOpened(),
      onCommitted: ({ events, outcomes }) => {
        if (events > 0) this.stream.pump();
        // As attempts end: one more delivery round, each outcome after its
        // body, read from the file (replay.ts).
        if (outcomes.length > 0) this.replay.live(outcomes);
      },
    });
    this.stream = new EventStream(this.buffer, (json) => this.rpc.sendRaw(json), {
      maxEvents: DEFAULT_PARAMS.eventBatch.maxEvents,
      maxBytes: DEFAULT_PARAMS.eventBatch.maxBytes,
      // The bodies of the site's answers go before the batch that names them.
      link: {
        epoch: () => this.rpc.epoch,
        sendBinary: (frame) => this.rpc.sendBinary(frame),
        backlog: () => this.rpc.backlog(),
        drained: () => this.rpc.drained(),
      },
    });
    this.replay = new OutcomeReplay(
      this.buffer,
      {
        epoch: () => this.rpc.epoch,
        send: (json) => this.rpc.sendRaw(json),
        sendBinary: (frame) => this.rpc.sendBinary(frame),
        backlog: () => this.rpc.backlog(),
        drained: () => this.rpc.drained(),
      },
      { stateOf: (attemptId) => this.site.recoverState(attemptId) ?? this.hub.recoverState(attemptId) },
    );

    this.hub = new HubRequests({
      cdp: this.cdp,
      resolve: (request, decision) => this.paused.resolve(request, decision),
      gate: this.egress.gate,
      classify: this.#classify,
      exitOpen: () => this.egress.exitOpen,
      buffer: this.buffer,
      site: {
        notReady: () => this.#siteNotReady(),
        tabSession: () => this.control.workTab?.sessionId ?? null,
        world: () => {
          const tab = this.control.workTab;
          return tab ? this.control.isolatedWorld(tab, WORLD) : Promise.reject(new Error("no work tab"));
        },
      },
      link: {
        up: () => this.rpc.linkUp,
        generation: () => this.rpc.generation,
        send: (message) => this.rpc.send(message),
      },
      alarm: (kind, detail) => {
        this.#alarm(kind, detail);
        // A client header computed another way: Hub's requests stand from
        // now on, the state says so at once.
        if (kind === "header_mismatch") this.#sendState();
      },
      sessionChanged: (fingerprint) => this.#onSessionChanged(fingerprint),
      identityAnswer: (answer) => this.#onIdentity(answer),
      quiet: () => this.#pageQuiet(),
      siteHold: (route, since) => this.observer.holdSince(route, since),
      // Hub's writes stopped by the operator itself: the state says it now.
      publishingStopped: () => this.#sendState(),
      ...(deps.hubTimings ? { timings: deps.hubTimings } : {}),
    });
    // A Fansly check (a Cloudflare challenge) on any answer of Fansly's hosts
    // — the site's documents and requests, Hub's — stops Hub's writes (spec
    // §8.3); Hub's own are judged on their path too.
    this.cdp.on("Network.responseReceived", (event) => {
      const response = (event.params as { response?: { url?: unknown; headers?: Record<string, string> } }).response;
      if (response?.headers === undefined || !isChallenge(response.headers)) return;
      let host: string;
      try {
        host = normalHost(new URL(String(response.url ?? "")).hostname);
      } catch {
        return;
      }
      if (host === FANSLY_DOMAIN || host.endsWith(`.${FANSLY_DOMAIN}`)) this.hub.stopPublishing("challenge", `a Fansly check answered a request to ${host}`);
    });
    this.site = new SiteRequests({
      cdp: this.cdp,
      resolve: (request, decision) => this.paused.resolve(request, decision),
      gate: this.egress.gate,
      isHubRequest: (networkId) => this.hub.ownsNetworkId(networkId),
      cutApi: (reason) => this.egress.cutClass("api", reason),
      buffer: this.buffer,
      link: {
        up: () => this.rpc.linkUp,
        epoch: () => this.rpc.epoch,
        generation: () => this.rpc.generation,
        send: (message) => this.rpc.send(message),
      },
      notUp: () => this.#siteNotUp(),
      session: {
        fingerprint: () => this.hub.session.fingerprint,
        note: (request) => this.#noteSiteSession(request),
      },
      mode: () => this.#mode,
      fault: (reason, note) => this.#requestFault(reason, note),
      journal: (line) => this.journals.request(line),
      loginEnded: (end) => this.login.loginEnded(end),
      readEnded: (end) => this.login.readEnded(end),
      ...(deps.siteTimings ? { timings: deps.siteTimings } : {}),
    });
    // Variant Б: the site's own API traffic, observed — never paused.
    this.observer = new SiteObserver({
      cdp: this.cdp,
      isApiHost: (host) => this.#classify(host) === "api",
      isHubRequest: (networkId) => this.hub.ownsNetworkId(networkId),
      probeOf: (networkId) => this.probes.probeOf(networkId),
      mode: () => this.#mode,
      link: { send: (message) => this.rpc.send(message), confirms: () => this.rpc.engineMinor >= OBSERVED_ACK_MINOR },
      session: {
        fingerprint: () => this.hub.session.fingerprint,
        note: (request) => this.#noteSiteSession(request),
      },
      buffer: this.buffer,
      journal: (line) => this.journals.request(line),
      readEnded: (end) => this.login.readEnded(end),
      log: makeLog("observe"),
    });
    this.publishCapture = capture
      ? new PublishCapture({
          cdp: this.cdp,
          isOperatorRequest: (networkId) => this.hub.ownsNetworkId(networkId) || this.probes.probeOf(networkId) !== null,
          write: (line) => this.journals.publish(line),
          log: makeLog("publish_capture"),
        })
      : null;
    if (capture) this.#log("publish_capture.on", { note: "the stand's image: the site's publishing requests go and are journaled (publish-<day>.jsonl)" });
    this.blocked = new BlockedRequests(this.cdp, ({ networkId, host }) =>
      this.egressFailures.dnr({ cls: this.#classify(host), probe: this.probes.probeOf(networkId) !== null, host }));
    // Variant Б (plan-b §4.1.6, §4.1.9): the site clearing its own login is
    // seen in its storage, and so is the size of its socket's authorization
    // (the token itself is never kept, logged or written).
    for (const event of SITE_STORAGE_EVENTS) this.cdp.on(event, (message) => this.#onSiteStorage(event, message));
    this.cdp.on("Page.frameNavigated", (event) => this.#onWorkDocument(event));
    // A GET whose document Chrome named after it paused (page 0's
    // confirmation, `#siteShowedSession`).
    this.site.documents.onLoader = (networkId, loaderId) => {
      const waiting = this.#sessionNoteWaiting;
      if (waiting === null || waiting.networkId !== networkId) return;
      this.#sessionNoteWaiting = null;
      this.#sessionShownBy(loaderId, waiting.fingerprint);
    };
    this.login = new LoginDesk({
      cdp: this.cdp,
      tab: () => this.control.workTab?.sessionId ?? null,
      world: () => {
        const tab = this.control.workTab;
        return tab ? this.control.isolatedWorld(tab, WORLD) : Promise.reject(new Error("no work tab"));
      },
      session: () => this.hub.session.fingerprint,
      discard: (why) => this.#discardDocument(why),
      ...(deps.loginTimings ? { timings: deps.loginTimings } : {}),
    });
    this.sockets = new SiteSockets({
      cdp: this.cdp,
      buffer: this.buffer,
      observe: { sent: (handshake) => this.observer.socketSent(handshake), ended: (end) => this.observer.socketEnded(end) },
      sessionFingerprint: () => this.hub.session.fingerprint,
      authorizationBytes: () => this.hub.session.socketAuthorizationBytes(),
      refreshAuthorization: () => void this.#readStoredSession("the socket gate holds a record for the authorization's size"),
      targetType: (sessionId) => this.control.targets.find((target) => target.sessionId === sessionId)?.type ?? null,
      socketHost: (host) => this.#classify(host) === "ws",
      journal: (line) => this.journals.socket(line),
      alarm: (kind, detail) => this.#alarm(kind, detail),
      stop: (reason, note, how) => this.#socketStop(reason, note, how),
      startBoundary: new BoundaryFile(join(this.config.stateDir, "start-boundary.json")),
      ...(deps.socketTimings ? { timings: deps.socketTimings } : {}),
    });
    this.egress.gate.onEvent = (event) => {
      // The send as the gate saw it is the Hub request's or the site
      // request's; what it held or cut goes to the log.
      this.hub.onGateEvent(event);
      this.site.onGateEvent(event);
      if (event.kind !== "first_bytes" && event.kind !== "announced") this.#log("gate", { kind: event.kind, window: event.window, ...event.detail });
    };
    // The page's slot past its bound with an end unknown: Chrome may still
    // hold the request, and it goes with the browser — in a quiet moment, so
    // no request of the site's is cut (plan-b §4.1.10). Hub sends nothing
    // meanwhile: the slot stays the operation's until Chrome is gone.
    this.egress.gate.onUnended = (operation, pending) => {
      this.#log("slot.unended", { operation, pending: pending.length });
      void this.#restartUnended(operation, `${operation}: a request it released has no end past its admission's deadline and the operation's limit`);
    };
    if (this.#held !== null) {
      this.#log("halt.held", { id: this.#held.id, reason: this.#held.reason, atWall: this.#held.atWall, from: "the volume" });
      this.page.halt(this.#held.reason, `held on the volume from before this operator (halt ${this.#held.id})`);
    }
  }

  /** Listen (the exit closed), link to the holder, and stand until the
   *  engine starts the page. Returns the proxy's and the RPC's ports. */
  async start(): Promise<{ proxyPort: number; rpcPort: number }> {
    this.#beat();
    this.#heartbeatTimer = setInterval(() => this.#beat(), this.#timings.heartbeatMs);
    const proxyPort = await this.egress.listen(this.config.proxyPort, this.config.proxyHost);
    const rpcPort = await this.rpc.listen(this.config.rpcPort, this.config.rpcHost);
    this.#stateTimer = setInterval(() => {
      if (this.#heldUnwritten) this.#writeHeld();
      // What the engine has not confirmed of the site's observations goes again.
      this.observer.resend();
      this.#sendState();
    }, this.#timings.stateEveryMs);
    this.buffer.start();
    void this.#linkHolder(true);
    this.#log("started", { proxyPort, rpcPort, bufferId: this.buffer.id, version: this.config.operatorVersion, publishCapture: this.publishCapture !== null });
    return { proxyPort, rpcPort };
  }

  /** SIGTERM: the exit closes; Chrome and CDP stay with the holder. The
   *  site's observations the engine has not confirmed live only in memory:
   *  a planned stop (an update, a rollback, `page.sh down`) waits for its
   *  word first, at most `observedDrainMs`. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.egress.closeExit("the operator stops");
    this.#endWork("the operator stops");
    this.#cancelRun();
    this.#clearRetry();
    this.#health.stop();
    this.#stopIpTimer();
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    if (this.#stateTimer) clearInterval(this.#stateTimer);
    await this.#drainObserved();
    this.sockets.close();
    this.site.close();
    this.cdp.close();
    await this.rpc.close();
    await this.egress.close();
    await this.buffer.close();
    await this.journals.close();
  }

  /** Until the engine (minor 6) confirmed what the observer keeps, its link
   *  went or `observedDrainMs` passed; what is left unconfirmed is logged. */
  async #drainObserved(): Promise<void> {
    const kept = this.observer.outbox.unconfirmed;
    if (kept === 0) return;
    const began = monoMs();
    const waiting = () => this.observer.outbox.unconfirmed > 0 && this.rpc.linkUp && this.rpc.engineMinor >= OBSERVED_ACK_MINOR;
    while (waiting() && monoMs() - began < this.#timings.observedDrainMs) {
      this.observer.resend();
      await sleep(OBSERVED_DRAIN_POLL_MS);
    }
    this.#log("stop.observed", { kept, unconfirmed: this.observer.outbox.unconfirmed, waitedMs: Math.round(monoMs() - began), linkUp: this.rpc.linkUp });
  }

  /** May a request get an admission now (PR 7, PR 9, PR 10)? Only with the
   *  engine heard within 5 s (plan §4.13), the exit open — the page at step
   *  7 or past it: the site loaded, the session confirmed, ready (plan
   *  §4.1) — and the buffer taking writes (plan §4.3). */
  admissionsOpen(): boolean {
    return this.rpc.linkUp && this.#siteNotUp() === null && this.buffer.refusal() === null;
  }

  /** Why the page takes none of the site's requests now (the exit closed,
   *  the page not up or halted), or null. */
  #siteNotUp(): string | null {
    if (!this.egress.exitOpen) return "the exit is closed";
    if (this.page.halted || !atLeast(this.page.step, "exit_open")) return `the page is not up (${this.page.halted ? "halted" : this.page.step})`;
    return null;
  }

  /** What runs in the page ends: Hub's requests, the site's, the socket's
   *  admissions and connections (the exit is closed already). */
  #endWork(note: string): void {
    // The session goes with the browser, and what was confirmed of it.
    this.#identity = null;
    this.hub.endAll(note);
    this.site.endAll(note);
    this.observer.reset(note);
    this.publishCapture?.reset();
    this.sockets.endAll(note);
  }

  get state(): State {
    const snapshot = this.page.snapshot;
    const selfTest = this.#selfTest;
    const notInstalled = selfTest ? (Object.entries(selfTest.checks).filter(([, check]) => check.status === "not_installed").map(([name]) => name) as SelfTestMechanism[]) : [];
    return {
      type: "state",
      step: snapshot.step,
      stopReason: snapshot.stopReason,
      retryAtWall: snapshot.retryAtWall,
      exitOpen: this.egress.exitOpen,
      mode: this.#mode,
      sessionFingerprint: this.hub.session.fingerprint,
      accountId: this.#identity !== null && this.#identity.fingerprint === this.hub.session.fingerprint ? this.#identity.accountId : null,
      exitIp: this.#exitIp,
      chromeVersion: this.#chromeVersion,
      operatorVersion: this.config.operatorVersion,
      buffer: this.#bufferState(),
      selfTest: selfTest ? { ok: selfTest.ok, atWall: selfTest.atWall, failed: selfTest.failed, ...(notInstalled.length > 0 ? { notInstalled } : {}) } : null,
      halt: this.#held === null ? null : { id: this.#held.id, reason: this.#held.reason, atWall: this.#held.atWall },
      lastClearedHaltId: this.#lastClearedId,
      hubSend: this.#hubSend(),
      crashDumps: this.#crashDumpsNow(),
      siteObserved: this.observer.outbox,
      egressFailures: this.egressFailures.snapshot(),
      // Minor 8: said only to an engine that knows it.
      ...(this.rpc.engineMinor >= WRITES_MINOR ? { publishing: this.hub.publishing } : {}),
    };
  }

  /** The page's sends as this operator saw them, for a Hub request's quiet
   *  (plan-b Б12): the last write to the API by the proxy's bytes, the last
   *  send of the site's own (CDP) and its socket's handshake; and a request
   *  of the site's own in flight. */
  #pageQuiet(): PageQuiet {
    const sends = [this.egress.gate.lastApiWriteMono, this.observer.lastSend?.mono ?? null, this.sockets.lastHandshake?.mono ?? null].filter((mono): mono is number => mono !== null);
    return { lastSendMono: sends.length === 0 ? null : Math.max(...sends), siteInFlight: this.observer.activeSince(monoMs() - SITE_QUIET_IN_FLIGHT_MS) > 0 };
  }

  /** A tunnel the page's SOCKS5 failed (egress/proxy.ts): counted; the page
   *  fails only when the proxy itself failed the site (its greeting or login
   *  on a tunnel to Fansly). A CONNECT dropped or refused on a tunnel to
   *  Fansly, or a third party's tunnel failing but by its destination's
   *  refusal, has the exit IP check run out of turn: a changed IP stops the
   *  page, one it cannot learn holds Hub's requests (#checkUpIp). A third
   *  party's destination refused: that tunnel's alone. */
  #onSocksFailure(failure: TunnelSocksFailure, message: string): void {
    this.egressFailures.socks(failure);
    if (!atLeast(this.page.step, "exit_open")) return;
    const fansly = FANSLY_CLASSES.has(failure.cls);
    if (fansly && failure.step !== "connect") {
      void this.#fail(failure.kind === "auth" ? "proxy_auth" : "proxy_unavailable", `the page's SOCKS5 failed a tunnel to ${failure.host}: ${message}`);
      return;
    }
    if (fansly || failure.kind !== "refused") this.#recheckProxy(`a tunnel to ${failure.host} (${failure.cls}) failed at its ${failure.step}: ${message}`);
  }

  /** The exit IP check out of turn, at most every `proxyRecheckMs` (none
   *  while one runs). */
  #recheckProxy(why: string): void {
    const now = monoMs();
    if (this.#ipChecking || now - this.#proxyRecheckMono < this.#timings.proxyRecheckMs) return;
    this.#proxyRecheckMono = now;
    this.#log("proxy.recheck", { why });
    void this.#periodicIpCheck();
  }

  /** Whether a Hub request can go now (minor 5): what a `send` would be
   *  answered, its route aside — and, blocked, since when the reason holds. */
  #hubSend(): NonNullable<State["hubSend"]> {
    const block = this.#hubSendBlock();
    if (block === null) {
      this.#hubBlocked = null;
      return { allowed: true, reason: null, sinceWall: null };
    }
    if (this.#hubBlocked?.reason !== block.reason) this.#hubBlocked = { reason: block.reason, sinceWall: block.sinceWall ?? wallMs() };
    return { allowed: false, reason: this.#hubBlocked.reason, sinceWall: this.#hubBlocked.sinceWall };
  }

  /** The first reason a Hub request is refused now (`HubSendBlock`, in its
   *  order), and when the transport's own began; null: none. The engine's
   *  link is no reason here: without it no state reaches the engine. */
  #hubSendBlock(): { reason: HubSendBlock; sinceWall: number | null } | null {
    const session = this.hub.session.sendBlock();
    if (session !== null && session.reason === "client_check") return session;
    if (this.#mode === "manual_login") return { reason: "manual_login", sinceWall: null };
    if (this.#siteNotUp() !== null) return { reason: "page_not_up", sinceWall: null };
    // An engine before minor 7 knows no `exit_ip_unknown` (it would refuse
    // the state): to it the page is not up for Hub's requests.
    if (this.#ipUnknown !== null) return { reason: this.rpc.engineMinor >= FAULTS_MINOR ? "exit_ip_unknown" : "page_not_up", sinceWall: this.#ipUnknown.sinceWall };
    if (this.buffer.refusal() !== null) return { reason: "buffer", sinceWall: null };
    if (!this.#siteInWorkTab()) return { reason: "site_not_loaded", sinceWall: null };
    return session;
  }

  /** Chrome's crash dumps as root last counted them (read at most every
   *  few seconds); null: none counted. */
  #crashDumpsNow(): NonNullable<State["crashDumps"]> | null {
    const path = this.config.crashDumpsPath ?? null;
    if (path === null) return null;
    const now = monoMs();
    if (now - this.#crashDumpsReadMono >= CRASH_DUMPS_READ_MS) {
      this.#crashDumpsReadMono = now;
      this.#crashDumps = readCrashDumps(path);
    }
    return this.#crashDumps;
  }

  /** A transition of the page's step, for Hub (minor 5): kept until the
   *  buffer has it. */
  #noteTransition(transition: Transition): void {
    const dumps = this.#crashDumpsNow();
    this.#transitions.push({
      event: {
        kind: "browser.transition",
        from: transition.from,
        to: transition.to,
        stopReason: transition.stopReason,
        halted: transition.halted,
        retryAtWall: transition.retryAtWall,
        note: transitionNote(transition.note),
        chromeVersion: this.#chromeVersion,
        operatorVersion: this.config.operatorVersion,
        crashDumps: dumps === null ? null : dumps.completed.count + dumps.pending.count,
      },
      at: { mono: monoMs(), wall: wallMs() },
    });
    if (this.#transitions.length > TRANSITIONS_KEPT) {
      this.#transitions.shift();
      this.#transitionsDropped += 1;
    }
    this.#flushTransitions();
  }

  /** The transitions kept, to the buffer in one commit — once it takes
   *  writes and the engine linked last reads them (minor 5). A commit that
   *  fails puts them back. */
  #flushTransitions(): void {
    if (this.#transitions.length === 0 || this.rpc.engineMinor < TRANSITIONS_MINOR || this.buffer.refusal() !== null) return;
    const taken = this.#transitions;
    const appended = this.buffer.appendGroup(taken.map(({ event, at }) => ({ event, at })));
    if (!appended.ok) return;
    this.#transitions = [];
    if (this.#transitionsDropped > 0) {
      this.#log("transitions.dropped", { dropped: this.#transitionsDropped, kept: TRANSITIONS_KEPT });
      this.#transitionsDropped = 0;
    }
    void appended.durable.then((durable) => {
      if (durable.ok) return;
      this.#transitions = [...taken, ...this.#transitions].slice(-TRANSITIONS_KEPT);
      this.#log("transitions.unwritten", { reason: durable.reason, kept: this.#transitions.length });
    });
  }

  /** The halt held for the owner's decision (null: none). */
  get heldHalt(): HeldHalt | null {
    return this.#held;
  }

  get lastSelfTest(): SelfTestResult | null {
    return this.#selfTest;
  }

  // ── the holder ─────────────────────────────────────────────────────────

  async #linkHolder(first: boolean): Promise<void> {
    if (this.#linking) return;
    this.#linking = true;
    try {
      while (!this.#stopped) {
        let link: HolderLink;
        try {
          link = await this.cdp.connect();
          this.#holderStopping = false;
          this.#holderSpent = false;
        } catch {
          await sleep(this.#timings.holderRelinkMs);
          continue;
        }
        this.#log("holder.linked", { cdpUp: link.cdpUp, stored: link.stored, lastSeq: link.lastSeq });
        // A new CDP link: Chrome's clock is calibrated anew for its sessions.
        this.sockets.clocksInvalidated("a new link to the CDP holder");
        // What the holder kept from before this instance is handled first:
        // paused requests among it are failed (cdp/paused.ts), and Chrome
        // has answered that before anything else is decided.
        const replayDeadline = Date.now() + this.#timings.replayWaitMs;
        await Promise.race([this.cdp.replayEnded, sleep(this.#timings.replayWaitMs)]);
        await this.#waitUntil(() => this.paused.resolving === 0, Math.max(0, replayDeadline - Date.now()));
        if (first && link.cdpUp && !this.#controlExpected && !this.#starting) {
          // A previous instance's Chrome: this one does not know its targets.
          // The page stands until the engine starts it again.
          this.#log("chrome.from_previous_instance", { action: "killed" });
          this.egress.closeExit("a Chrome from before this operator");
          await this.#withChrome(() => this.chrome.kill()).catch((error: unknown) => this.#log("chrome.kill_failed", { error: errorMessage(error) }));
        }
        // The link may have gone during the replay or the cleanup; its loss
        // could not start another link while this one ran: link again.
        if (!this.cdp.linked) continue;
        if (!this.#socketsRestarted) {
          // What the holder kept of the site's socket from before is behind
          // (dropped); the gap of this start and the end of the connections
          // the buffer kept from before go in one commit, tried until
          // durable (plan §4.4, step 6).
          this.#socketsRestarted = true;
          await this.sockets.afterRestart();
          // The site requests the previous operator admitted end too.
          this.site.afterRestart();
        }
        return;
      }
    } finally {
      this.#linking = false;
    }
  }

  /** Control of Chrome is gone, or cannot be trusted: the exit closes at
   *  once; if the operator was running Chrome, that is a failure. */
  #controlLost(reason: "cdp_lost" | "holder_overflow", detail: string): void {
    const exitWasOpen = this.egress.exitOpen;
    const gate = this.egress.gate.state;
    this.egress.closeExit(`control lost: ${detail}`);
    this.#endWork(`control lost: ${detail}`);
    if (!this.#controlExpected) {
      this.#log("control.closed", { detail });
      return;
    }
    // Owner decision №10's fallback (stage 1, amendment 29): Chrome lets go of
    // every held request when it loses CDP. With the exit open, one it let
    // go by itself may have left (through a plain tunnel, or in a window of
    // the gate) — the alarm says so until a send is proven the admitted one.
    this.#alarm(reason === "holder_overflow" ? "overflow" : "cdp_lost", {
      detail,
      exitOpenAtLoss: exitWasOpen,
      gatePhaseAtLoss: gate.phase,
      foreignRequestMayHaveLeft: exitWasOpen,
    });
    void this.#fail(reason, `control lost: ${detail}`);
  }

  // ── the start (plan §4.1) ─────────────────────────────────────────────

  /** A start, remembered until it ends (a new owner waits for it). */
  #launch(fresh: boolean, note: string): Promise<void> {
    const done = this.#startRun(fresh, note);
    this.#runDone = done;
    return done;
  }

  async #startRun(fresh: boolean, note: string): Promise<void> {
    if (this.#stopped || (!fresh && this.page.halted)) return;
    // No start while a halt is held for the owner — but his login's of a
    // browser Fansly signed out.
    const refused = this.#heldRefusal();
    if (refused !== null) {
      this.#log("start.refused", { why: refused });
      if (!this.page.halted) this.page.halt(this.#held!.reason, refused);
      return;
    }
    this.#clearRetry();
    const run = ++this.#run;
    this.#starting = true;
    const check = () => {
      if (run !== this.#run || this.#stopped) throw new Cancelled();
    };
    this.egress.closeExit("a start");
    this.#endWork("a new start of the page");
    this.#siteReloaded = false;
    this.#health.stop();
    this.#stopIpTimer();
    this.page.beginStart(note, fresh);
    try {
      // Nothing may pass unrecorded: the buffer must be written and have
      // room (spec §5). The diagnostic journals are not waited for: their
      // trouble alarms (#onJournalTrouble).
      const room = await this.buffer.ready();
      if (!room.ok) throw new StartFailure(room.reason, `the buffer takes no writes: ${room.detail}`);
      check();
      // A Chrome that runs now is a previous start's or nobody's: the page
      // starts with a fresh one.
      await this.#withChrome(async () => {
        if (await this.chrome.isUp()) await this.#stopChrome("a start begins with a fresh Chrome");
        // No Chrome now: nothing it held can go any more.
        this.egress.gate.browserGone();
      });
      check();
      if (!(await this.#waitUntil(() => !this.cdp.cdpUp, 3000))) throw new StartFailure("cdp_lost", "the holder still holds the previous Chrome");
      check();
      // The holder of the previous Chrome exits after it (s6 starts a fresh
      // one): the start goes on with the fresh holder, so the old link's
      // close is not taken for a lost control of the new Chrome — which
      // made every restart of a running page fail once.
      if (!(await this.#waitUntil(() => !this.#holderSpent && this.cdp.linked, 3000))) throw new StartFailure("cdp_lost", "the holder of the previous Chrome did not go");
      check();
      // Step 2: the page's environment for this Chrome (it takes it when it
      // starts), from the engine's last hello.
      const env = this.#settings?.env;
      if (!env) throw new StartFailure("env_mismatch", "no environment of the page from the engine yet");
      try {
        writeHandover(this.config.chromeEnvPath, env);
      } catch (error) {
        throw new StartFailure("env_mismatch", `the page's environment could not be handed to Chrome: ${errorMessage(error)}`);
      }
      let geometry: XGeometry;
      try { geometry = await this.#display(); }
      catch { throw new StartFailure("env_mismatch", "cannot read the X screen before Chrome starts; inspect the container's X server"); }
      check();
      // The X server's screen is the page's (PB_SCREEN; plan §3.1), unless
      // someone changed it: the site works in any size of window, so a
      // different one is alarmed and the start goes on.
      const screen = this.config.screen ?? SCREEN;
      const matches = geometry.width === screen.width && geometry.height === screen.height && geometry.depth === 24;
      this.#log("x.geometry", { ...geometry, expected: { ...screen, depth: 24 }, matches });
      if (!matches) this.#screenAlarm("x_server", `${geometry.width}×${geometry.height}×${geometry.depth}`, `${screen.width}×${screen.height}×24`);
      this.page.advance("env_applied", describeEnv(env));
      await this.#withChrome(async () => {
        check();
        this.control.reset();
        this.guard.reset();
        // A connection of the previous Chrome is gone (plan §4.4, step 6),
        // and so is its holder.
        await this.sockets.chromeStarting();
        this.#controlExpected = true;
        await this.chrome.start();
      });
      check();
      if (!(await this.#waitUntil(() => this.cdp.cdpUp, this.#timings.chromeUpMs))) {
        throw new StartFailure((await this.chrome.isUp()) ? "cdp_lost" : "chrome_crashed", "Chrome's DevTools connection did not come up");
      }
      check();
      this.page.advance("chrome_started");
      await this.control.attach(this.#timings.attachMs);
      this.#chromeVersion = await this.control.version();
      check();
      // What the browser shows is the page's environment (plan §4.1, step
      // 2), after every start: a restarted or updated Chrome included.
      const shown = await this.envCheck.run(env, this.#timings.envCheckMs);
      check();
      this.#log(shown.ok ? "env.verified" : "env.mismatch", { durationMs: shown.durationMs, seen: shown.seen, mismatches: shown.mismatches });
      // The screen as Chrome shows it: alarmed, never a stop (above).
      if (shown.seen && (shown.seen.screen.width !== screen.width || shown.seen.screen.height !== screen.height)) {
        this.#screenAlarm("chrome", `${shown.seen.screen.width}×${shown.seen.screen.height}`, `${screen.width}×${screen.height}`);
      }
      if (!shown.ok) throw new StartFailure("env_mismatch", `the browser does not show the page's environment: ${shown.mismatches.join("; ")}`);
      this.page.advance("control_attached", `${this.#chromeVersion}; environment verified: ${describeEnv(env)}`);
      this.#health.start();
      const result = await this.#selfTestNow();
      check();
      if (!result.ok) throw new StartFailure("selftest_failed", `the self-test failed: ${result.failed ?? "?"}`);
      this.page.advance("selftest_passed", `in ${result.durationMs} ms`);
      const ip = await this.#verifyExitIp();
      check();
      this.page.advance("exit_ip_verified", ip);
      if (this.#exitHeld) this.#log("exit.held", { note: "the engine's closeExit: the start stops short of opening it" });
      else this.#openExit();
    } catch (error) {
      if (error instanceof Cancelled || run !== this.#run) return;
      const failure = error instanceof StartFailure ? error : new StartFailure("cdp_lost", errorMessage(error));
      if (failure.reason === "exit_ip_changed") await this.#halt(failure.reason, failure.message, "stop");
      else await this.#fail(failure.reason, failure.message);
    } finally {
      if (run === this.#run) this.#starting = false;
    }
  }

  #openExit(): void {
    if (this.#holderStopping) {
      this.#log("exit.kept_closed", { why: "the holder is stopping" });
      return;
    }
    this.egress.openExit();
    this.page.advance("exit_open");
    this.#armIpTimer();
    void this.#loadSite(this.#run);
  }

  // ── the site (plan §4.1, steps 8–10) ──────────────────────────────────

  /** Step 8: the work tab loads the site. Its document goes as any page of
   *  the site does (intercept/site.ts); its API requests by the engine's
   *  admission. A site that does not load fails the start. */
  async #loadSite(run: number): Promise<void> {
    const stale = () => run !== this.#run || this.#stopped || this.page.halted || this.page.step !== "exit_open" || !this.egress.exitOpen;
    const mode = this.#modeChanges;
    try {
      const tab = this.control.workTab;
      if (tab === null) throw new StartFailure("cdp_lost", "no work tab to load the site in");
      // What fails of the site from here to the session's confirmation
      // decides whether the tab is loaded anew then.
      this.site.resetFailures();
      const documents = () => this.site.documents.commits(this.control.workTab?.mainFrameId ?? null);
      const before = documents();
      const reply = await this.cdp.send<{ errorText?: string; loaderId?: string }>("Page.navigate", { url: SITE_URL }, tab.sessionId, this.#timings.siteLoadMs);
      if (stale()) return;
      if (typeof reply.errorText === "string" && reply.errorText !== "") throw new StartFailure("proxy_unavailable", `the site did not load: ${reply.errorText}`);
      // The document of a navigation started in this mode, as Chrome names it.
      if (mode === this.#modeChanges && typeof reply.loaderId === "string" && reply.loaderId !== "") {
        this.#modeDocument = { mode, loaderId: reply.loaderId };
        // Its GET may have come before this answer was taken.
        const shown = this.#sessionsShown.get(reply.loaderId);
        if (shown !== undefined) this.#documentShowedSession(reply.loaderId, shown);
      }
      // Its document, not the one the tab had: a new one committed.
      const atSite = await this.#waitUntil(() => stale() || (this.#workTabAtSite() && documents() > before), this.#timings.siteLoadMs);
      if (stale()) return;
      if (!atSite) throw new StartFailure("proxy_unavailable", `the site's document did not come within ${this.#timings.siteLoadMs} ms`);
      if (mode === this.#modeChanges) this.#modeDocumentLoadedMono = monoMs();
      this.page.advance("site_loaded", SITE_URL);
      if (mode !== this.#modeChanges && this.#reloadsForMode()) {
        // Its load began under the mode before: loaded anew for this one,
        // once it is in (Astra's review of PR 16, round 3) — a mode change
        // during a load finds no loaded page to reload. A live page under
        // variant Б is not (#reloadsForMode): confirmed as it is.
        this.#reloadForMode("the site loaded under the mode before: it is loaded anew for this one");
        return;
      }
      this.#confirmSession();
    } catch (error) {
      if (stale()) return;
      const failure = error instanceof StartFailure ? error : new StartFailure("proxy_unavailable", `the site did not load: ${errorMessage(error)}`);
      await this.#fail(failure.reason, failure.message);
    }
  }

  #workTabAtSite(): boolean {
    const url = this.control.workTab?.url ?? "";
    try {
      return new URL(url).origin === SITE_ORIGIN;
    } catch {
      return false;
    }
  }

  /** Steps 9–10: the session is confirmed once the engine's identity read
   *  under the live session named the expected account; the page is ready
   *  then. */
  #confirmSession(): void {
    // In the manual login the page is never ready: a person is in it (plan
    // §4.8), and its session is confirmed once the automation is back.
    if (this.#mode === "manual_login") return;
    const identity = this.#identity;
    const live = this.hub.session.fingerprint;
    if (this.page.step !== "site_loaded" || identity === null || live === null || identity.fingerprint !== live) return;
    if (!this.#identityConfirms(identity)) {
      this.#loadAnewIfSessionUnseen();
      return;
    }
    if (this.#reloadPending) return;
    const failed = this.site.failures;
    if (failed > 0 && !this.#siteReloaded) {
      // The site's document saw its API requests fail before the engine
      // admitted any: it starts again under the confirmed session.
      this.#reloadPending = true;
      void this.#reloadSite(this.#run, failed);
      return;
    }
    this.page.advance("session_confirmed", "the engine's identity read named the expected account");
    // Fansly signed the browser out; the owner logged in; the expected
    // account is confirmed now: that halt is over.
    const held = this.#held;
    if (held !== null && held.reason === LOGIN_DECIDES && this.#loginForHalt === held.id) this.#clearHeld("the expected account confirmed after the owner's login");
    this.page.advance("ready");
  }

  /** Whether the identity read confirms the session: a page's, when it names
   *  the page's account; a profile's no page has yet (page 0, its
   *  onboarding), whatever account it names — but, once the mode changed,
   *  only under the session the site showed in a document loaded after the
   *  change (PR 16, Astra's round 2). */
  #identityConfirms(identity: { accountId: string; fingerprint: string }): boolean {
    const settings = this.#settings;
    if (settings === null) return false;
    if (settings.pageId !== 0) return identity.accountId === settings.expectedAccountId;
    if (this.#modeChanges === 0) return true;
    const document = this.#modeDocument;
    const shown = this.#sessionShownInMode;
    return document !== null && document.mode === this.#modeChanges
      && this.site.documents.currentLoader(this.control.workTab?.mainFrameId ?? null) === document.loaderId
      && shown !== null && shown.loaderId === document.loaderId && shown.fingerprint === identity.fingerprint;
  }

  /** Page 0: an identity read that cannot be confirmed because the
   *  operator never saw the session of the mode's document — current, at the
   *  site for `sessionShowWaitMs` — loads the site anew, once that document:
   *  the next document's GET shows its session (nothing waits for a GET that
   *  may never come). */
  #loadAnewIfSessionUnseen(): void {
    const document = this.#modeDocument;
    const loaded = this.#modeDocumentLoadedMono;
    if (this.#settings?.pageId !== 0 || this.#modeChanges === 0 || document === null || document.mode !== this.#modeChanges || loaded === null) return;
    if (this.site.documents.currentLoader(this.control.workTab?.mainFrameId ?? null) !== document.loaderId) return;
    if (this.#sessionShownInMode?.loaderId === document.loaderId || this.#loadedAnewFor === document.loaderId) return;
    if (monoMs() - loaded < this.#timings.sessionShowWaitMs) return;
    this.#loadedAnewFor = document.loaderId;
    this.#reloadForMode("the session of the document loaded for the mode was never seen: the site is loaded anew, once");
  }

  /** The site's own API request, as it stopped: a GET with its session in
   *  the automation shows the session that exists now — when it is of the
   *  document the operator loaded in this mode (its loader; page 0's
   *  confirmation, `#identityConfirms`). A request of any other document
   *  feeds nothing of it (the session's headers follow PR 15's rules). */
  /** The live session from a request of the site's own (paused, or observed
   *  as it left): only the work tab's current document supplies Hub's
   *  headers — unknown loaders keep their old behaviour, unless the tracker
   *  already knows the request's document was replaced. */
  #noteSiteSession(request: PausedRequest): void {
    const documents = this.site.documents;
    const loader = documents.loaderOfRequest(request.networkId);
    const current = documents.currentLoader(this.control.workTab?.mainFrameId ?? null);
    if ((loader === null || loader === current) && !documents.replaced(documents.mark(request))) {
      this.hub.noteSiteRequest(request);
    }
    this.#siteShowedSession(request);
  }

  #siteShowedSession(request: { networkId: string | null; frameId: string | null; method: string; headers: Record<string, string> }): void {
    if (this.#mode !== "automation" || request.method.toUpperCase() !== "GET" || request.networkId === null) return;
    // The top frame's documents only: a child frame's is never the mode's.
    const top = this.control.workTab?.mainFrameId ?? null;
    if (top === null || request.frameId !== top) return;
    const value = (name: string) => Object.entries(request.headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? "";
    const authorization = value("authorization");
    if (authorization === "") return;
    const fingerprint = sessionFingerprint(authorization, value("fansly-client-id"));
    const loader = this.site.documents.loaderOfRequest(request.networkId);
    if (loader === null) {
      this.#sessionNoteWaiting = { networkId: request.networkId, fingerprint };
      return;
    }
    this.#sessionShownBy(loader, fingerprint);
  }

  /** A GET of the document `loaderId` showed `fingerprint` in this mode:
   *  kept for that document (its navigation's answer may still be on the
   *  way), and judged now. */
  #sessionShownBy(loaderId: string, fingerprint: string): void {
    if (this.#mode !== "automation") return;
    this.#sessionsShown.delete(loaderId);
    this.#sessionsShown.set(loaderId, fingerprint);
    if (this.#sessionsShown.size > 8) {
      // The oldest but the frame's current document (its navigation's answer
      // may still be on the way) and the mode's.
      const keep = new Set([this.site.documents.currentLoader(this.control.workTab?.mainFrameId ?? null), this.#modeDocument?.loaderId ?? null]);
      const oldest = [...this.#sessionsShown.keys()].find((loader) => !keep.has(loader));
      if (oldest !== undefined) this.#sessionsShown.delete(oldest);
    }
    this.#documentShowedSession(loaderId, fingerprint);
  }

  #documentShowedSession(loaderId: string, fingerprint: string): void {
    const document = this.#modeDocument;
    if (this.#mode !== "automation" || document === null || document.mode !== this.#modeChanges || document.loaderId !== loaderId) return;
    const shown = this.#sessionShownInMode;
    if (shown !== null && shown.loaderId === loaderId && shown.fingerprint === fingerprint) return;
    this.#sessionShownInMode = { fingerprint, loaderId };
    this.#confirmSession();
    this.#sendState();
  }

  /** The work tab loaded anew at the session's confirmation, once a start:
   *  what of the site is in flight is waited out (a request cancelled by
   *  the reload would stop the page), what still waits is closed, then the
   *  tab navigates as at step 8 — and is confirmed and ready with its new
   *  document. */
  async #reloadSite(run: number, failed: number): Promise<void> {
    const stale = () => run !== this.#run || this.#stopped || this.page.halted || this.page.step !== "site_loaded" || !this.egress.exitOpen;
    try {
      const idle = await this.#waitUntil(() => stale() || this.site.released === 0, this.#timings.reloadWaitMs);
      if (stale()) return;
      if (!idle) {
        // Never while a request of the site is in flight: confirmed as it is.
        this.#log("site.reload_skipped", { failed, released: this.site.released });
        this.page.advance("session_confirmed", "the engine's identity read named the expected account; not loaded anew: a request of the site stayed in flight");
        this.page.advance("ready");
        return;
      }
      this.#siteReloaded = true;
      this.site.reloading(this.control.workTab?.mainFrameId ?? null);
      this.#log("site.reload", { failed });
      this.page.back("exit_open", `the session is confirmed; ${failed} API request${failed === 1 ? "" : "s"} of the site failed before it, none sent: the work tab is loaded anew, once`);
      // From here it is a load like step 8's: confirmed again when it is in.
      this.#reloadPending = false;
      await this.#loadSite(run);
    } finally {
      this.#reloadPending = false;
    }
  }

  /** A whole answer of the engine's identity read (hub-requests/): its
   *  account id, read from the body and nothing else of it kept. A read sent
   *  before the last change of the mode (or whose send is not known since
   *  then) names nothing: it is from before the person's login. Both
   *  instants are this process's own clock — the gate's first bytes, never
   *  Chrome's timing, which may run on another base. */
  #onIdentity(answer: { fingerprint: string; status: number; bodyId: string; bytes: number; gateSentMono: number | null }): void {
    try {
      if (this.#mode === "manual_login") return;
      if (this.#identityFloorMono > Number.NEGATIVE_INFINITY && (answer.gateSentMono === null || answer.gateSentMono < this.#identityFloorMono)) {
        this.#log("session.identity_stale", { why: "sent before the mode last changed" });
        return;
      }
      if (answer.status !== 200 || answer.bytes > IDENTITY_BODY_MAX) return;
      const body = this.buffer.readBody(answer.bodyId, 0, Math.max(1, answer.bytes));
      if (body === null) return;
      const id = (JSON.parse(body.toString("utf8")) as { response?: { account?: { id?: unknown } } }).response?.account?.id;
      if (typeof id !== "string" || id === "") return;
      this.#identity = { accountId: id, fingerprint: answer.fingerprint };
      const expected = this.#settings?.expectedAccountId ?? null;
      this.#log(id === expected ? "session.confirmed" : "session.other_account", { matches: id === expected });
      this.#confirmSession();
      this.#sendState();
    } catch (error) {
      this.#log("session.identity_unread", { error: errorMessage(error) });
    }
  }

  /** The live session changed (a login, a new session, a new browser): a
   *  confirmation of another one no longer stands. */
  #onSessionChanged(fingerprint: string | null): void {
    if (this.#identity !== null && this.#identity.fingerprint !== fingerprint && atLeast(this.page.step, "session_confirmed")) {
      this.page.back("site_loaded", "the site's live session changed: it is confirmed again");
    }
    this.#sendState();
    // A socket that opened before the session was known opens in the
    // stream now.
    if (fingerprint !== null) this.sockets.sessionKnown();
  }

  async #selfTestNow(): Promise<SelfTestResult> {
    if (this.egress.exitOpen) throw new Error("the self-test runs only with the exit closed");
    const result = await runSelfTest({
      probe: (kind, method, path, marker, deadline) => this.probes.probe(kind, method, path, marker, deadline),
      closedExitRefusalsSince: (since) => this.egress.refusalsSince(this.#apiHost, 443, since).filter((record) => record.result === "refused: exit closed").length,
      readKernelResult: () => JSON.parse(readFileSync(this.config.netSelftestPath, "utf8")) as unknown,
      extension: this.#extension,
      maxMs: this.#params.selfTestMaxMs,
      probeMs: this.#timings.selfTestProbeMs,
    });
    this.#selfTest = result;
    this.#log("selftest", {
      ok: result.ok,
      failed: result.failed,
      durationMs: result.durationMs,
      checks: Object.fromEntries(Object.entries(result.checks).map(([name, check]) => [name, `${check.status}: ${check.detail}`])),
    });
    if (!result.ok && result.failed) this.#alarm("selftest_failed", { failed: result.failed, detail: result.checks[result.failed].detail });
    this.#sendState();
    return result;
  }

  async #verifyExitIp(): Promise<string> {
    const settings = this.#settings;
    if (!settings) throw new StartFailure("proxy_unavailable", "no SOCKS5 of the page from the engine yet");
    let ip: string;
    try {
      ip = await checkExitIp(settings.socks, this.#exitIpTarget, this.#timings.exitIpTimeoutMs);
    } catch (error) {
      if (error instanceof SocksError && error.kind === "auth") throw new StartFailure("proxy_auth", "the page's SOCKS5 refused the login");
      throw new StartFailure("proxy_unavailable", `the exit IP check failed: ${errorMessage(error)}`);
    }
    if (ip !== settings.pinnedExitIp) throw new StartFailure("exit_ip_changed", `the exit IP ${ip} is not the pinned ${settings.pinnedExitIp}`);
    this.#exitIp = ip;
    return ip;
  }

  /** The exit opened: its IP is checked again in `exitIpCheckMs` (hourly). */
  #armIpTimer(): void {
    this.#scheduleIpCheck(this.#params.exitIpCheckMs);
  }

  #scheduleIpCheck(delayMs: number): void {
    if (this.#ipTimer) clearTimeout(this.#ipTimer);
    this.#ipTimer = setTimeout(() => void this.#periodicIpCheck(), delayMs);
  }

  /** No more checks of this run's exit IP: the page goes down, starts anew,
   *  or its exit closes. An unknown IP ends with it — the next opening of
   *  the exit checks it strictly. */
  #stopIpTimer(): void {
    if (this.#ipTimer) clearTimeout(this.#ipTimer);
    this.#ipTimer = null;
    this.#ipUnknown = null;
  }

  /** Hourly while the exit is open (plan §4.5), out of turn after a failed
   *  tunnel, and on the restart backoff while the IP is unknown; each check
   *  sets the next (#checkUpIp). One at a time: a check that comes while
   *  another runs is that one's. */
  async #periodicIpCheck(): Promise<void> {
    if (this.#ipChecking || !atLeast(this.page.step, "exit_open")) return;
    this.#ipChecking = true;
    try {
      await this.#checkUpIp();
    } finally {
      this.#ipChecking = false;
    }
  }

  /** The exit IP of a page that is up (plan §4.5). The pinned one: Hub's
   *  requests go (again, after an unknown IP), and the next check is in
   *  `exitIpCheckMs`. Another one: the page stops until the owner decides.
   *  No answer the check can judge — a timeout, ipify not reached or not
   *  answering an address, the SOCKS5 failing the check's own tunnel or
   *  login — says nothing of the IP, and stopping Chrome for it would not
   *  change what Fansly saw: Hub's requests are held (#siteNotReady), the
   *  engine is alarmed once (minor 7), Chrome and the site go on, and the
   *  check is tried again after the restart backoff (10 s, 30 s, 2 min, then
   *  every 5 min) — until `exitIpUnknownMaxMs` (30 min) without a break, when
   *  the page fails as before (`proxy_unavailable`; EXIT_IP_UNKNOWN_MAX_MS).
   *  A proxy that is down indeed fails the page by the site's own tunnels
   *  (#onSocksFailure). */
  async #checkUpIp(): Promise<{ kind: "pinned"; ip: string } | { kind: "unknown" | "changed" | "failed"; why: string } | { kind: "superseded" }> {
    const run = this.#run;
    let ip: string;
    try {
      ip = await this.#verifyExitIp();
    } catch (error) {
      if (run !== this.#run || !atLeast(this.page.step, "exit_open")) return { kind: "superseded" };
      const failure = error instanceof StartFailure ? error : new StartFailure("proxy_unavailable", errorMessage(error));
      if (failure.reason === "exit_ip_changed") {
        await this.#halt(failure.reason, failure.message, "stop");
        return { kind: "changed", why: failure.message };
      }
      const held = this.#exitIpUnknown(failure.message);
      if (held) return { kind: "unknown", why: failure.message };
      const why = `the exit IP stayed unknown past ${Math.round(this.#timings.exitIpUnknownMaxMs / 1000)} s: ${failure.message}`;
      await this.#fail("proxy_unavailable", why);
      return { kind: "failed", why };
    }
    if (run !== this.#run || !atLeast(this.page.step, "exit_open")) return { kind: "superseded" };
    const was = this.#ipUnknown;
    this.#ipUnknown = null;
    if (was !== null) {
      const note = `the exit IP is the pinned one again after ${was.failures} check(s) without an answer: Hub's requests go`;
      this.#log("exit_ip.known", { failures: was.failures, sinceWall: was.sinceWall });
      this.#journalNote(note);
      this.#sendState();
    }
    this.#armIpTimer();
    return { kind: "pinned", ip };
  }

  /** A check of the page that is up got no answer it can judge (#checkUpIp):
   *  true — Hub's requests are held and the check is tried again; false —
   *  the IP has been unknown for `exitIpUnknownMaxMs` without a break, and
   *  the page is to fail as before (EXIT_IP_UNKNOWN_MAX_MS says why). The
   *  last retry falls on that bound, not past it. */
  #exitIpUnknown(why: string): boolean {
    const was = this.#ipUnknown;
    const now = monoMs();
    const failures = (was?.failures ?? 0) + 1;
    const sinceMono = was?.sinceMono ?? now;
    this.#ipUnknown = { sinceWall: was?.sinceWall ?? wallMs(), sinceMono, failures, why };
    const left = this.#timings.exitIpUnknownMaxMs - (now - sinceMono);
    if (left <= 0) {
      this.#log("exit_ip.unknown_too_long", { failures, why, unknownForMs: Math.round(now - sinceMono) });
      return false;
    }
    const ladder = this.#params.restartBackoffMs.length > 0 ? this.#params.restartBackoffMs : RESTART_BACKOFF_MS;
    const retryMs = Math.min(restartDelayMs(failures, ladder), left);
    this.#log("exit_ip.unknown", { failures, why, retryMs });
    this.#scheduleIpCheck(retryMs);
    if (was !== null) return true;
    this.#journalNote(`the exit IP is unknown, its check got no answer (${why}): Hub's requests are held, Chrome and the site go on`);
    this.#alarm("exit_ip_unknown", { why: maskIps(why), hubHeld: true, retryInMs: retryMs });
    this.#sendState();
    return true;
  }

  /** A line of the states journal that is no transition (the page's step
   *  stays). */
  #journalNote(note: string): void {
    const snapshot = this.page.snapshot;
    this.journals.state({ from: snapshot.step, to: snapshot.step, stopReason: snapshot.stopReason, retryAtWall: snapshot.retryAtWall, halted: snapshot.halted, note });
  }

  /** A diagnostic journal fell behind the disk or failed to write (logs/):
   *  its lines are dropped and counted meanwhile, and a gap line says how
   *  many once it writes again. The engine is alarmed (minor 7), at most
   *  every few minutes; the page goes on. */
  #onJournalTrouble(trouble: JournalTrouble): void {
    this.#log("journal.trouble", { kind: trouble.kind, reason: trouble.reason, dropped: trouble.dropped, errors: trouble.errors });
    const now = monoMs();
    if (now - this.#journalAlarmMono < JOURNAL_ALARM_EVERY_MS) return;
    this.#journalAlarmMono = now;
    this.#alarm("journal", { journal: trouble.kind, reason: trouble.reason, droppedLines: trouble.dropped, writeErrors: trouble.errors });
  }

  /** The screen is not the page's (`source`: the X server's geometry, or
   *  what Chrome shows): alarmed, the start goes on (minor 7). */
  #screenAlarm(source: "x_server" | "chrome", seen: string, expected: string): void {
    this.#journalNote(`the screen (${source}) is ${seen}, not ${expected}: the start goes on`);
    this.#alarm("env_mismatch", { screen: source, seen, expected });
  }

  // ── failures and stops ─────────────────────────────────────────────────

  #cancelRun(): void {
    this.#run += 1;
    this.#starting = false;
  }

  #clearRetry(): void {
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  /** End whatever start runs, kill its Chrome, and let the page stand with
   *  the exit closed until the engine starts it. */
  async #stand(note: string): Promise<void> {
    this.egress.closeExit(note);
    this.#endWork(note);
    this.#cancelRun();
    const run = this.#run;
    this.#clearRetry();
    this.#health.stop();
    this.#stopIpTimer();
    await this.#runDone;
    // A newer start that began meanwhile has the browser: nothing of it is
    // touched here (it stops whatever Chrome it finds itself).
    if (run !== this.#run) return;
    this.#controlExpected = false;
    await this.#withChrome(async () => {
      if (run !== this.#run) return;
      await this.chrome.kill();
      this.egress.gate.browserGone();
    }).catch((error: unknown) => this.#log("chrome.kill_failed", { error: errorMessage(error) }));
    if (run !== this.#run) return;
    this.control.reset();
    if (this.#held !== null) this.page.halt(this.#held.reason, `${note}; halt ${this.#held.id} held`);
    else this.page.stand(note);
  }

  /** A failure: the exit closes, Chrome gets a bounded profile-writing quit
   *  and then a kill if needed. Nothing of it is released meanwhile. The
   *  start is tried again after the backoff, after that Chrome is down. */
  async #fail(reason: StopReason, note: string): Promise<void> {
    this.egress.closeExit(note);
    this.#endWork(note);
    if (this.page.halted || this.#stopped) return;
    this.#cancelRun();
    const run = this.#run;
    this.#clearRetry();
    this.#health.stop();
    this.#stopIpTimer();
    const wasControlled = this.#controlExpected;
    this.#controlExpected = false;
    let why = reason;
    if (why === "cdp_lost" && wasControlled && !(await this.chrome.isUp().catch(() => true))) why = "chrome_crashed";
    if (run !== this.#run) return;
    const retryAtWall = this.page.fail(why, note);
    await this.#withChrome(async () => {
      if (run !== this.#run) return;
      await quitChromeAfterFailure(this.cdp, this.chrome, this.#timings.failureQuitMs, this.#log);
      this.egress.gate.browserGone();
    }).catch((error: unknown) => this.#log("chrome.kill_failed", { error: errorMessage(error) }));
    if (run !== this.#run || this.#stopped) return; // a newer start took over meanwhile
    this.control.reset();
    this.#retryTimer = setTimeout(() => void this.#launch(false, `a retry after ${why}`), Math.max(0, retryAtWall - Date.now()));
  }

  /** A stop that holds until the engine's restartBrowser. `stop`: Chrome
   *  quits as on a user's quit (its profile is written); `kill`: at once. */
  async #halt(reason: StopReason, note: string, how: "stop" | "kill"): Promise<void> {
    this.egress.closeExit(note);
    // Fansly signed the browser out: Hub's writes stop with it, the withdraw
    // too, until the engine records it as the page's autostop (spec §8.3).
    if (reason === "login_required") this.hub.stopPublishing("login_lost", note);
    // The owner's to decide: held on the volume before the browser stops.
    if (heldForTheOwner(reason)) this.#hold(reason, note);
    this.#endWork(note);
    this.#cancelRun();
    const run = this.#run;
    this.#clearRetry();
    this.#health.stop();
    this.#stopIpTimer();
    this.page.halt(heldForTheOwner(reason) && this.#held !== null ? this.#held.reason : reason, note);
    this.#controlExpected = false;
    try {
      await this.#withChrome(async () => {
        await (how === "stop" ? this.#stopChrome(note) : this.chrome.kill());
        this.egress.gate.browserGone();
      });
    } catch (error) {
      this.#log("chrome.stop_failed", { error: errorMessage(error) });
    }
    if (run === this.#run) this.control.reset();
  }

  // ── the held halt (Astra round 3) ──────────────────────────────────────

  /** Hold a halt for the owner's decision: the stricter one holds (any but
   *  `login_required` replaces a held `login_required`, never the reverse;
   *  else the first stands). In memory at once — every start is refused from
   *  here — and on the volume. */
  #hold(reason: StopReason, note: string): void {
    if (!replacesHeld(this.#held?.reason ?? null, reason)) {
      this.#log("halt.kept", { id: this.#held!.id, held: this.#held!.reason, also: reason });
      return;
    }
    this.#held = newHalt(reason);
    this.#loginForHalt = null;
    this.#log("halt.held", { id: this.#held.id, reason, note });
    this.#writeHeld();
  }

  /** The held halt to the volume; a failed write is tried again with every
   *  state (in memory it holds meanwhile). */
  #writeHeld(): boolean {
    try {
      this.#haltStore.write({ halt: this.#held, lastClearedId: this.#lastClearedId });
      if (this.#heldUnwritten) this.#log("halt.written", { id: this.#held?.id ?? null });
      this.#heldUnwritten = false;
      return true;
    } catch (error) {
      if (!this.#heldUnwritten) this.#log("halt.unwritten", { id: this.#held?.id ?? null, error: errorMessage(error) });
      this.#heldUnwritten = true;
      return false;
    }
  }

  /** Why no start may run now for the held halt, or null. */
  #heldRefusal(): string | null {
    const held = this.#held;
    if (held === null) return null;
    if (held.reason === LOGIN_DECIDES && this.#mode === "manual_login") return null;
    return `halted for the owner's decision (${held.reason}, halt ${held.id}): clearHalt first`;
  }

  /** The halt is cleared: nothing held on the volume first, then in memory;
   *  a page that stood for it stands as any other. False: the volume could
   *  not be written — it is still held. */
  #clearHeld(why: string): boolean {
    const held = this.#held;
    if (held === null) return true;
    try {
      this.#haltStore.write({ halt: null, lastClearedId: held.id });
    } catch (error) {
      this.#log("halt.clear_unwritten", { id: held.id, error: errorMessage(error) });
      return false;
    }
    this.#held = null;
    this.#lastClearedId = held.id;
    this.#heldUnwritten = false;
    this.#loginForHalt = null;
    this.#log("halt.cleared", { id: held.id, reason: held.reason, why });
    if (this.page.halted && this.page.snapshot.stopReason === held.reason) this.page.stand(`halt ${held.id} cleared: ${why}`);
    this.#sendState();
    return true;
  }

  /** The owner's `clearHalt` (his audited start): only the halt it names. */
  #clearHaltCommand(haltId: string): CommandOutcome {
    const held = this.#held;
    if (held === null) {
      // The owner's word on a halt this operator does not hold (it was lost,
      // or cleared already): said as cleared, so Hub's mirror of it goes.
      if (this.#lastClearedId !== haltId) {
        this.#lastClearedId = haltId;
        this.#writeHeld();
        this.#sendState();
      }
      return { ok: true, detail: "no halt is held" };
    }
    if (held.id !== haltId) return { ok: false, detail: `the halt held is ${held.id} (${held.reason}), not ${haltId}: nothing cleared` };
    return this.#clearHeld("the owner's clearHalt")
      ? { ok: true, detail: `halt ${held.id} (${held.reason}) cleared` }
      : { ok: false, detail: `halt ${held.id} could not be cleared on the volume: still held` };
  }

  /** A planned stop of Chrome: the exit closes first, then Chrome is asked
   *  to quit (Browser.close — CDP goes with it), and s6 makes sure. */
  async #stopChrome(note: string): Promise<void> {
    this.egress.closeExit(note);
    this.#controlExpected = false;
    if (this.cdp.cdpUp) {
      await this.cdp.send("Browser.close", {}, undefined, 2000).catch(() => undefined);
      await this.#waitUntil(async () => !(await this.chrome.isUp()), this.#timings.quitWaitMs);
    }
    await this.chrome.stop();
  }

  /** One operation on Chrome's process at a time: a stop that is still
   *  running never stops the Chrome a newer start brings up. */
  async #withChrome<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#chromeChain;
    let release: () => void = () => undefined;
    this.#chromeChain = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /** The work tab's localStorage of the site changed (plan-b §4.1.6). The
   *  site signing itself out — its `session_active_session` cleared, a
   *  `session_active_session_clear_info` written, its storage cleared — while the
   *  automation runs it is the owner's to log in again: the page halts
   *  `login_required`, which the owner's login clears once the expected
   *  account is confirmed. Values are only compared with "null" or the empty
   *  string and never kept. In the manual login a person
   *  signs in and out: nothing is decided then. */
  #onSiteStorage(event: string, message: CdpEvent): void {
    const tab = this.control.workTab;
    if (tab === null || message.sessionId !== tab.sessionId) return;
    const p = message.params as { storageId?: { securityOrigin?: string; storageKey?: string; isLocalStorage?: boolean }; key?: string; newValue?: string };
    if (p.storageId?.isLocalStorage !== true) return;
    const origin = (p.storageId.securityOrigin ?? p.storageId.storageKey ?? "").replace(/\/$/, "");
    if (origin !== SITE_ORIGIN) return;
    const cleared = event === "DOMStorage.domStorageItemsCleared";
    const sessionGone = p.key === SITE_ACTIVE_SESSION_KEY && (event === "DOMStorage.domStorageItemRemoved" || p.newValue === "null" || p.newValue === "");
    const clearInfo = p.key === SITE_ACTIVE_SESSION_CLEAR_INFO_KEY && (event === "DOMStorage.domStorageItemAdded" || event === "DOMStorage.domStorageItemUpdated");
    // The socket's authorization follows the site's live session (plan-b
    // §4.1.9), in whatever mode: only its size is kept.
    if (!message.replayed && (cleared || p.key === SITE_ACTIVE_SESSION_KEY)) this.#storedSession(cleared || event === "DOMStorage.domStorageItemRemoved" ? null : (p.newValue ?? null));
    if (!cleared && !sessionGone && !clearInfo) return;
    const what = cleared ? "the site's storage was cleared" : sessionGone ? `its ${SITE_ACTIVE_SESSION_KEY} was cleared` : `it wrote ${SITE_ACTIVE_SESSION_CLEAR_INFO_KEY}`;
    this.#log("site.login_lost", { what, mode: this.#mode, step: this.page.step });
    if (this.#mode !== "automation" || this.page.halted || this.#stopped || !atLeast(this.page.step, "exit_open")) return;
    void this.#halt("login_required", `Fansly signed the browser out: ${what}`, "stop");
  }

  /** The work tab's new document of the site (its main frame committed):
   *  the site's live session is read from its storage before its socket can
   *  connect (plan-b §4.1.9). */
  #onWorkDocument(message: CdpEvent): void {
    if (message.replayed) return;
    const tab = this.control.workTab;
    const frame = (message.params as { frame?: { parentId?: string; url?: string } }).frame;
    if (tab === null || message.sessionId !== tab.sessionId || frame === undefined || frame.parentId !== undefined) return;
    if (URL.canParse(frame.url ?? "") && new URL(frame.url!).origin === SITE_ORIGIN) void this.#readStoredSession("the work tab's document of the site committed");
  }

  /** The site's `session_active_session` as its storage has it now: the
   *  socket gate's authorization size. Read in memory, never kept, logged or
   *  written. A read that fails, or finds no such key, leaves what the
   *  storage's events (or the site's requests) said. */
  async #readStoredSession(why: string): Promise<void> {
    const tab = this.control.workTab;
    if (tab === null || !this.cdp.cdpUp) return;
    let entries: unknown = null;
    // By its origin; a Chrome that takes only the storage key, by that.
    for (const storageId of [{ securityOrigin: SITE_ORIGIN, isLocalStorage: true }, { storageKey: `${SITE_ORIGIN}/`, isLocalStorage: true }]) {
      try {
        ({ entries } = await this.cdp.send<{ entries?: unknown }>("DOMStorage.getDOMStorageItems", { storageId }, tab.sessionId, 2_000));
        break;
      } catch (error) {
        this.#log("site.session_unread", { why, by: "securityOrigin" in storageId ? "origin" : "storage_key", error: errorMessage(error) });
        if (!(error instanceof CdpError)) return;
      }
    }
    if (this.control.workTab !== tab || !Array.isArray(entries)) return;
    const found = entries.find((entry): entry is [string, string] => Array.isArray(entry) && entry[0] === SITE_ACTIVE_SESSION_KEY && typeof entry[1] === "string");
    if (found !== undefined) this.#storedSession(found[1]);
    this.#log("site.session_read", { why, found: found !== undefined, authorization: this.hub.session.socketAuthorizationBytes() !== null });
  }

  /** The site's live session as its storage showed it (`value` the stored
   *  JSON, null: none): what the socket gate holds is decided again. */
  #storedSession(value: string | null): void {
    this.hub.session.noteStoredSession(value);
    this.egress.socketRulesChanged();
  }

  /** A Hub request without a proven end: wait without a deadline for fresh
   *  site requests, ignoring hung or lost ends. A proven Hub end meanwhile
   *  cancels this restart; another operation's slot is never touched. */
  async #restartUnended(operation: string, note: string): Promise<void> {
    const run = this.#run;
    const stale = () => run !== this.#run || this.#stopped || this.page.halted || this.egress.gate.slotOwner !== operation;
    if (stale()) return;
    const began = monoMs();
    const fresh = () => this.observer.activeSince(monoMs() - SITE_STALE_IN_FLIGHT_MS);
    const freshInFlight = fresh();
    this.#log("slot.wait_quiet", { operation, freshInFlight, staleIgnored: this.observer.inFlight - freshInFlight, staleInFlightMs: SITE_STALE_IN_FLIGHT_MS });
    while (!stale() && fresh() > 0) await sleep(25);
    if (stale()) {
      if (this.egress.gate.slotOwner !== operation) this.#log("slot.restart_skipped", { operation, owner: this.egress.gate.slotOwner, why: "the slot is no longer this operation's" });
      return;
    }
    this.#log("slot.restart", { operation, quiet: true, freshInFlight: 0, staleIgnored: this.observer.inFlight, siteInFlight: this.observer.inFlight, waitedMs: monoMs() - began });
    void this.#fail("request_unended", note);
  }

  async #waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return true;
      if (Date.now() >= deadline || this.#stopped) return false;
      await sleep(25);
    }
  }

  // ── the interception ───────────────────────────────────────────────────

  /** A self-test probe and Hub's requests go by their paths (selftest/,
   *  hub-requests/); every other request is the site's, and the map of
   *  operations decides it (intercept/site.ts) — the live session is
   *  learned from those to the API. The socket host serves sockets only:
   *  any other request there could open a connection a later socket would
   *  ride without its own tunnel and admission (stage 1, §3.2) — CDP never
   *  shows a socket's handshake here. A response stage only a Hub request or
   *  an admitted site request asked for. A request on the path of a write the
   *  map opens by its body (the site's delivered marks) is decided by its
   *  check, at once and the same in both modes (intercept/checked.ts). */
  #decide(request: PausedRequest): PausedDecision {
    if (request.stage === "response") return this.hub.decide(request) ?? this.site.decide(request) ?? { action: "fail", reason: "BlockedByClient", why: "a response stage nobody asked for" };
    const probe = this.probes.onPaused(request);
    if (probe === "continue") return { action: "continue" };
    if (probe === "fail") return { action: "fail", reason: "BlockedByClient", why: "a self-test probe that may not go on" };
    const hub = this.hub.decide(request);
    if (hub) return hub;
    const checked = decideChecked(request, this.#mode);
    if (checked) return checked;
    return this.site.decide(request) ?? { action: "fail", reason: "BlockedByClient", why: "no path decided it" };
  }

  /** One line per resolution: the host (a Hub request's real one) and path,
   *  never the query, the fragment or a header. */
  #journalRequest(request: PausedRequest, decision: PausedDecision): void {
    const { host: seen, path } = hostAndPath(request.url);
    const host = seen.endsWith(PLACEHOLDER_SUFFIX) ? seen.slice(0, -PLACEHOLDER_SUFFIX.length) : seen;
    const probe = /^#pb-selftest-/.test(request.urlFragment);
    const admitted = this.hub.describe(request) ?? this.site.describe(request) ?? describeChecked(request);
    const line = { method: request.method, host, path, resourceType: request.resourceType };
    switch (decision.action) {
      case "continue":
        this.journals.request({
          ...line,
          admission: admitted ?? (probe ? "self-test probe (exit closed)" : null),
          decision: "continued",
          result: decision.note ?? (admitted ? "released under its admission" : probe ? "released to the closed exit" : "passed unpaced"),
        });
        return;
      case "fail":
        this.journals.request({ ...line, admission: admitted, decision: "failed", result: `${decision.reason}: ${decision.why}` });
        return;
      case "fulfill":
        this.journals.request({ ...line, admission: admitted, decision: "fulfilled", result: `${decision.status}: ${decision.why}` });
        return;
      case "continueResponse":
        this.journals.request({ ...line, admission: admitted, decision: "continued", result: "the answer went on to the page" });
        return;
      case "hold":
        return;
    }
  }

  /** Why a Hub request may not start now, or null: the page is up, its exit
   *  IP not unknown (#checkUpIp), and the site is in the work tab (plan §4.1,
   *  step 8). */
  #siteNotReady(): string | null {
    if (this.#mode === "manual_login") return "the manual login: no Hub request while a person is in the page";
    if (!this.admissionsOpen()) return `no admissions (${this.page.halted ? "halted" : this.page.step}${this.rpc.linkUp ? "" : ", no engine link"})`;
    if (this.#ipUnknown !== null) return "the exit IP is unknown: its last check got no answer (it is tried again)";
    if (!this.control.workTab) return "no work tab";
    return this.#siteInWorkTab() ? null : "the site is not loaded in the work tab";
  }

  /** The work tab holds a document of the site. */
  #siteInWorkTab(): boolean {
    const tab = this.control.workTab;
    if (!tab) return false;
    try {
      return new URL(tab.url).origin === SITE_ORIGIN;
    } catch {
      return false;
    }
  }

  /** The site's socket stops the page (ws/): a message the guard did not let
   *  go — or that went past it — records the socket gate keeps refusing, or
   *  a context the guard could not go into.
   *  The exit closes now, in this turn; the page stands until the engine
   *  starts it again (spec §2.6; stage 1, amendment 17) — Chrome is not
   *  started again for it. */
  #socketStop(reason: SocketStop, note: string, how: "stop" | "kill"): void {
    this.egress.closeExit(note);
    if (this.page.halted && this.page.snapshot.stopReason === reason) return;
    void this.#halt(reason, note, how);
  }

  /** A request of the site's admission path (intercept/site.ts, protocol
   *  1.3) the operator cannot vouch for: the exit closes now, in this turn. A
   *  request Chrome may still hold dies with the browser, and the page starts
   *  again; headers that differ from the site's stop it for the owner (plan
   *  §4.7). Hub's own requests never stop the page (variant Б). */
  #requestFault(reason: "request_unended" | "header_mismatch", note: string): void {
    this.egress.closeExit(note);
    if (reason === "header_mismatch") void this.#halt("header_mismatch", note, "stop");
    else void this.#fail("request_unended", note);
  }

  // ── the engine ─────────────────────────────────────────────────────────

  #onHello(hello: Hello): { bufferId: string; state: State } {
    // The permissions of Hub's writes are the engine's of this connection:
    // off at every hello, until it says them (minor 8; an older engine
    // never does, and never writes).
    this.hub.setPublishing({ create: false, withdraw: false });
    registerSecret(hello.socks5.username);
    registerSecret(hello.socks5.password);
    const previous = this.#settings;
    const settings: EngineSettings = {
      pageId: hello.pageId,
      expectedAccountId: hello.expectedAccountId,
      pinnedExitIp: normalizeIp(hello.pinnedExitIp),
      socks: { ip: hello.socks5.ip, port: hello.socks5.port, username: hello.socks5.username, password: hello.socks5.password },
      env: hello.env,
    };
    this.#settings = settings;
    this.#applyParams(hello.params);
    this.egress.setSocks(settings.socks);
    const egressChanged =
      previous !== null &&
      (previous.pinnedExitIp !== settings.pinnedExitIp ||
        previous.socks.ip !== settings.socks.ip ||
        previous.socks.port !== settings.socks.port ||
        previous.socks.username !== settings.socks.username ||
        previous.socks.password !== settings.socks.password);
    // Chrome takes the time zone and the languages only when it starts.
    const envChanged = previous !== null && !sameEnv(previous.env, settings.env);
    const changed = egressChanged || envChanged;
    if (changed && !this.page.halted && (this.#starting || atLeast(this.page.step, "chrome_started"))) {
      // What was verified is not what the engine says now: the exit closes
      // and the page starts again on the new settings.
      const why = egressChanged ? "the engine changed the page's SOCKS5 or pinned IP" : "the engine changed the page's environment";
      this.egress.closeExit(why);
      queueMicrotask(() => void this.#launch(false, why));
    }
    this.#log("engine.settings", { pageId: settings.pageId, pinnedExitIp: settings.pinnedExitIp, socks: `${settings.socks.ip}:${settings.socks.port}`, env: describeEnv(settings.env), changed });
    return { bufferId: this.buffer.id, state: this.state };
  }

  /** The engine's parameters (plan §4.14), within what keeps the page safe. */
  #applyParams(params: OperatorParams): void {
    const pingMs = clamp(params.pingMs, 10, 10_000);
    this.#params = {
      ...params,
      pingMs,
      linkLossMs: clamp(params.linkLossMs, 2 * pingMs, 60_000),
      selfTestMaxMs: clamp(params.selfTestMaxMs, 500, 10_000),
      exitIpCheckMs: clamp(params.exitIpCheckMs, 100, 3_600_000),
      restartBackoffMs: params.restartBackoffMs.filter((ms) => ms >= 10),
    };
    this.rpc.setTiming(this.#params.pingMs, this.#params.linkLossMs);
    this.site.setTimings(this.#params.siteAdmitWaitMs, this.#params.siteRequestLimitMs);
    this.page.setBackoff(this.#params.restartBackoffMs);
    this.control.networkBuffer = this.#params.chromeBodyBuffer;
    this.buffer.setParams(this.#params.bufferBatchMs, this.#params.bufferCap);
    this.stream.setBatch(this.#params.eventBatch.maxEvents, this.#params.eventBatch.maxBytes);
    // The next check at the new interval — but while the IP is unknown, its
    // retry stands.
    if (this.#ipTimer && this.#ipUnknown === null) this.#armIpTimer();
  }

  /** The previous owner's work is over once its queued commands had their
   *  turn — each is refused there now, the generation having moved on — and
   *  there are no admissions yet: report the latest send of any origin. */
  async #quiesce(): Promise<{ lastSendMono: number | null; lastSendWall: number | null }> {
    // The login form's step under way was the earlier owner's: it stops at
    // its next input step, and is over before anything else is.
    this.#cancelLogin("a new owner of the page");
    await this.login.drain();
    await this.#commandChain;
    // The manual login is its owner's (plan §4.8): a new owner switches it on
    // again if it still wants it. The automation is back first.
    if (this.#mode === "manual_login") await this.#leaveManualLogin("a new owner of the page");
    // A start under way ends here, the exit closed: the new owner starts the
    // page. A page that is up stays up — the browser outlives its owner
    // (a Hub deploy is one).
    if (this.#starting) this.#standing = this.#stand("a new owner of the page");
    await this.#standing;
    // The earlier owners' Hub requests: refused if not released, ended
    // (their limits hold them to it) if they were.
    await Promise.all([this.hub.quiesce(this.rpc.generation), this.site.quiesce(this.rpc.generation)]);
    const sends = [this.egress.gate.lastSend, this.hub.lastMediaSend, this.sockets.lastHandshake, this.observer.lastSend].filter((send): send is { mono: number; wall: number } => send !== null);
    const last = sends.length === 0 ? null : sends.reduce((a, b) => (b.mono > a.mono ? b : a));
    return { lastSendMono: last?.mono ?? null, lastSendWall: last?.wall ?? null };
  }

  /** One command at a time. The RPC checked its owner and deadline when it
   *  came; both are checked again at its turn: an owner superseded while it
   *  waited, or a deadline gone, and it is not executed. */
  async #onCommand(command: Command): Promise<CommandOutcome> {
    const previous = this.#commandChain;
    let release: () => void = () => undefined;
    this.#commandChain = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      if (command.ownerGeneration < this.rpc.generation) return { ok: false, detail: "generation_stale" };
      if (monoMs() > command.notAfterMono) return { ok: false, detail: "expired" };
      return await this.#execute(command);
    } finally {
      release();
    }
  }

  async #execute(command: Command): Promise<CommandOutcome> {
    switch (command.command.kind) {
      case "closeExit":
        this.#exitHeld = true;
        this.egress.closeExit("the engine's closeExit");
        // What the site has waiting is cancelled, not kept for the next
        // open exit (plan §4.5, §4.9); the browser stays.
        this.site.endAll("the engine's closeExit", false);
        this.#stopIpTimer();
        this.page.exitClosed("the engine's closeExit");
        this.#sendState();
        return { ok: true, detail: "the exit is closed" };
      case "openExit":
        return this.#openExitCommand();
      case "stopPage": {
        this.#exitHeld = false;
        await this.#halt("owner_stop", "the engine's stopPage", "stop");
        // The answer is the stop's confirmation (a profile's snapshot waits
        // for it): only once Chrome's process is down — never on the way.
        const up = await this.chrome.isUp().catch(() => true);
        return up ? { ok: false, detail: "the exit is closed, but Chrome is still up" } : { ok: true, detail: "the page is stopped: the exit closed, Chrome down" };
      }
      case "restartBrowser": {
        const refused = this.#heldRefusal();
        if (refused !== null) return { ok: false, detail: refused };
        this.#exitHeld = false;
        void this.#launch(true, "the engine's restartBrowser");
        return { ok: true, detail: "the start began" };
      }
      case "clearHalt":
        return this.#clearHaltCommand(command.command.haltId);
      case "selfTest":
        return this.#selfTestCommand();
      case "setMode":
        return command.command.mode === "manual_login" ? this.#enterManualLogin(command.ownerGeneration) : this.#leaveManualLogin("the engine's setMode");
      case "setPublishing": {
        // The permissions of Hub's writes (minor 8): the engine reads them
        // for the page; the operator checks them at every write it would
        // release.
        // A stop of its own is cleared only by the engine naming it, once it
        // recorded the stop as the page's autostop.
        const { create, withdraw, clearStop } = command.command;
        this.hub.setPublishing({ create, withdraw, ...(clearStop === undefined ? {} : { clearStop }) });
        this.#sendState();
        const now = this.hub.publishing;
        return { ok: true, detail: `publishing: create ${now.create ? "on" : "off"}, withdraw ${now.withdraw ? "on" : "off"}${now.stop === null ? "" : `, stopped by the operator (${now.stop.reason}, ${now.stop.id})`}` };
      }
      default:
        return { ok: false, detail: `${command.command.kind} is not supported by this operator yet` };
    }
  }

  async #openExitCommand(): Promise<CommandOutcome> {
    if (this.#held !== null) return { ok: false, detail: `halted for the owner's decision (${this.#held.reason}, halt ${this.#held.id}): clearHalt first` };
    if (this.page.halted) return { ok: false, detail: `the page is stopped (${this.page.snapshot.stopReason ?? "?"}): restartBrowser starts it` };
    // The same Chrome may still hold a request released before the close:
    // the exit opens only once every one has its end (or Chrome went).
    const owner = this.egress.gate.slotOwner;
    if (owner !== null) return { ok: false, detail: `a request released before the exit closed has no end yet (${owner}): restartBrowser starts the page with a fresh Chrome` };
    this.#exitHeld = false;
    if (this.#starting) return { ok: true, detail: "the running start opens it" };
    if (atLeast(this.page.step, "exit_open")) return { ok: true, detail: "the exit is open" };
    if (this.page.step !== "exit_ip_verified") return { ok: false, detail: `the page is at ${this.page.step}: its start opens the exit` };
    // The IP is checked before the exit opens (plan §4.5).
    const run = this.#run;
    try {
      await this.#verifyExitIp();
    } catch (error) {
      if (run !== this.#run) return { ok: false, detail: "superseded" };
      const failure = error instanceof StartFailure ? error : new StartFailure("proxy_unavailable", errorMessage(error));
      if (failure.reason === "exit_ip_changed") await this.#halt(failure.reason, failure.message, "stop");
      else await this.#fail(failure.reason, failure.message);
      return { ok: false, detail: failure.message };
    }
    if (run !== this.#run || this.page.step !== "exit_ip_verified" || this.#exitHeld) return { ok: false, detail: "superseded" };
    this.#openExit();
    return { ok: true, detail: "the exit is open" };
  }

  // ── the manual login (plan §4.8; spec §7) ─────────────────────────────

  /** The engine of `generation` puts the page into the manual login: the
   *  map lets the login operations through beside the interface's reads
   *  (policy/operations.ts), the site's socket and Hub's requests stay out,
   *  the page is never ready.
   *  The site is loaded anew so its login screen is shown under this mode —
   *  but a live page's under variant Б (#reloadsForMode): the person finds
   *  the site as it is, its login screen when Fansly signed it out. One that
   *  is not up waits for the engine's start. */
  async #enterManualLogin(generation: number): Promise<CommandOutcome> {
    if (this.#mode === "manual_login") {
      if (this.#modeGeneration !== generation) this.#cancelLogin("the manual login is another owner's now");
      this.#modeGeneration = generation;
      return { ok: true, detail: "the manual login: already" };
    }
    this.#setMode("manual_login", generation, "the engine's setMode");
    if (this.#held !== null && this.#held.reason === LOGIN_DECIDES) this.#loginForHalt = this.#held.id;
    this.login.begin();
    // Hub's requests that wait for their check are refused (#siteNotReady
    // says so from here); a ready page is no longer ready.
    if (atLeast(this.page.step, "session_confirmed")) this.page.back("site_loaded", "the manual login: a person is in the page");
    const reload = this.#reloadsForMode() && this.#reloadForMode("the manual login begins: the site is loaded anew for its login screen");
    return { ok: true, detail: `the manual login${reload ? "; the site is loaded anew" : ""}` };
  }

  /** The automation is back: the login operations are closed again, and
   *  before the page resumes the checks of plan §4.8, step 5 — the exit IP
   *  now (a changed one halts the page, one the check cannot learn holds
   *  Hub's requests: #checkUpIp), the session and the account by the
   *  engine's identity read under the live session (#confirmSession: the
   *  page is ready only then). The site is loaded anew under the automation
   *  — a live page's under variant Б is not (#reloadsForMode). */
  async #leaveManualLogin(why: string): Promise<CommandOutcome> {
    if (this.#mode === "automation") return { ok: true, detail: "the automation: already" };
    this.#setMode("automation", null, why);
    // The login form's step under way stops at its next input step: nothing
    // of it acts once the automation is back.
    await this.login.drain();
    const up = atLeast(this.page.step, "exit_open") && !this.page.halted && this.egress.exitOpen;
    if (!up) return { ok: true, detail: "the automation; the page is not up: its start checks the exit IP and the session" };
    // The page that is up: an IP the check cannot learn holds Hub's requests
    // (the engine's identity read among them) until one names the pinned IP.
    const checked = await this.#checkUpIp();
    if (checked.kind === "superseded") return { ok: true, detail: "the automation; superseded by a new start" };
    if (checked.kind === "changed" || checked.kind === "failed") return { ok: true, detail: `the automation; ${checked.why}: the page stops` };
    const reload = this.#reloadsForMode() && this.#reloadForMode("the manual login ended: the site is loaded anew under the automation");
    const ip = checked.kind === "pinned" ? `the exit IP ${checked.ip} is the pinned one` : `the exit IP check got no answer (${checked.why}): Hub's requests are held until a check names the pinned IP`;
    const session = this.hub.session.fingerprint === null ? "no live session yet" : "the live session waits for the engine's identity read";
    return { ok: true, detail: `the automation; ${ip}; ${session}${reload ? "; the site is loaded anew" : ""}` };
  }

  #setMode(mode: Mode, generation: number | null, why: string): void {
    this.#cancelLogin(`the mode changes to ${mode}`);
    // What the engine's identity read confirmed was before a person could
    // be in the page: the session and the account are read anew, by a read
    // sent from now on, before the page is ready again.
    this.#identity = null;
    this.#identityFloorMono = monoMs();
    // Page 0's confirmation waits for the site to show its session again,
    // in a document loaded from now on.
    this.#modeChanges += 1;
    this.#sessionShownInMode = null;
    this.#sessionNoteWaiting = null;
    this.#sessionsShown.clear();
    this.#mode = mode;
    this.#modeGeneration = generation;
    this.#log("mode", { mode, generation, why });
    this.journals.state({ from: this.page.step, to: this.page.step, stopReason: this.page.snapshot.stopReason, retryAtWall: this.page.snapshot.retryAtWall, halted: this.page.halted, note: `mode ${mode}: ${why}` });
    this.#sendState();
  }

  /** Whether a change of the mode loads the site anew: always for page 0
   *  (its confirmation needs a document of the mode), and under an engine
   *  that admits the site's traffic (protocol before 1.4). A live page under
   *  variant Б is never loaded anew (plan-b Б4): its site goes on as it is. */
  #reloadsForMode(): boolean {
    return this.#settings?.pageId === 0 || !this.rpc.engineObserves;
  }

  /** The work tab of a page that is up is loaded anew for the mode now —
   *  what of the site is in flight waited out first (a request cancelled by
   *  the reload would stop the page). False: nothing to load (the page is
   *  not up, or its site is loading already). */
  #reloadForMode(note: string): boolean {
    if (this.page.halted || !this.egress.exitOpen || !atLeast(this.page.step, "site_loaded")) return false;
    const run = this.#run;
    const reload = ++this.#modeReload;
    const stale = () => run !== this.#run || reload !== this.#modeReload || this.#stopped || this.page.halted || !this.egress.exitOpen || !atLeast(this.page.step, "site_loaded");
    void (async () => {
      // Waited out however long it takes (each request of the site ends
      // within its own limits, or the page stops): a document of this mode
      // always comes — a profile no page has is confirmed only by one
      // (Astra's review of PR 16, round 3).
      while (!(await this.#waitUntil(() => stale() || this.site.released === 0, this.#timings.reloadWaitMs))) {
        if (stale()) return;
        this.#log("site.mode_reload_waits", { released: this.site.released });
      }
      if (stale()) return;
      this.site.reloading(this.control.workTab?.mainFrameId ?? null);
      this.page.back("exit_open", note);
      await this.#loadSite(run);
    })();
    return true;
  }

  /** The work tab's document goes, failed closed: a press of the login form
   *  was not let go on its button (login/desk.ts) and dies with its
   *  document. The tab is taken to a blank document at once — no network,
   *  nothing of the old document left; what of the site was in flight is cut
   *  with it, which stops the page as a reload's would (#reloadForMode) — and
   *  a page that is up loads the site anew after it. A blank document that
   *  does not come (CDP lost, no answer, no work tab known): the page's
   *  Chrome goes (#fail), and the press with it. Never throws. */
  async #discardDocument(why: string): Promise<void> {
    this.#log("login.document_discarded", { why });
    const tab = this.control.workTab;
    const run = this.#run;
    const up = !this.page.halted && this.egress.exitOpen && atLeast(this.page.step, "site_loaded");
    try {
      if (tab === null) throw new Error("no work tab known");
      if (up) {
        this.site.reloading(tab.mainFrameId ?? null);
        this.page.back("exit_open", why);
      }
      const reply = await this.cdp.send<{ errorText?: string }>("Page.navigate", { url: "about:blank" }, tab.sessionId, DISCARD_WAIT_MS);
      if (typeof reply.errorText === "string" && reply.errorText !== "") throw new Error(reply.errorText);
      const blank = await this.#waitUntil(() => this.control.workTab === tab && tab.url.startsWith("about:blank"), DISCARD_WAIT_MS);
      if (!blank) throw new Error(`no blank document within ${DISCARD_WAIT_MS} ms`);
    } catch (error) {
      await this.#fail("cdp_lost", `${why}; its document could not be discarded (${errorMessage(error)}): the browser goes with it`).catch(() => undefined);
      return;
    }
    if (up && run === this.#run) await this.#loadSite(run);
  }

  /** A call of the login form (spec §6.1 `login.*`): taken only in the
   *  manual login that the engine of the current owner generation switched
   *  on, with the page up; what types into the site, also only while that
   *  engine is heard (its admission is what lets the login go) — and only
   *  for as long as all of it holds (`#loginGuard`, read before every input
   *  step). */
  async #onLogin(request: LoginRequest): Promise<LoginOutcome | { kind: "refused"; reason: "not_manual_login" }> {
    const current = this.#mode === "manual_login" && this.#modeGeneration !== null && this.#modeGeneration === this.rpc.generation;
    const up = !this.page.halted && atLeast(this.page.step, "exit_open") && this.egress.exitOpen;
    if (!current || !up) return { kind: "refused", reason: "not_manual_login" };
    switch (request.type) {
      case "login.state":
        return this.login.state();
      case "login.screenshot":
        return this.login.screenshot();
      case "login.open":
        return this.login.open(this.#loginGuard());
      case "login.submit":
        return this.login.submit(request.login, request.password, this.#loginGuard());
      case "login.code":
        return this.login.code(request.code, this.#loginGuard());
    }
  }

  /** A login call's claim on the browser, taken now: null while the manual
   *  login it was taken in lasts — the same mode, owner generation and
   *  engine connection (`#loginEpoch`), that engine heard, the same start
   *  of the page and the page up — else why not. */
  #loginGuard(): LoginGuard {
    const epoch = this.#loginEpoch;
    const generation = this.#modeGeneration;
    const run = this.#run;
    return () => {
      if (epoch !== this.#loginEpoch) return "the manual login it was taken in is over";
      if (this.#mode !== "manual_login" || generation === null || this.#modeGeneration !== generation || this.rpc.generation !== generation) return "not the manual login it was taken in";
      if (!this.rpc.linkUp) return "no engine link";
      if (run !== this.#run || this.page.halted || !atLeast(this.page.step, "exit_open") || !this.egress.exitOpen) return "the page is not up as it was";
      return null;
    };
  }

  /** The login calls taken until now may act no more. */
  #cancelLogin(why: string): void {
    this.#loginEpoch += 1;
    this.#log("login.epoch", { why });
  }

  async #selfTestCommand(): Promise<CommandOutcome> {
    if (this.#starting) return { ok: false, detail: "a start is running: it runs the self-test itself" };
    if (this.egress.exitOpen) return { ok: false, detail: "the exit is open: the self-test runs with it closed (closeExit first)" };
    if (this.page.halted || !atLeast(this.page.step, "control_attached")) return { ok: false, detail: `no browser under control (${this.page.step})` };
    const run = this.#run;
    const result = await this.#selfTestNow();
    const summary = Object.entries(result.checks)
      .map(([name, check]) => `${name}: ${check.status}`)
      .join(", ");
    if (!result.ok && run === this.#run) await this.#fail("selftest_failed", `the self-test failed: ${result.failed ?? "?"}`);
    return { ok: result.ok, detail: summary };
  }

  // ── the buffer (plan §4.4; spec §5, §6.2) ──────────────────────────────

  #onBuffer(message: BufferMessage): void {
    switch (message.type) {
      case "events.subscribe": {
        const refused = this.stream.subscribe(message);
        if (refused) this.rpc.send(refused);
        return;
      }
      case "ack": {
        const refused = this.stream.ack(message);
        if (refused) this.rpc.send(refused);
        return;
      }
      case "resultAck":
        this.buffer.acknowledgeOutcome(message.attemptId);
        return;
      case "recover":
        // The engine's start (plan §3.2): the outcomes the buffer has go
        // first, then the answer for each attempt (buffer/replay.ts).
        if (!this.replay.recover(message.attemptIds)) this.rpc.protocolError("recover: more attempts waiting for their answer than the operator keeps");
        return;
    }
  }

  /** The buffer could not be opened: the page stands with the exit closed
   *  until it is — a halt, so a start comes only from the engine, and none
   *  passes the gate before the buffer opens. */
  #onBufferUnavailable(unavailable: BufferUnavailable): void {
    this.egress.closeExit(`the buffer cannot be opened: ${unavailable.detail}`);
    this.#alarm("buffer", unavailableDetail(unavailable));
    const note = `the buffer cannot be opened (${unavailable.cause}${unavailable.recoverable ? ", tried again" : ", left for the owner"}): ${unavailable.detail}`;
    if (this.#controlExpected || this.#starting) void this.#fail("buffer_unavailable", note);
    // A page that stands for nothing yet (the operator's start) stands for
    // this; one the engine already asked to start keeps failing at the gate.
    else if (!this.page.halted && this.page.snapshot.stopReason === null) this.page.halt("buffer_unavailable", note);
    this.#sendState();
  }

  /** The buffer opened after all: a page that stood for it stands as any
   *  other (or, if a start failed on it, starts again); the outcomes go to
   *  the engine, which subscribes again on seeing the state. */
  #onBufferOpened(): void {
    const snapshot = this.page.snapshot;
    this.#log("buffer.opened", { bufferId: this.buffer.id });
    this.sockets.bufferOpened();
    if (snapshot.stopReason === "buffer_unavailable" && !this.#stopped) {
      if (snapshot.halted) this.page.stand("the buffer is open");
      else if (!this.#starting) void this.#launch(false, "the buffer is open");
    }
    this.#sendState();
    if (this.rpc.linkUp) this.replay.connected();
    this.#flushTransitions();
  }

  /** Room in the buffer again, its gap written (spec §5, step 4): a page
   *  that stopped for it starts again now, not at its next retry. */
  #onBufferRoom(reason: FullReason): void {
    const snapshot = this.page.snapshot;
    // The socket's writes that waited for room go first.
    this.sockets.retryNow();
    this.site.retryNow();
    this.#flushTransitions();
    this.#sendState();
    if (this.#stopped || this.#starting || snapshot.halted) return;
    if (snapshot.stopReason !== "buffer_full" && snapshot.stopReason !== "disk_full") return;
    this.#log("buffer.room", { reason, action: "the start goes again" });
    void this.#launch(false, `the buffer has room again (${reason})`);
  }

  /** `open`: what the buffer holds, said only while its file is open — a
   *  buffer that cannot be opened counts nothing, and its zero is no word
   *  that it is empty (the engine takes a buffer for drained by `open`
   *  alone). */
  #bufferState(): State["buffer"] {
    const stats = this.buffer.stats();
    return {
      bytes: stats.bytes,
      oldestAgeMs: stats.oldestAgeMs,
      open: this.buffer.isOpen ? { id: this.buffer.id, lastSeq: stats.lastSeq, outcomes: stats.outcomes, pending: stats.pending } : null,
    };
  }

  #alarm(kind: AlarmKind, detail: Record<string, string | number | boolean>): void {
    this.#log("alarm", { kind, ...detail });
    // An engine before minor 7 refuses an alarm kind it does not know (and
    // drops the link on it): minor 7's go to the log alone there.
    if (FAULT_ALARMS.has(kind) && this.rpc.engineMinor < FAULTS_MINOR) return;
    this.rpc.send({ type: "alarm", atWall: Date.now(), kind, detail });
  }

  #sendState(): void {
    this.rpc.send(this.state);
  }

  #beat(): void {
    const path = this.config.heartbeatPath;
    if (path === null) return;
    const now = new Date();
    try {
      utimesSync(path, now, now);
    } catch {
      try {
        closeSync(openSync(path, "a"));
      } catch (error) {
        this.#log("heartbeat.failed", { error: errorMessage(error) });
      }
    }
  }
}

function unavailableDetail(unavailable: BufferUnavailable): Record<string, string | number | boolean> {
  return { unavailable: true, cause: unavailable.cause, recoverable: unavailable.recoverable, attempts: unavailable.attempts, detail: unavailable.detail };
}

function alarmDetail(alarm: BufferAlarm): Record<string, string | number | boolean> {
  return { percent: Math.round(alarm.percent), by: alarm.by, bytes: alarm.bytes, capBytes: alarm.capBytes, oldestAgeMs: alarm.oldestAgeMs, capAgeMs: alarm.capAgeMs, freeDiskBytes: alarm.freeDiskBytes };
}
