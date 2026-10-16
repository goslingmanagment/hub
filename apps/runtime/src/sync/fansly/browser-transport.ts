import { createHash } from "node:crypto";

import { findPageById, getSyncPage, readSyncWorkSecretParams, type Database, type SyncAttemptRow, type SyncWorkRow } from "@agency_hub_core/db";
import {
  buildFanslyWireUrl,
  FANSLY_WIRE_MAX_BODY_BYTES,
  fanslyWireSpec,
  type FanslyWireRequest,
} from "@agency_hub_core/fansly";
import type { AppConfig } from "@agency_hub_core/shared";

import { isFanslyCdnUrl, MEDIA_DOWNLOAD_MAX_BYTES, MEDIA_DOWNLOAD_TIMEOUT_MS } from "../../services/egress/media-download.ts";
import { REFUSALS, type Check, type Refusal, type Send, type SiteDone, type State, type WsDone } from "../../services/egress/page-browser-protocol.ts";
import {
  systemMonoBridge,
  type CheckReply,
  type DeliveredResult,
  type MonoBridge,
  type PageBrowserRpcClient,
} from "../../services/egress/page-browser-rpc.ts";
import { credentialsGenerationOfAttempt } from "../engine/commit.ts";
import { CREDENTIALS_CHECK_KEYS, IDENTITY_CHECK_KEY } from "../engine/errors.ts";
import { REQUEST_TIMEOUT_MS } from "../engine/pacer.ts";
import {
  CredentialsGenerationChangedError,
  PageTransportUnavailableError,
  UnsendableRequestError,
  type HeldAnswer,
  type HeldOutcomeSource,
  type HeldRequestOutcome,
  type PageTransport,
  type SendAdmission,
  type SendHooks,
  type SiteRequestEnd,
  type TransportOutcome,
} from "../engine/ports.ts";
import type { RequestPlan } from "../engine/resource.ts";
import { decryptSyncWorkSecret } from "../requests/secret-params.ts";
import { SEND_REPORT_GUARD_MS, siteRequestEndOf } from "./browser-site.ts";
import { absoluteLocation, type MediaDownloadSecret } from "./transport.ts";

// The browser page transport (Project Browser, plan §3.2, §4.2; stage 3 PR
// 12): the same `PageTransport` as the undici one (`fansly/transport.ts`) —
// `prepare`, `send` (at most one physical request), the stored credentials'
// generation, `close` — over the RPC of the page's operator
// (`services/egress/page-browser-rpc.ts`). Nothing selects it yet: a page's
// transport is chosen by `sync_pages.transport` (PR 14), and until then the
// host builds the undici one for every page.
//
// - prepare: the request of the plan, as the registry builds it, without the
//   headers Chrome sets itself and without the session's (the operator puts
//   the live session's in at the moment of the request, plan §4.7): the
//   registry's routes need no header of their own, so none goes. A CDN hop's
//   URL is the work's secret, as for undici. The socket's Upgrade is the
//   site's own on a browser page (its admission rides the site path): never
//   prepared here.
// - One credentials generation across the engine's fields (plan §3.2): the
//   digest of the page, its account, the browser's session fingerprint (the
//   operator's `state`) and the proxy. `prepare` puts it on the request
//   (`credentialsGeneration`, journaled with the attempt, written by an
//   identity proof as the trusted one) and `storedCredentialsGeneration`
//   returns the same value — the actor compares the two, so the page leaves
//   checks-only after its verify and enters it again when the owner logs in
//   anew (a new fingerprint) or the proxy changes. The fingerprint itself
//   goes in the `send` too, for the operator to hold the live session to it.
// - send: RPC `send`; the operator's `check` (when it holds the request
//   paused) is answered from the engine's lease and pacer (`hooks.grant`,
//   synchronous, as undici's `onRequestStart` check) with the admission's
//   absolute deadline on CLOCK_MONOTONIC — or refused: when the live session
//   is not the one prepared for (`session_mismatch`: nothing goes; the new
//   fingerprint moves the generation and the usual verify follows), and when
//   what the request was prepared under moved since — the page's stored
//   account or proxy (the generation read again with the live session), or
//   the settings the link's hello carried (`credentials_changed`: nothing
//   goes; the next `prepare` says hello again with the new SOCKS5, and the
//   moved generation asks for the verify first). Both are read again right
//   before the grant. One admission is one check: a second is refused
//   (`lease_used`).
// - The send instant: the operator's `sent` (the gate's first bytes, its own
//   clock) as it came — converted from CLOCK_MONOTONIC by one constant
//   shift (plan §4.2, step 5) and rounded up by `SEND_REPORT_GUARD_MS` —
//   goes in the outcome as `transport_reported`; the pacer marks the send
//   there (never before its grant, never after the completion). Without a
//   `sent` received (lost with a link, a result held from an earlier one)
//   the instant is unknown, whatever the result says: `completion_fallback`
//   — the pacer takes the completion, the latest it can have left, and a
//   fence ordered by time takes the admission (`engine/send-instant.ts`):
//   an unknown send proves nothing (Astra's review of PR 15, rounds 5 and
//   6).
// - The outcome: the operator's, as the wire layer shapes it (lower-case
//   headers, the body decoded; a CDN hop's bytes as `bodyBuffer`, 5 MiB). An
//   answer the server did not confirm (a cache, the site's service worker)
//   goes over marked `unconfirmed`: journaled as rejected, never applied. An
//   answer of another session than the one prepared for, or a body that did
//   not arrive whole, is no answer: a transport error, sent. Another
//   session's answer that arrived whole is kept as a fact by the actor's
//   late intake (`held`, below) and then acknowledged; a body that did not
//   arrive whole stays with the operator, which sends it again.
// - Nothing goes before the operator's `quiesced` for this owner: the
//   previous owner's requests are not known to be over until it says so
//   (plan §4.7, PR 14); `prepare` refuses, and the kept outcomes are not
//   asked about before it.
// - The operator not reachable or not ready is not Fansly's failure (no
//   network hold, plan §3.2): `prepare` refuses with
//   `PageTransportUnavailableError` and nothing is admitted; a request the
//   operator could not take at all (nothing left: `sent: false`) ends
//   `aborted_before_send` / `transport_unavailable` and the transport waits a
//   few seconds before it takes another.
// - Before the engine's grant nothing can leave (the operator releases a
//   request only on an admitting check). After it, a lost link waits for the
//   operator's result again (it keeps outcomes until `resultAck`, and
//   delivers them to the next connection) up to `resultWaitMs`; then the
//   request may have gone: a transport error, sent.
// - `resultAck` once the actor committed what the outcome carried
//   (`settled`: after the capture, or after the apply of a CDN hop's bytes),
//   for an outcome taken whole. The rest stay with the operator.
// - The outcomes the operator keeps (`held`, PR 13): at the actor's start,
//   before its recovery closes anything `unknown`, the operator is asked
//   (`recover`) about the attempts left unfinished — its outcomes come
//   again, and it says which never left (`not_sent`); between steps, the
//   outcomes it delivered that no request waits for (after a restart, an
//   answer of another session, a reply whose apply a lost COMMIT
//   acknowledgement left undone) and the ends of the site path nobody claims
//   go to the actor as late. Each becomes, for its attempt's row, what
//   `send` would have returned; the actor commits it and acknowledges it.
//   Nothing is ever sent again from it.

/** How long a request waits for the operator's result after its `send`: the
 *  operator ends every operation within 21 s of its last send (spec §9). */
export const BROWSER_RESULT_WAIT_MS = 60_000;
/** The wait after a request the operator could not take at all. */
export const BROWSER_UNAVAILABLE_RETRY_MS = 5_000;
/** How many outcomes nobody waits for are kept, with their bodies, until the
 *  actor takes them. Beyond it only their ids are kept, and they are asked
 *  for again (`recover`) once the queue drained — the operator delivers an
 *  outcome once per connection. */
export const BROWSER_LATE_OUTCOMES_MAX = 1_000;
/** How many such ids are kept. Beyond it the link says hello again once
 *  every id kept was taken: the operator then delivers every outcome it
 *  still keeps, and the actor takes them over the next laps. */
export const BROWSER_PENDING_OUTCOMES_MAX = 10_000;
/** Ids asked for again in one `recover`. */
const PENDING_RECOVER_CHUNK = 64;
/** The pause before an outcome whose body did not arrive whole is asked for
 *  again. */
const PENDING_RETRY_MS = 1_000;
/** A reported send instant is taken this much later than the bridge says
 *  (`browser-site.ts`, shared with the site path). */
export { SEND_REPORT_GUARD_MS };

export interface BrowserPageTransportContext {
  db: Database;
  config: AppConfig;
}

export interface BrowserPageTransportOptions {
  /** The page's operator link (started here; closed with the transport). */
  client: PageBrowserRpcClient;
  /** The engine's monotonic clock: the pacer's (`Clock.monoNow`). */
  monoNow?: () => number;
  /** The engine's clock against CLOCK_MONOTONIC (default: this process's). */
  bridge?: MonoBridge;
  /** TESTS ONLY: scaled waits (`recoverWaitMs` caps the actor's wait for
   *  the operator at its start). */
  timing?: Partial<{ resultWaitMs: number; unavailableRetryMs: number; recoverWaitMs: number; lateMax: number; pendingMax: number }>;
  /** Which CDN URLs a hop may request. Default: a Fansly media CDN host.
   *  TESTS ONLY pass another. */
  cdnUrlAllowed?: (url: URL) => boolean;
}

/** What `prepare` decided of a request, beside the wire request itself. */
interface Prepared {
  route: string;
  kind: Send["kind"];
  maxBodyBytes: number;
  sessionFingerprint: string;
  credentialsGeneration: string;
}

/** The page's rows the generation is made of. */
interface PageSnapshot {
  pageId: number;
  platform: string;
  nativeAccountId: string | null;
  proxy: { id: number; url: string; ciphertext: string | null; keyVersion: number | null; rateLimitScopeKey: string | null } | null;
  verified: string | null;
}

/**
 * One credentials generation for a browser page (plan §3.2): the page, its
 * account, the browser's live session (its fingerprint) and its proxy. Not a
 * secret; the same 64-hex shape as the undici transport's digest.
 */
export function browserCredentialsGeneration(input: {
  pageId: number;
  platform: string;
  nativeAccountId: string | null;
  sessionFingerprint: string;
  proxy: PageSnapshot["proxy"];
}): string {
  return createHash("sha256").update(JSON.stringify({
    transport: "browser",
    pageId: input.pageId,
    platform: input.platform,
    nativeAccountId: input.nativeAccountId,
    browserSession: input.sessionFingerprint,
    proxy: input.proxy,
  })).digest("hex");
}

async function readSnapshot(db: Database, pageId: number): Promise<PageSnapshot | null> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    const stored = await findPageById(tx, pageId);
    if (stored === null) return null;
    const verified = (await getSyncPage(tx, pageId))?.credentialsGeneration ?? null;
    const proxy = stored.proxy ?? null;
    return {
      pageId,
      platform: stored.page.platform,
      nativeAccountId: stored.page.platformAccountId ?? null,
      proxy: proxy === null
        ? null
        : { id: proxy.id, url: proxy.url, ciphertext: proxy.encryptedAuth ?? null, keyVersion: proxy.keyVersion ?? null, rateLimitScopeKey: proxy.rateLimitScopeKey ?? null },
      verified,
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** The page's browser credentials generation with `sessionFingerprint` (null:
 *  the page is not active, or has no proxy). The socket's connection rows of
 *  a browser page carry it (`fansly/ws/browser-source.ts`). */
export async function readBrowserCredentialsGeneration(db: Database, pageId: number, sessionFingerprint: string): Promise<string | null> {
  const snapshot = await readSnapshot(db, pageId);
  if (snapshot === null || snapshot.proxy === null) return null;
  return browserCredentialsGeneration({ ...snapshot, sessionFingerprint });
}

/** The operator can take a Hub request now: why not, or null. */
function notTaking(state: State | null): string | null {
  if (state === null) return "no link to the page's browser";
  if (state.stopReason !== null) return `the page's browser stands (${state.stopReason})`;
  if (!state.exitOpen) return `the page's browser has its exit closed (${state.step})`;
  if (state.sessionFingerprint === null) return "the page's browser knows no live session yet";
  return null;
}

/** A CDN file as the site would load it: a video by an element, the rest as
 *  an image (plan §3.2 «Медиа с CDN»). */
function mediaKind(url: URL): "image" | "video" {
  return /\.(mp4|m4v|mov|webm|m3u8|ts)$/i.test(url.pathname) ? "video" : "image";
}

const PROTOCOL_REFUSALS: ReadonlySet<string> = new Set(REFUSALS);

/**
 * The browser transport of one page over its operator's RPC client. The
 * client is started here and closed with the transport.
 */
export async function createBrowserPageTransport(
  ctx: BrowserPageTransportContext,
  page: { pageId: number },
  options: BrowserPageTransportOptions,
): Promise<PageTransport> {
  const client = options.client;
  const monoNow = options.monoNow ?? (() => performance.now());
  const bridge = options.bridge ?? systemMonoBridge();
  const resultWaitMs = options.timing?.resultWaitMs ?? BROWSER_RESULT_WAIT_MS;
  const unavailableRetryMs = options.timing?.unavailableRetryMs ?? BROWSER_UNAVAILABLE_RETRY_MS;
  const recoverWaitMs = options.timing?.recoverWaitMs ?? Number.POSITIVE_INFINITY;
  const lateMax = options.timing?.lateMax ?? BROWSER_LATE_OUTCOMES_MAX;
  const pendingMax = options.timing?.pendingMax ?? BROWSER_PENDING_OUTCOMES_MAX;
  const cdnUrlAllowed = options.cdnUrlAllowed ?? isFanslyCdnUrl;
  const prepared = new WeakMap<FanslyWireRequest, Prepared>();
  /** Attempts whose outcome was taken whole: acknowledged once settled. */
  const ackable = new Set<number>();
  /** Outcomes nobody waits for, by attempt (`held.takeLate`). */
  const late = new Map<number, HeldAnswer>();
  /** Outcomes the operator keeps that nothing here holds now: asked for
   *  again (`askPending`). */
  const pending = new Set<number>();
  let overflowed = false;
  let asking = false;
  let askNotBefore = Number.NEGATIVE_INFINITY;
  let unavailableUntil = Number.NEGATIVE_INFINITY;
  let closed = false;
  client.start();

  function unavailable(reason: string, retryInMs = unavailableRetryMs): PageTransportUnavailableError {
    return new PageTransportUnavailableError(reason, retryInMs);
  }

  /** Why no request can be taken now (prepare's first word), or null. */
  function refusalNow(): PageTransportUnavailableError | null {
    if (closed) return unavailable("the transport is closed");
    const status = client.status;
    if (status.kind === "superseded") return unavailable("a newer owner of the page holds its browser");
    if (status.kind === "refused") return unavailable(`the page's browser refused the link (${status.reason})`);
    const now = monoNow();
    if (now < unavailableUntil) return unavailable("the page's browser could not take the last request", unavailableUntil - now);
    if (client.up && client.quiesced === null) return unavailable("the page's browser has not said the previous owner's work is over (quiesced)", 250);
    const why = notTaking(client.state);
    return why === null ? null : new PageTransportUnavailableError(why, unavailableRetryMs,
      client.state?.exitOpen && client.state.stopReason === null && client.state.sessionFingerprint === null ? "session_unknown" : "unavailable");
  }

  /** The page's settings changed since the link's hello (a proxy): say it
   *  again before any request goes under them. */
  async function ensureHelloCurrent(): Promise<void> {
    const said = client.helloDigest;
    let now: string;
    try {
      now = await client.settingsDigestNow();
    } catch {
      throw unavailable("the page's browser settings do not read");
    }
    if (said === null) throw unavailable("no link to the page's browser");
    if (said !== now) {
      client.reconnect("the page's browser settings changed");
      throw unavailable("the page's browser settings changed: the link says hello again");
    }
  }

  async function generationNow(): Promise<{ snapshot: PageSnapshot; generation: string; fingerprint: string }> {
    const fingerprint = client.state?.sessionFingerprint ?? null;
    if (fingerprint === null) throw new PageTransportUnavailableError("the page's browser knows no live session yet", unavailableRetryMs, "session_unknown");
    const snapshot = await readSnapshot(ctx.db, page.pageId);
    if (snapshot === null) throw new UnsendableRequestError("page_inactive");
    if (snapshot.proxy === null) throw unavailable("the page has no proxy: its browser has no way out");
    return { snapshot, generation: browserCredentialsGeneration({ ...snapshot, sessionFingerprint: fingerprint }), fingerprint };
  }

  async function prepareApi(request: RequestPlan, work: SyncWorkRow | undefined): Promise<FanslyWireRequest> {
    if (work?.resource === IDENTITY_CHECK_KEY) {
      // A candidate session or proxy is the undici transport's: the browser
      // has its own live session (a candidate check through it comes with
      // the transport switch's preparation, PR 14).
      throw new UnsendableRequestError("browser_identity_candidate", { failure: "browser_identity_candidate", matches: null });
    }
    const { snapshot, generation, fingerprint } = await generationNow();
    if (!CREDENTIALS_CHECK_KEYS.has(work?.resource ?? "") && snapshot.verified !== generation) {
      throw new CredentialsGenerationChangedError(page.pageId, generation, snapshot.verified);
    }
    const built: FanslyWireRequest = {
      spec: request.spec,
      url: buildFanslyWireUrl(request.spec, request.params as never, ctx.config.fanslyBaseUrl),
      // The registry's routes carry no header of their own: Chrome's and the
      // live session's are the browser's (plan §3.2, §4.7).
      headers: {},
      timeoutMs: REQUEST_TIMEOUT_MS,
      credentialsGeneration: generation,
    };
    prepared.set(built, { route: request.spec, kind: "api", maxBodyBytes: FANSLY_WIRE_MAX_BODY_BYTES, sessionFingerprint: fingerprint, credentialsGeneration: generation });
    return built;
  }

  async function prepareCdn(request: RequestPlan, work: SyncWorkRow | undefined): Promise<FanslyWireRequest> {
    if (work === undefined) throw new Error(`${request.spec} is prepared for a work: its URL is the work's secret`);
    const ciphertext = await readSyncWorkSecretParams(ctx.db, work.id);
    if (ciphertext === null) throw new UnsendableRequestError("secret_missing", { failure: "secret_missing", httpStatus: null });
    let url: URL;
    try {
      url = new URL(String(decryptSyncWorkSecret<Partial<MediaDownloadSecret>>(ctx.config, ciphertext).url));
    } catch {
      throw new UnsendableRequestError("secret_unreadable", { failure: "secret_unreadable", httpStatus: null });
    }
    if (!cdnUrlAllowed(url)) throw new UnsendableRequestError("host_not_allowed", { failure: "host_not_allowed", httpStatus: null });
    const { generation, fingerprint } = await generationNow();
    const built: FanslyWireRequest = { spec: request.spec, url: url.toString(), headers: {}, timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS, credentialsGeneration: generation };
    prepared.set(built, { route: request.spec, kind: mediaKind(url), maxBodyBytes: MEDIA_DOWNLOAD_MAX_BYTES, sessionFingerprint: fingerprint, credentialsGeneration: generation });
    return built;
  }

  /** The operator's result as the engine's outcome; `reported` is the `sent`
   *  instant on the engine's clock, if one came; `credentialsChanged`: the
   *  engine refused the check because what the request was prepared under
   *  moved. */
  function outcomeOf(
    delivered: DeliveredResult,
    meta: Prepared,
    req: FanslyWireRequest,
    reported: number | null,
    credentialsChanged: boolean,
  ): { outcome: TransportOutcome; whole: boolean } {
    const { result, body, bodyProblem } = delivered;
    const o = result.outcome;
    // The gate's `sent` as it came, or nothing: without it the send instant
    // is unknown — the pacer takes the completion, a fence the admission
    // (`engine/send-instant.ts`); a result's own instant proves nothing
    // (Astra's review of PR 15, rounds 5 and 6).
    const sentAt = (_mono: number | null) => reported;
    const sentError = (message: string, mono: number | null = null): TransportOutcome => {
      const at = sentAt(mono);
      return at === null ? { kind: "transport_error", sent: true, message } : { kind: "transport_error", sent: true, message, sentMono: at };
    };
    if (result.sessionFingerprint !== meta.sessionFingerprint) {
      // Never attributed to the session it was prepared for (plan §3.2).
      if (o.kind === "aborted_before_send" || ((o.kind === "transport_error" || o.kind === "timeout") && !o.sent)) {
        return { outcome: { kind: "aborted_before_send", refusal: "session_mismatch" }, whole: true };
      }
      return { outcome: sentError("the answer came under another session of the page's browser"), whole: false };
    }
    switch (o.kind) {
      case "aborted_before_send":
        return { outcome: { kind: "aborted_before_send", refusal: credentialsChanged ? "credentials_changed" : o.refusal }, whole: true };
      case "transport_error":
      case "timeout": {
        if (!o.sent) return { outcome: { kind: "aborted_before_send", refusal: "transport_unavailable" }, whole: true };
        const at = reported;
        return { outcome: at === null ? { kind: o.kind, sent: true, message: o.message } : { kind: o.kind, sent: true, message: o.message, sentMono: at }, whole: true };
      }
      case "response": {
        if (bodyProblem !== null || body === null) return { outcome: sentError(`the page's browser answered, but ${bodyProblem ?? "its body is missing"}`, o.sentMono), whole: false };
        if (o.preflight === true && o.status >= 200 && o.status < 300) {
          return { outcome: sentError("only the CORS preflight of the request went", o.sentMono), whole: true };
        }
        const at = sentAt(o.sentMono);
        const marked = {
          ...(at === null ? { sendMark: "completion_fallback" as const } : { sendMark: "transport_reported" as const, sentMono: at }),
          // Not the server's confirmed word: journaled as rejected, never a
          // refresh (plan §4.2, step 8).
          ...(o.source === "cache_unconfirmed" || o.source === "service_worker" ? { unconfirmed: o.source } : {}),
        };
        if (meta.kind === "api") {
          return {
            outcome: { kind: "response", status: o.status, headers: o.headers, bodyText: o.preflight === true ? "" : new TextDecoder("utf-8").decode(body), bodyBytes: o.encodedBytes, ...marked },
            whole: true,
          };
        }
        const media: TransportOutcome = {
          kind: "response",
          status: o.status,
          headers: o.headers,
          bodyText: "",
          bodyBytes: o.encodedBytes,
          ...marked,
          ...(o.bodyOverflow === true ? { bodyOverflow: true } : { bodyBuffer: body }),
        };
        return { outcome: absoluteLocation(media, req.url), whole: true };
      }
    }
  }

  /** Why a prepared request may no longer go (null: it may): the page's
   *  browser generation read again with the live session, and the revision of
   *  the settings the link's hello carried. A moved hello is said again by
   *  the next `prepare` (`ensureHelloCurrent`), after this outcome's commit
   *  and acknowledgement. */
  async function movedSince(meta: Prepared, liveSession: string): Promise<string | null> {
    const [generation, revision] = await Promise.all([
      readBrowserCredentialsGeneration(ctx.db, page.pageId, liveSession),
      client.settingsDigestNow(),
    ]);
    if (generation !== meta.credentialsGeneration) return "the page's stored credentials moved";
    if (client.helloDigest === null || client.helloDigest !== revision) return "the settings of the link's hello moved";
    return null;
  }

  async function sendOne(req: FanslyWireRequest, hooks: SendHooks, signal: AbortSignal, admission: SendAdmission): Promise<TransportOutcome> {
    const meta = prepared.get(req);
    if (meta === undefined) return { kind: "aborted_before_send", refusal: "lease_inactive" };
    if (closed || signal.aborted) return { kind: "aborted_before_send", refusal: "lease_inactive" };
    // The admission must be the link's owner's: another one's goes nowhere.
    if (Number(admission.ownerGeneration) !== client.ownerGeneration) return { kind: "aborted_before_send", refusal: "generation_stale" };
    if (!client.up) {
      unavailableUntil = monoNow() + unavailableRetryMs;
      return { kind: "aborted_before_send", refusal: "transport_unavailable" };
    }
    const attemptId = admission.attemptId;
    let granted = false;
    /** Refused at the check: what it was prepared under moved since. */
    let credentialsChanged = false;
    let reported: number | null = null;
    let settle!: (outcome: TransportOutcome) => void;
    const done = new Promise<TransportOutcome>((resolve) => (settle = resolve));
    let finished = false;
    const finish = (outcome: TransportOutcome) => {
      if (finished) return;
      finished = true;
      settle(outcome);
    };
    const notSent = (refusal: "transport_unavailable" | "lease_inactive") => {
      if (credentialsChanged) return finish({ kind: "aborted_before_send", refusal: "credentials_changed" });
      if (refusal === "transport_unavailable") unavailableUntil = monoNow() + unavailableRetryMs;
      finish({ kind: "aborted_before_send", refusal });
    };
    const maySent = (message: string) => finish(reported === null ? { kind: "transport_error", sent: true, message } : { kind: "transport_error", sent: true, message, sentMono: reported });

    /** The answer to the operation's first check. */
    let firstAnswer: Promise<CheckReply> | null = null;
    const answerCheck = async (check: Check): Promise<CheckReply> => {
      if (finished) return { admit: false, reason: "lease_inactive" };
      if (check.liveSessionFingerprint !== meta.sessionFingerprint) return { admit: false, reason: "session_mismatch" };
      // Right before the grant: the page's stored account and proxy with the
      // live session, and the settings the link's hello carried, are still
      // what the request was prepared under.
      const moved = await movedSince(meta, check.liveSessionFingerprint).catch(() => "the page's credentials do not read");
      if (finished) return { admit: false, reason: "lease_inactive" };
      if (moved !== null) {
        credentialsChanged = true;
        return { admit: false, reason: "lease_inactive" };
      }
      const refusal = hooks.grant();
      if (refusal !== null) return { admit: false, reason: PROTOCOL_REFUSALS.has(refusal.reason) ? (refusal.reason as Refusal) : "lease_inactive" };
      granted = true;
      return { admit: true, deadlineMono: bridge.toKernel(admission.sendDeadlineMono) };
    };
    const unregister = client.register(attemptId, {
      onCheck(check): Promise<CheckReply> {
        // One admission is one check; a second is refused (`lease_used`),
        // never before the first is answered.
        if (firstAnswer !== null) return firstAnswer.then(() => ({ admit: false, reason: "lease_used" }));
        firstAnswer = answerCheck(check);
        return firstAnswer;
      },
      onSent(sent) {
        reported ??= bridge.fromKernel(sent.sentMono) + SEND_REPORT_GUARD_MS;
      },
      onResult(delivered) {
        const { outcome, whole } = outcomeOf(delivered, meta, req, reported, credentialsChanged);
        if (whole) {
          ackable.add(attemptId);
          // An outcome whose commit never proved whole is left with the
          // operator: the oldest of those is forgotten here, never grown.
          if (ackable.size > BROWSER_LATE_OUTCOMES_MAX) ackable.delete(ackable.values().next().value!);
        }
        // An answer this request may not take (another session's) but that
        // arrived whole: kept as a fact by the actor's late intake, then
        // acknowledged. One whose body did not arrive whole is asked for
        // again: the operator keeps it until it is taken.
        else if (delivered.bodyProblem === null) keepLate(heldRequest(delivered));
        else askAgain(attemptId);
        if (outcome.kind === "aborted_before_send" && outcome.refusal === "transport_unavailable") unavailableUntil = monoNow() + unavailableRetryMs;
        finish(outcome);
      },
    });
    const stopLink = client.onLink((status) => {
      // Before the grant nothing can leave: the operator fails the paused
      // request itself when the link goes. After it, its result comes again
      // to the next connection — unless there is none for this owner (the
      // client closed, a newer owner took the operator): it may have gone.
      if (status.kind === "up") return;
      if (!granted) notSent("transport_unavailable");
      else if (status.kind === "closed" || status.kind === "superseded") maySent(`the link to the page's browser ended (${status.kind})`);
    });
    const onAbort = () => (granted ? maySent("cancelled while the page's browser may be sending") : notSent("lease_inactive"));
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => (granted ? maySent(`no result from the page's browser within ${resultWaitMs} ms`) : notSent("transport_unavailable")), resultWaitMs);
    try {
      const now = monoNow();
      const message: Omit<Send, "type" | "ownerGeneration"> = {
        attemptId,
        route: meta.route,
        credentialsGeneration: meta.credentialsGeneration,
        sessionFingerprint: meta.sessionFingerprint,
        method: "GET",
        url: req.url,
        headers: req.headers,
        kind: meta.kind,
        maxBodyBytes: meta.maxBodyBytes,
        sendDeadlineMono: bridge.toKernel(admission.sendDeadlineMono),
        // Never before the send deadline (the operator refuses one that is).
        requestDeadlineMono: bridge.toKernel(Math.max(admission.sendDeadlineMono, now + req.timeoutMs)),
      };
      if (!client.send(message)) notSent("transport_unavailable");
      return await done;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      stopLink();
      unregister();
    }
  }

  function keepLate(answer: HeldAnswer): void {
    if (late.size >= lateMax && !late.has(answer.attemptId)) {
      askAgain(answer.attemptId);
      return;
    }
    late.set(answer.attemptId, answer);
    pending.delete(answer.attemptId);
  }

  /** An outcome the operator keeps that nothing here holds: asked for again. */
  function askAgain(attemptId: number): void {
    if (pending.has(attemptId)) return;
    if (pending.size >= pendingMax) {
      overflowed = true;
      return;
    }
    pending.add(attemptId);
  }

  /** The outcomes asked for again, a chunk at a time, once the late queue
   *  drained; after an overflow, every one the operator keeps (a new hello). */
  function askPending(): void {
    if (asking || late.size > 0 || !client.up || closed) return;
    if (pending.size === 0) {
      if (overflowed) {
        overflowed = false;
        client.reconnect("redeliver the outcomes not kept (more than the transport keeps)");
      }
      return;
    }
    if (monoNow() < askNotBefore) return;
    const chunk = [...pending].slice(0, Math.min(PENDING_RECOVER_CHUNK, lateMax));
    asking = true;
    let unresolved = false;
    void client.recover(chunk).then((answer) => {
      for (const attemptId of chunk) {
        const result = answer.results.get(attemptId);
        const end = answer.ends.get(attemptId);
        if (result !== undefined && result.bodyProblem === null) late.set(attemptId, heldRequest(result));
        else if (end !== undefined) late.set(attemptId, heldEnd(end));
        else if (answer.states.get(attemptId) === "outcome_resent") {
          unresolved = true;
          continue;
        }
        // Taken now, or the operator keeps nothing of it any more.
        pending.delete(attemptId);
      }
    }, () => {
      unresolved = true;
    }).finally(() => {
      asking = false;
      askNotBefore = unresolved ? monoNow() + PENDING_RETRY_MS : Number.NEGATIVE_INFINITY;
    });
  }

  /** The wall-clock instant of a CLOCK_MONOTONIC reading of the operator. */
  function wallOfKernel(kernelMono: number | null): Date | null {
    if (kernelMono === null) return null;
    return new Date(Date.now() - Math.max(0, monoNow() - bridge.fromKernel(kernelMono)));
  }

  /** A held result of an engine request, resolved against its attempt's row:
   *  the session it came under against the one its request carried, and the
   *  outcome as `send` would have given it. */
  function heldRequest(delivered: DeliveredResult): HeldAnswer {
    const attemptId = delivered.result.attemptId;
    return {
      kind: "request",
      attemptId,
      async resolve(attempt: SyncAttemptRow): Promise<HeldRequestOutcome> {
        const media = fanslyWireSpec(attempt.operation as never).host === "cdn";
        const expected = credentialsGenerationOfAttempt(attempt);
        const generation = media ? null : await readBrowserCredentialsGeneration(ctx.db, page.pageId, delivered.result.sessionFingerprint).catch(() => null);
        const sameSession = media || expected === null || generation === expected;
        const o = delivered.result.outcome;
        let url = "";
        if (media && o.kind === "response" && o.status >= 300 && o.status <= 399 && attempt.workId !== null) {
          // A redirect's Location is made absolute against the hop's URL (the
          // work's secret), as for a request in flight.
          const ciphertext = await readSyncWorkSecretParams(ctx.db, attempt.workId).catch(() => null);
          try {
            if (ciphertext !== null) url = String(decryptSyncWorkSecret<Partial<MediaDownloadSecret>>(ctx.config, ciphertext).url ?? "");
          } catch {
            url = "";
          }
        }
        const meta: Prepared = {
          route: attempt.operation,
          kind: media ? "image" : "api",
          maxBodyBytes: media ? MEDIA_DOWNLOAD_MAX_BYTES : FANSLY_WIRE_MAX_BODY_BYTES,
          sessionFingerprint: delivered.result.sessionFingerprint,
          credentialsGeneration: expected ?? "",
        };
        const req: FanslyWireRequest = { spec: attempt.operation as never, url, headers: {}, timeoutMs: REQUEST_TIMEOUT_MS, credentialsGeneration: expected ?? "" };
        const { outcome, whole } = outcomeOf(delivered, meta, req, null, false);
        // Its `sent` went to an earlier link, if anywhere: the send instant
        // is unknown (the result's own proves nothing).
        return { outcome, sameSession, whole, sentWall: null };
      },
    };
  }

  /** A site request's or a site socket's end, as the site path takes it. */
  function heldEnd(end: SiteDone | WsDone): HeldAnswer {
    if (end.type === "wsDone" && end.fate === "unknown") return { kind: "unknown", attemptId: end.attemptId, held: true };
    const siteEnd: SiteRequestEnd = siteRequestEndOf(end, bridge);
    return { kind: "site", attemptId: end.attemptId, end: siteEnd, sentWall: end.sent ? wallOfKernel(end.sentMono) : null };
  }

  client.onUnclaimedResult((delivered) => {
    // A body that did not arrive whole is asked for again.
    if (delivered.bodyProblem !== null) askAgain(delivered.result.attemptId);
    else keepLate(heldRequest(delivered));
  });
  client.onUnclaimedOutcome((end) => keepLate(heldEnd(end)));

  const held: HeldOutcomeSource = {
    async recover(attemptIds, waitMs) {
      if (attemptIds.length === 0) return new Map();
      const deadline = monoNow() + Math.min(waitMs, recoverWaitMs);
      // After the operator's quiesced: an earlier owner's request it still
      // ends has its outcome by then (plan §4.7).
      while ((!client.up || client.quiesced === null) && !closed && monoNow() < deadline) {
        const status = client.status.kind;
        if (status === "superseded" || status === "refused" || status === "closed") return null;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!client.up || client.quiesced === null) return null;
      let answer: Awaited<ReturnType<typeof client.recover>> | null;
      let timer: NodeJS.Timeout | undefined;
      try {
        // An answer later than the wait is not waited for: the outcomes it
        // resends on the way come as late ones.
        answer = await Promise.race([
          client.recover(attemptIds),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), Math.max(0, deadline - monoNow()));
          }),
        ]);
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
      if (answer === null) return null;
      const answers = new Map<number, HeldAnswer>();
      for (const attemptId of attemptIds) {
        const result = answer.results.get(attemptId);
        const end = answer.ends.get(attemptId);
        // An outcome resent whole is the attempt's; one whose body did not
        // arrive whole is not known (the operator keeps it).
        if (result !== undefined && result.bodyProblem === null) answers.set(attemptId, heldRequest(result));
        else if (end !== undefined) answers.set(attemptId, heldEnd(end));
        else if (answer.states.get(attemptId) === "not_sent") answers.set(attemptId, { kind: "not_sent", attemptId });
        else answers.set(attemptId, { kind: "unknown", attemptId });
        late.delete(attemptId);
        pending.delete(attemptId);
        // Resent with a body that did not arrive whole: asked for again.
        if (result !== undefined && result.bodyProblem !== null) askAgain(attemptId);
      }
      return answers;
    },
    takeLate(max) {
      askPending();
      const taken: HeldAnswer[] = [];
      for (const [attemptId, answer] of late) {
        if (taken.length >= max) break;
        taken.push(answer);
        late.delete(attemptId);
      }
      return taken;
    },
    retry(attemptIds) {
      for (const attemptId of attemptIds) askAgain(attemptId);
    },
    acknowledge(attemptId) {
      ackable.delete(attemptId);
      client.resultAck(attemptId);
    },
  };

  return {
    held,
    needsSiteBootstrap: () => client.state?.sessionFingerprint == null,
    needsSessionConfirmation: () => {
      const state = client.state;
      return state !== null && state.step === "site_loaded" && state.sessionFingerprint !== null && state.accountId === null;
    },
    async prepare(request: RequestPlan, context?: { work: SyncWorkRow }): Promise<FanslyWireRequest> {
      const refused = refusalNow();
      if (refused !== null) throw refused;
      switch (fanslyWireSpec(request.spec).host) {
        case "ws":
          // The site opens its own socket on a browser page; its Upgrade is
          // admitted on the site path (plan §3.2 «Кадры сокета»).
          throw new UnsendableRequestError("browser_socket_is_the_sites", { failure: "browser_socket_is_the_sites", httpStatus: null });
        case "api":
          await ensureHelloCurrent();
          return prepareApi(request, context?.work);
        case "cdn":
          await ensureHelloCurrent();
          return prepareCdn(request, context?.work);
      }
    },
    send: sendOne,
    settled(attemptId: number): void {
      if (!ackable.delete(attemptId)) return;
      client.resultAck(attemptId);
    },
    async storedCredentialsGeneration(): Promise<string | null> {
      const fingerprint = client.state?.sessionFingerprint ?? null;
      if (fingerprint === null) return null;
      try {
        return await readBrowserCredentialsGeneration(ctx.db, page.pageId, fingerprint);
      } catch {
        return null;
      }
    },
    // Variant Б: what a proof of the site's own `/account/me` under that
    // session proves — the generation of the page's browser with it.
    async siteCredentialsGeneration(sessionFingerprint: string): Promise<string | null> {
      try {
        return await readBrowserCredentialsGeneration(ctx.db, page.pageId, sessionFingerprint);
      } catch {
        return null;
      }
    },
    async close() {
      closed = true;
      await client.close();
    },
  };
}
