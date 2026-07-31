// Voice-notes service (Task 5): admission, idempotent replay, single-dispatch
// CAS, and the fenced terminal settle. This is the ONLY layer standing between
// a client retry and a double-billed ElevenLabs synthesis, so every path is
// deliberate:
//
//   - createVoiceNote admits at most one billable render per (user,
//     clientRequestId). A replay of an already-admitted request re-runs NO
//     admission gate — only authn + page access — and never dispatches twice.
//   - The provider call is DETACHED (fire-and-forget) with its own AbortSignal:
//     a client disconnect must never abort an in-flight, billable synthesis.
//   - The terminal settle is FENCED by the attempt token; a lost fence (the
//     lease sweep already reclaimed the row) is a strict no-op.
//   - The character budget is reserved before the row exists and reconciled or
//     released on every terminal path; an indeterminate outcome keeps the
//     estimate charged and defers to the lease sweep.

import { randomUUID } from "node:crypto";

import {
  casVoiceNoteDispatch,
  getAiGenerationContentByRef,
  getScopedVoiceNoteAudio,
  getVoiceNoteByClientRequestId,
  getVoiceNoteStatusById,
  getVoiceNoteStatusByClientRequestId,
  getVoiceProfile,
  insertVoiceNoteJob,
  isDmArchiveScopeFenced,
  reserveVoiceCharBudget,
  settleVoiceCharBudget,
  settleVoiceNoteTerminal,
  touchQueuedVoiceNote,
  tryAcquireDmArchiveWriterFenceLock,
  type VoiceNoteRow,
  type VoiceNoteState,
  type VoiceNoteStatusRow,
} from "@agency_hub_core/db";
import { findPageByLabel } from "@agency_hub_core/db";
import {
  redactSensitiveText,
  sanitizeError,
  type SanitizeErrorOptions,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { canAccessPage, type AuthPrincipal } from "./auth.ts";
import { resolveEgress, type AppEgressContext } from "./egress/resolver.ts";
import { hasServiceEgressProxy } from "./egress/service-proxy.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import { AppError, NotFoundError } from "./errors.ts";
import {
  isValidVoiceCharacterCost,
  VOICE_AUDIO_MAX_BYTES,
} from "./voice-elevenlabs-provider.ts";
import {
  canonicalizeVoiceScript,
  computeVoiceRequestHash,
  sha256Hex,
  validateVoiceScript,
  type VoiceScriptRejection,
} from "./voice-script-validation.ts";

// The subset of the app context the service reads. `voiceTtsProvider` is
// present whenever ELEVENLABS_API_KEY and the service proxy were configured at boot; the presence
// check below is deliberately separate from the live `voiceNotesEnabled` flag
// (the flag is the spend gate; provider presence is the boot-readiness gate).
type VoiceNotesApp = Pick<AppContext, "db" | "config" | "logger" | "voiceTtsProvider">;

/** Single-dispatch lease: matches the sweep's reclaim window. */
const DISPATCH_LEASE_MS = 120_000;
/** Queued waiters refresh updated_at well inside the five-minute crash cutoff. */
const QUEUED_HEARTBEAT_MS = 60_000;

// Fallbacks that mirror the config-registry defaults. In production the boot
// AppConfig always carries these (zod defaults), so they only guard test
// contexts that construct config by hand.
const DEFAULT_SCRIPT_MAX_CHARS = 600;
const DEFAULT_PAGE_BUDGET = 5000;
const DEFAULT_GLOBAL_BUDGET = 20000;
const DEFAULT_MAX_CONCURRENT_SYNTHESES = 2;
const VOICE_LOG_ERROR_OPTIONS = {
  maxChars: 512,
  truncation: "clip",
  queryStyleMessage: ({ name, code }) => `${name}${code ? ` (${code})` : ""}`,
} satisfies SanitizeErrorOptions;

type ReleaseVoiceSynthesisPermit = () => void;

/** Process-local concurrency gate. Production runs one API process; queued
 * rows wait here before their dispatch CAS and heartbeat durable ownership so
 * the crash sweeper cannot reclaim a live waiter. */
class VoiceSynthesisGate {
  private active = 0;
  private limit = DEFAULT_MAX_CONCURRENT_SYNTHESES;
  private readonly waiters: Array<(release: ReleaseVoiceSynthesisPermit) => void> = [];

  setLimit(value: number): void {
    this.limit = Math.max(1, Math.floor(value));
    this.drain();
  }

  tryAcquire(): ReleaseVoiceSynthesisPermit | null {
    if (this.active >= this.limit) {
      return null;
    }
    this.active += 1;
    return this.makeRelease();
  }

  acquire(): Promise<ReleaseVoiceSynthesisPermit> {
    const immediate = this.tryAcquire();
    if (immediate) {
      return Promise.resolve(immediate);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  occupancyWithinLimit(): boolean {
    return this.active <= this.limit;
  }

  private makeRelease(): ReleaseVoiceSynthesisPermit {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const resolve = this.waiters.shift()!;
      this.active += 1;
      resolve(this.makeRelease());
    }
  }
}

const voiceSynthesisGate = new VoiceSynthesisGate();

// Internal rollback sentinel: thrown inside the reserve+insert transaction when
// the queued insert loses the unique (user, clientRequestId) race, so drizzle
// rolls the whole tx back — the budget reservation included — rather than
// leaving it stranded. Caught in createVoiceNote to replay the winner. Mirrors
// the BudgetRefused idiom the repo's reserveVoiceCharBudget already uses.
class VoiceAdmissionLostRace extends Error {}
class VoiceBudgetRefused extends Error {}

export interface CreateVoiceNoteBody {
  clientRequestId: string;
  conversationRef: string;
  sourceGenerationRef: string;
  script: string;
}

/**
 * The projection returned to the client. NEVER carries audio bytes; `createdAt`
 * gives the takes list a stable client-side order. `errorCode` is present only
 * for terminal non-success states.
 */
export interface VoiceNoteStatusView {
  voiceNoteId: number;
  state: VoiceNoteState;
  scriptChars: number;
  billed: boolean | null;
  audioSha256: string | null;
  audioBytesLen: number | null;
  createdAt: string;
  errorCode?: string;
}

// ── Structured errors (AppError → { error: code, statusCode, message }) ───────

export class VoiceDisabledError extends AppError {
  constructor() {
    super("Voice notes are disabled", 403, "voice_disabled");
  }
}

/** Retryable availability response: key/proxy boot dependencies are incomplete
 * or an active erasure temporarily owns the page writer fence. Distinct from
 * voice_disabled; neither path admits provider spend. */
export class VoiceProviderUnavailableError extends AppError {
  constructor() {
    super(
      "Voice notes are temporarily unavailable. Please try again later.",
      503,
      "voice_provider_unavailable",
    );
  }
}

export class VoiceNotAllowlistedError extends AppError {
  constructor() {
    super("This page is not allowlisted for voice notes", 403, "voice_not_allowlisted");
  }
}

export class VoiceNoProfileError extends AppError {
  constructor() {
    super("This page has no voice profile configured", 409, "voice_no_profile");
  }
}

export class VoiceScriptInvalidError extends AppError {
  constructor(message: string) {
    super(message, 400, "voice_script_invalid");
  }
}

export class VoiceSourceInvalidError extends AppError {
  constructor(message?: string) {
    super(
      message
        ?? "The source voice-script generation is missing, ineligible, or not owned by this page",
      400,
      "voice_source_invalid",
    );
  }
}

export class VoiceQuotaDeniedError extends AppError {
  constructor() {
    super("Voice notes daily character budget exceeded", 429, "voice_quota_denied");
  }
}

export class VoiceIdempotencyMismatchError extends AppError {
  constructor() {
    super("clientRequestId already used with a different request", 409, "idempotency_mismatch");
  }
}

export class VoiceArtifactExpiredError extends AppError {
  constructor() {
    super("Voice note audio has expired", 410, "artifact_expired");
  }
}

export class VoiceRetrievalDisabledError extends AppError {
  constructor() {
    super("Voice note retrieval is disabled", 403, "voice_retrieval_disabled");
  }
}

/** Integrity failure: stored sha256 disagrees with the stored bytes. */
export class VoiceArtifactCorruptError extends AppError {
  constructor() {
    super("Voice note audio failed its integrity check", 500, "voice_artifact_corrupt");
  }
}

// ── Public surface ───────────────────────────────────────────────────────────

/**
 * Admit (or replay) a voice-note render. Returns the queued/dispatched view
 * immediately (202 semantics); the provider call runs detached. Throws the
 * structured errors above; a duplicate `clientRequestId` with the same request
 * hash replays without re-admission, a different hash is a 409.
 */
export async function createVoiceNote(
  // Full AppContext (not the narrow VoiceNotesApp): the detached dispatch below
  // resolves the ElevenLabs vendor egress seam, which needs the whole context.
  // The routes and tests already pass a full AppContext.
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
  body: CreateVoiceNoteBody,
): Promise<VoiceNoteStatusView> {
  // Page resolution + access are the ONLY gates the replay path is permitted to
  // re-run. Everything below the idempotency lookup is fresh-admission-only.
  const page = await resolveAccessiblePage(app, principal, pageLabel);

  // The refs feed computeVoiceRequestHash with '\n' as the field delimiter, so a
  // control char in either ref could forge a hash collision across distinct
  // (conversationRef, sourceGenerationRef) pairs. The hash format is frozen law,
  // so we reject at admission — before hashing — rather than sanitising.
  assertRefControlCharFree("conversationRef", body.conversationRef);
  assertRefControlCharFree("sourceGenerationRef", body.sourceGenerationRef);

  const canonicalScript = canonicalizeVoiceScript(body.script);
  const requestHash = computeVoiceRequestHash({
    pageId: page.id,
    conversationRef: body.conversationRef,
    sourceGenerationRef: body.sourceGenerationRef,
    canonicalScript,
  });

  // (1) Idempotent replay — short-circuits WITHOUT re-running any admission
  // gate. A body that hashes differently under the same id is a client bug.
  // Projected read: the replay only needs the request-hash compare + the status
  // view, never the audio bytes.
  const existing = await getVoiceNoteStatusByClientRequestId(app.db, principal.user.id, body.clientRequestId);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new VoiceIdempotencyMismatchError();
    }
    return replayTerminalOrView(existing);
  }

  // (2) Fresh admission, in order.
  const effective = await loadEffectiveConfig(app.db, app.config);
  if (effective.voiceNotesEnabled !== true) {
    throw new VoiceDisabledError();
  }
  // Distinct from the flag: the provider is built at boot iff the key and
  // complete service-proxy tuple are configured. This check remains before
  // profile/budget/row work, so an unavailable route cannot admit spend.
  if (!app.voiceTtsProvider) {
    app.logger.warn({
      component: "voice_notes",
      event: "voice_provider_unavailable",
      elevenLabsApiKeyConfigured: Boolean(app.config.elevenLabsApiKey?.trim()),
      serviceEgressProxyConfigured: hasServiceEgressProxy(app.config),
    }, "Voice provider unavailable: configure ELEVENLABS_API_KEY and the complete SERVICE_EGRESS_PROXY_* tuple, then restart the runtime");
    throw new VoiceProviderUnavailableError();
  }
  // Check the RESOLVED canonical label, never the caller's raw pageLabel string.
  if (!isPageAllowlisted(effective.voiceNotesPageAllowlist, page.label)) {
    throw new VoiceNotAllowlistedError();
  }
  const profile = await getVoiceProfile(app.db, page.id);
  if (!profile) {
    throw new VoiceNoProfileError();
  }
  const maxChars = effective.voiceNotesScriptMaxChars ?? DEFAULT_SCRIPT_MAX_CHARS;
  const validation = validateVoiceScript(canonicalScript, maxChars);
  if (!validation.ok) {
    throw new VoiceScriptInvalidError(describeScriptRejection(validation));
  }
  const scriptChars = validation.chars;

  // Source generation: a terminal-success voice-script generation owned by the
  // same principal on the same page and conversation (the restricted-capture
  // row is the ledger).
  const source = await getAiGenerationContentByRef(app.db, body.sourceGenerationRef);
  if (
    !source
    || source.generation.feature !== "voice-script"
    || source.generation.userId !== principal.user.id
    || source.generation.pageId !== page.id
    || source.generation.conversationRef !== body.conversationRef
    || source.generation.fanRef !== body.conversationRef
    || (source.generation.params as { outcome?: unknown }).outcome !== "completed"
  ) {
    throw new VoiceSourceInvalidError();
  }
  // A "completed" outcome is NOT proof the script is whole: the gateway records
  // outcome="completed" even when the model hit its token ceiling, leaving the
  // truncation only in params.stopReason ("max_tokens" for Anthropic, "length"
  // for OpenRouter/OpenAI). Synthesizing a truncated prefix bills ElevenLabs for
  // a cut-off take, so reject it before admission. Name the reason, never the
  // script text.
  const stopReason = (source.generation.params as { stopReason?: unknown }).stopReason;
  if (stopReason === "max_tokens" || stopReason === "length") {
    throw new VoiceSourceInvalidError(
      `The source voice-script generation was truncated (stopReason "${stopReason}"); `
        + "regenerate a complete script before synthesis",
    );
  }
  const originalScriptSha256 = sha256Hex(canonicalizeVoiceScript(source.generation.completion));
  const finalScriptSha256 = sha256Hex(canonicalScript);
  const sourceMaterialAt = source.generation.createdAt;

  const now = new Date();
  const pageBudget = effective.voiceNotesDailyCharBudget ?? DEFAULT_PAGE_BUDGET;
  const globalBudget = effective.voiceNotesGlobalDailyCharBudget ?? DEFAULT_GLOBAL_BUDGET;
  voiceSynthesisGate.setLimit(
    effective.voiceNotesMaxConcurrentSyntheses ?? DEFAULT_MAX_CONCURRENT_SYNTHESES,
  );

  const snapshot = {
    userId: principal.user.id,
    platformAccountId: page.id,
    conversationRef: body.conversationRef,
    sourceGenerationRef: body.sourceGenerationRef,
    clientRequestId: body.clientRequestId,
    requestHash,
    scriptChars,
    originalScriptSha256,
    finalScriptSha256,
    scriptEdited: originalScriptSha256 !== finalScriptSha256,
    profileVoiceId: profile.voiceId,
    profileModel: profile.model,
    profileSettings: profile.settings,
    profileOutputFormat: profile.outputFormat,
    profileVersion: profile.version,
    // This is the same instant reserveVoiceCharBudget uses below. Pinning it on
    // the row prevents a transaction that crosses UTC midnight from reserving
    // one day's counter but later refunding the next day's counter.
    createdAt: now,
  };

  // (3+4) Reserve the character budget AND record the idempotency row in ONE
  // transaction. Wrapping both closes two windows the two-commit version left
  // open: (a) a crash between the reserve and the insert can no longer strand a
  // reservation with no row to carry it (a rollback releases it), and (b) the
  // reserve holds its budget-row lock THROUGH the insert, so a same-budget
  // competitor cannot change the decision mid-admission. A refused reservation
  // writes no durable row: fresh UUIDs after exhaustion must not create
  // unbounded permanent storage. Losing the unique race throws a sentinel to
  // roll the whole reservation back (the rollback IS the release).
  try {
    await app.db.transaction(async (tx) => {
      // Voice stores fan-derived script/audio outside the DM tables, but joins
      // the same page advisory-lock + material-time tombstone protocol.
      if (!(await tryAcquireDmArchiveWriterFenceLock(tx, page.id))) {
        throw new VoiceProviderUnavailableError();
      }
      if (
        await isDmArchiveScopeFenced(tx, {
          pageId: page.id,
          platform: "fansly",
          refs: [body.conversationRef],
          materialAt: sourceMaterialAt,
        })
      ) {
        throw new VoiceSourceInvalidError(
          "The source voice-script generation is covered by an erasure",
        );
      }

      const reserved = await reserveVoiceCharBudget(tx, {
        pageId: page.id,
        chars: scriptChars,
        pageBudget,
        globalBudget,
        now,
      });
      if (!reserved) {
        // A same-clientRequestId winner may have consumed the final budget
        // while this transaction waited on the counter row. Roll back first,
        // then re-read the idempotency key outside the transaction.
        throw new VoiceBudgetRefused();
      }
      const insertResult = await insertVoiceNoteJob(tx, snapshot);
      if (!insertResult.inserted) {
        // A concurrent duplicate already claimed this (user, clientRequestId).
        // Abort the tx so the reservation rolls back, then replay its row below.
        throw new VoiceAdmissionLostRace();
      }
    });
  } catch (error) {
    if (error instanceof VoiceAdmissionLostRace) {
      return await replayConcurrentWinner(app, principal, body.clientRequestId, requestHash);
    }
    if (error instanceof VoiceBudgetRefused) {
      const winner = await getVoiceNoteStatusByClientRequestId(
        app.db,
        principal.user.id,
        body.clientRequestId,
      );
      if (winner) {
        if (winner.requestHash !== requestHash) {
          throw new VoiceIdempotencyMismatchError();
        }
        return replayTerminalOrView(winner);
      }
      throw new VoiceQuotaDeniedError();
    }
    throw error;
  }

  const row = await getVoiceNoteByClientRequestId(app.db, principal.user.id, body.clientRequestId);
  if (!row) {
    // The row we just inserted must exist; a null here is a hard invariant break.
    throw new Error("voice note row missing immediately after a winning insert");
  }

  // (5) Concurrency permit BEFORE the single-dispatch CAS. A queued waiter
  // heartbeats updated_at until a slot opens, so only a crashed process becomes
  // eligible for the five-minute unbilled sweep.
  const permit = voiceSynthesisGate.tryAcquire();
  if (!permit) {
    void dispatchVoiceNoteAfterPermit(app, {
      row,
      pageLabel: page.label,
      reservedChars: scriptChars,
      canonicalScript,
      now,
      sourceMaterialAt,
    });
    return toStatusView(row);
  }

  // (6) The provider call runs detached with its own signal, then fences the
  // settle. The synthesis permit is held until that task has fully settled.
  const won = await grantVoiceNoteDispatch(app, {
    row,
    pageLabel: page.label,
    reservedChars: scriptChars,
    canonicalScript,
    now,
    sourceMaterialAt,
  }, permit);
  if (won) {
    return toStatusView({ ...row, state: "dispatched" });
  }
  // CAS lost (an erasure or sweep raced us): re-read just the status
  // projection. This path never dispatches and never returns audio.
  const latest = await getVoiceNoteStatusById(app.db, row.id);
  return toStatusView(latest ?? row);
}

async function grantVoiceNoteDispatch(
  app: AppContext,
  input: {
    row: VoiceNoteRow;
    pageLabel: string;
    reservedChars: number;
    canonicalScript: string;
    now: Date;
    sourceMaterialAt: Date;
  },
  releasePermit: ReleaseVoiceSynthesisPermit,
): Promise<boolean> {
  const attemptToken = randomUUID();
  let won: boolean;
  try {
    won = await app.db.transaction(async (tx) => {
      // Re-enter the erasure writer protocol immediately before the one paid
      // dispatch CAS. An erasure beginning after admission can delete/fence the
      // row, but can never be followed by a provider call for the old material.
      if (!(await tryAcquireDmArchiveWriterFenceLock(tx, input.row.platformAccountId))) {
        return false;
      }
      if (
        await isDmArchiveScopeFenced(tx, {
          pageId: input.row.platformAccountId,
          platform: "fansly",
          refs: [input.row.conversationRef],
          materialAt: input.sourceMaterialAt,
        })
      ) {
        return false;
      }
      return await casVoiceNoteDispatch(tx, {
        id: input.row.id,
        attemptToken,
        leaseUntil: new Date(Date.now() + DISPATCH_LEASE_MS),
      });
    });
  } catch (error) {
    releasePermit();
    throw error;
  }
  if (!won) {
    releasePermit();
    return false;
  }

  void runGrantedVoiceNoteDispatch(app, {
    ...input,
    attemptToken,
  }, releasePermit);
  return true;
}

async function runGrantedVoiceNoteDispatch(
  app: AppContext,
  input: {
    row: VoiceNoteRow;
    pageLabel: string;
    attemptToken: string;
    reservedChars: number;
    canonicalScript: string;
    now: Date;
  },
  releasePermit: ReleaseVoiceSynthesisPermit,
): Promise<void> {
  try {
    await dispatchVoiceNote(app, input);
  } catch (error) {
    // dispatchVoiceNote handles provider/settle faults itself; this final guard
    // covers only an unexpected failure from its cleanup path.
    const observed = sanitizeError(error, VOICE_LOG_ERROR_OPTIONS);
    app.logger.error(
      {
        voiceNoteId: input.row.id,
        error: {
          name: observed.name,
          code: observed.code,
          message: observed.message,
        },
      },
      "voice note dispatch cleanup failed unexpectedly",
    );
  } finally {
    releasePermit();
  }
}

async function dispatchVoiceNoteAfterPermit(
  app: AppContext,
  input: {
    row: VoiceNoteRow;
    pageLabel: string;
    reservedChars: number;
    canonicalScript: string;
    now: Date;
    sourceMaterialAt: Date;
  },
): Promise<void> {
  let heartbeatInFlight = false;
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight) {
      return;
    }
    heartbeatInFlight = true;
    void touchQueuedVoiceNote(app.db, input.row.id)
      .then((touched) => {
        if (!touched) {
          clearInterval(heartbeat);
        }
      })
      .catch((error) => {
        const observed = sanitizeError(error, VOICE_LOG_ERROR_OPTIONS);
        app.logger.warn(
          {
            voiceNoteId: input.row.id,
            error: {
              name: observed.name,
              code: observed.code,
              message: observed.message,
            },
          },
          "queued voice note heartbeat failed",
        );
      })
      .finally(() => {
        heartbeatInFlight = false;
      });
  }, QUEUED_HEARTBEAT_MS);
  heartbeat.unref();

  let permit: ReleaseVoiceSynthesisPermit | undefined;
  try {
    permit = await voiceSynthesisGate.acquire();
    while (true) {
      // A queued row can wait materially longer than the admitting request.
      // Re-read all live dispatch gates after each permit arrival and before
      // granting the one paid dispatch.
      const effective = await loadEffectiveConfig(app.db, app.config);
      voiceSynthesisGate.setLimit(
        effective.voiceNotesMaxConcurrentSyntheses ?? DEFAULT_MAX_CONCURRENT_SYNTHESES,
      );
      if (
        effective.voiceNotesEnabled !== true
        || !isPageAllowlisted(effective.voiceNotesPageAllowlist, input.pageLabel)
      ) {
        permit();
        permit = undefined;
        return;
      }
      // The limit may have been lowered while this row waited. Its permit was
      // granted under the previous limit, so yield and re-enter the gate instead
      // of temporarily overshooting the newly-read live value.
      if (voiceSynthesisGate.occupancyWithinLimit()) {
        break;
      }
      permit();
      permit = undefined;
      permit = await voiceSynthesisGate.acquire();
    }

    const grantedPermit = permit;
    permit = undefined;
    await grantVoiceNoteDispatch(app, input, grantedPermit);
  } catch (error) {
    permit?.();
    // A config/CAS/read fault happened before provider dispatch. Leave the row
    // queued; with no live heartbeat after this function exits, the existing
    // crash sweep refunds it after the abandonment window.
    const observed = sanitizeError(error, VOICE_LOG_ERROR_OPTIONS);
    app.logger.error(
      {
        voiceNoteId: input.row.id,
        error: {
          name: observed.name,
          code: observed.code,
          message: observed.message,
        },
      },
      "queued voice note could not claim a dispatch slot",
    );
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Read a render's status. authn + page access + retrieval switch, then a
 * (id, page, user) tuple lookup — a miss is an indistinguishable 404.
 */
export async function getVoiceNoteStatus(
  app: VoiceNotesApp,
  principal: AuthPrincipal,
  pageLabel: string,
  id: number,
): Promise<VoiceNoteStatusView> {
  const page = await resolveAccessiblePage(app, principal, pageLabel);
  await assertRetrievalEnabled(app);
  // Status never returns audio → read the projection (no 2 MiB detoast per poll).
  const row = await getScopedVoiceNoteStatus(app, principal, page.id, id);
  return toStatusView(row);
}

/**
 * Read a completed render's audio bytes. Same guards as status, plus: the row
 * must be `completed` with bytes; an expired artifact is a 410; the stored
 * sha256 is verified before the bytes are returned.
 */
export async function getVoiceNoteAudio(
  app: VoiceNotesApp,
  principal: AuthPrincipal,
  pageLabel: string,
  id: number,
): Promise<{ bytes: Buffer; sha256: string }> {
  const page = await resolveAccessiblePage(app, principal, pageLabel);
  await assertRetrievalEnabled(app);
  const row = await getScopedVoiceNoteAudio(app.db, {
    id,
    platformAccountId: page.id,
    userId: principal.user.id,
  });
  if (!row) {
    throw new NotFoundError("Voice note not found");
  }

  if (row.state === "artifact_expired") {
    throw new VoiceArtifactExpiredError();
  }
  if (row.state !== "completed" || row.audioBytes == null) {
    // Not-yet-ready and never-produced are indistinguishable from missing.
    throw new NotFoundError("Voice note audio not available");
  }
  const bytes = Buffer.isBuffer(row.audioBytes)
    ? row.audioBytes
    : Buffer.from(row.audioBytes as Uint8Array);
  const sha256 = sha256Hex(bytes);
  if (row.audioSha256 != null && sha256 !== row.audioSha256) {
    throw new VoiceArtifactCorruptError();
  }
  return { bytes, sha256 };
}

// ── Internals ────────────────────────────────────────────────────────────────

async function resolveAccessiblePage(
  app: VoiceNotesApp,
  principal: AuthPrincipal,
  pageLabel: string,
): Promise<{ id: number; label: string }> {
  const stored = await findPageByLabel(app.db, pageLabel);
  if (!stored || !canAccessPage(principal, stored.page.id)) {
    // Existence and access are indistinguishable (mirrors the AI feature lane).
    throw new NotFoundError("Page not found");
  }
  return { id: stored.page.id, label: stored.page.label };
}

async function assertRetrievalEnabled(app: VoiceNotesApp): Promise<void> {
  const effective = await loadEffectiveConfig(app.db, app.config);
  // Default-on: only an explicit false (incident switch) blocks retrieval.
  if (effective.voiceNotesRetrievalEnabled === false) {
    throw new VoiceRetrievalDisabledError();
  }
}

// Projected scoped read for status: same (id, page, user) guard, no audio bytes.
async function getScopedVoiceNoteStatus(
  app: VoiceNotesApp,
  principal: AuthPrincipal,
  pageId: number,
  id: number,
): Promise<VoiceNoteStatusRow> {
  const row = await getVoiceNoteStatusById(app.db, id);
  if (!row || row.platformAccountId !== pageId || row.userId !== principal.user.id) {
    throw new NotFoundError("Voice note not found");
  }
  return row;
}

/** Re-read after a lost admission race and replay the winner's row. */
async function replayConcurrentWinner(
  app: VoiceNotesApp,
  principal: AuthPrincipal,
  clientRequestId: string,
  requestHash: string,
): Promise<VoiceNoteStatusView> {
  // Projected read: this replay only compares the request hash and returns the
  // status view — never the audio bytes.
  const other = await getVoiceNoteStatusByClientRequestId(app.db, principal.user.id, clientRequestId);
  if (!other) {
    // The conflict target matched, so a row must exist; a null is an invariant break.
    throw new Error("voice note admission race: winning row not found on re-read");
  }
  if (other.requestHash !== requestHash) {
    throw new VoiceIdempotencyMismatchError();
  }
  return replayTerminalOrView(other);
}

/**
 * Legacy `quota_denied` rows created before Decision #190 still replay their
 * original 429 rather than becoming pollable terminal views. New quota
 * refusals are stateless and never enter this branch.
 */
function replayTerminalOrView(row: VoiceNoteViewFields): VoiceNoteStatusView {
  if (row.state === "quota_denied") {
    throw new VoiceQuotaDeniedError();
  }
  return toStatusView(row);
}

// Control characters (U+0000–U+001F, U+007F) are rejected before a request ever
// reaches computeVoiceRequestHash — see the admission call site for why. A
// char-code scan (not a regex) keeps the control bytes out of the source and
// clear of no-control-regex.
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function assertRefControlCharFree(
  field: "conversationRef" | "sourceGenerationRef",
  value: string,
): void {
  if (hasControlChar(value)) {
    // Name the offending FIELD only — never echo the (client-controlled) value.
    throw new VoiceSourceInvalidError(`The ${field} field contains a control character`);
  }
}

/**
 * The detached provider call + fenced settle. Runs fire-and-forget; the
 * request's abort is deliberately NOT wired in. Every terminal decision is
 * fenced by the attempt token — a lost fence is a strict no-op — and the budget
 * is reconciled/released only when the fence is won.
 */
// Exported for the log-hygiene test (a forced settle fault must not spill the
// audio buffer into the log); production callers still fire it fire-and-forget.
export async function dispatchVoiceNote(
  app: AppContext,
  input: {
    row: VoiceNoteRow;
    attemptToken: string;
    reservedChars: number;
    canonicalScript: string;
    now: Date;
  },
): Promise<void> {
  const provider = app.voiceTtsProvider;
  if (!provider) {
    // Presence was checked before dispatch fired; if it somehow vanished, leave
    // the row dispatched for the lease sweep.
    return;
  }
  const { row } = input;
  // Detached lifetime: a fresh controller NOT linked to any request signal — a
  // client disconnect must never abort an in-flight, billable synthesis.
  const controller = new AbortController();
  const startedAt = Date.now();
  // Resolve a fresh service dispatcher once per dispatch. It is reused for the
  // provider's sole request and closed in finally; Telegram operations resolve
  // independent dispatchers carrying the same stable service egress identity.
  let egress: AppEgressContext | undefined;

  try {
    egress = await resolveEgress(app, { kind: "vendor", vendor: "elevenlabs" });
    await egress.pace("interactive");
    if (!egress.dispatcher) {
      throw new Error("ElevenLabs service egress resolved without a dispatcher");
    }
    const result = await provider.synthesize({
      voiceId: row.profileVoiceId,
      model: row.profileModel,
      settings: row.profileSettings,
      outputFormat: row.profileOutputFormat,
      text: input.canonicalScript,
      signal: controller.signal,
      dispatcher: egress.dispatcher,
    });

    if (result.ok) {
      // Size fence BEFORE the terminal settle: the `voice_notes_audio_cap` CHECK
      // rejects audio_bytes_len > 2 MiB, so writing oversize bytes would throw
      // inside settleVoiceNoteTerminal, leave the row 'dispatched', and defer to
      // the sweep as 'indeterminate' — with the vendor ALREADY billed. Settle it
      // deterministically as failed_after_dispatch (billed-unknown, estimate
      // kept charged) instead. The provider refuses oversize before this in
      // production; this guards a provider that hands back an oversize buffer.
      if (result.audio.byteLength > VOICE_AUDIO_MAX_BYTES) {
        app.logger.warn(
          {
            voiceNoteId: row.id,
            egressKey: egress?.egressKey,
            audioBytesLen: result.audio.byteLength,
            cap: VOICE_AUDIO_MAX_BYTES,
          },
          "voice note audio exceeds size cap; settling failed_after_dispatch (billed-unknown)",
        );
        await settleVoiceNoteTerminal(app.db, {
          id: row.id,
          attemptToken: input.attemptToken,
          state: "failed_after_dispatch",
          // Oversize means the vendor DID synthesize (and may have billed), we
          // just can't keep the artifact → billing unknown, estimate kept.
          billed: null,
          billedChars: null,
          providerRequestId: null,
          providerTraceId: null,
          providerRegion: null,
          audioBytes: null,
          audioSha256: null,
          audioBytesLen: null,
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      const audioSha256 = sha256Hex(result.audio);
      // A completed take IS billed — the vendor synthesized it. A missing cost
      // header only means we cannot reconcile the estimate to actuals, NOT that
      // the synthesis was free, so the billing verdict is `true` regardless.
      // Treat an invalid provider-seam value as unknown even if a future/mock
      // provider bypasses the HTTP adapter's header validation. Unknown keeps
      // the original reservation charged; it must never create a refund.
      const billedChars = result.characterCost != null
        && isValidVoiceCharacterCost(result.characterCost)
        ? result.characterCost
        : null;
      // Fence the settle AND the reconcile in ONE transaction: if the fence is
      // lost (a sweep already moved the row off 'dispatched'), the UPDATE
      // touches 0 rows and the budget mutation is skipped; a fault rolls BOTH
      // back together (the row stays 'dispatched' for the lease sweep), so the
      // terminal state and the budget can never diverge.
      await app.db.transaction(async (tx) => {
        const settled = await settleVoiceNoteTerminal(tx, {
          id: row.id,
          attemptToken: input.attemptToken,
          state: "completed",
          billed: true,
          billedChars,
          providerRequestId: result.requestId,
          providerTraceId: result.traceId,
          providerRegion: result.region,
          audioBytes: result.audio,
          audioSha256,
          audioBytesLen: result.audio.byteLength,
          durationMs: Date.now() - startedAt,
        });
        // Reconcile the estimate to the vendor-reported actuals — but only when
        // the fence was won AND a character cost was reported. Absent a cost
        // header we keep the estimate charged (billed, amount unknown).
        if (settled && billedChars != null) {
          await settleVoiceCharBudget(tx, {
            pageId: row.platformAccountId,
            charsDelta: billedChars - input.reservedChars,
            now: input.now,
          });
        }
      });
      return;
    }

    const outcome = result.refusedBeforeBilling
      ? "failed_definite"
      : result.status === 0
        ? "indeterminate"
        : "failed_after_dispatch";
    app.logger.warn(
      {
        component: "voice_notes",
        event: "voice_note_synthesis_failed",
        vendor: "elevenlabs",
        voiceNoteId: row.id,
        egressKey: egress.egressKey,
        providerStatus: result.status,
        failureKind: result.failureKind,
        observedError: sanitizeVoiceFailureDetail(app, result.detail, input.canonicalScript),
        durationMs: Date.now() - startedAt,
        outcome,
      },
      "voice note provider request failed",
    );

    if (result.refusedBeforeBilling) {
      // Pre-synthesis rejection (4xx): the vendor never began billing → not
      // billed, full refund. Settle + refund atomically (same fence rationale).
      await app.db.transaction(async (tx) => {
        const settled = await settleVoiceNoteTerminal(tx, {
          id: row.id,
          attemptToken: input.attemptToken,
          state: "failed_definite",
          billed: false,
          billedChars: null,
          providerRequestId: null,
          providerTraceId: null,
          providerRegion: null,
          audioBytes: null,
          audioSha256: null,
          audioBytesLen: null,
          durationMs: Date.now() - startedAt,
        });
        if (settled) {
          await settleVoiceCharBudget(tx, {
            pageId: row.platformAccountId,
            charsDelta: -input.reservedChars,
            now: input.now,
          });
        }
      });
      return;
    }

    if (result.status !== 0) {
      // A definite, non-refused HTTP failure (5xx): synthesis may have been
      // billed → failed_after_dispatch, billing unknown, and KEEP the estimate
      // charged (no refund → single settle, no budget mutation to pair).
      await settleVoiceNoteTerminal(app.db, {
        id: row.id,
        attemptToken: input.attemptToken,
        state: "failed_after_dispatch",
        billed: null,
        billedChars: null,
        providerRequestId: null,
        providerTraceId: null,
        providerRegion: null,
        audioBytes: null,
        audioSha256: null,
        audioBytesLen: null,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    // status 0 = network error / timeout: truly indeterminate. Leave the row
    // 'dispatched' for the lease sweep to reclaim as 'indeterminate' — never
    // settle a verdict we cannot justify, and keep the estimate charged.
  } catch (error) {
    // The provider is contractually non-throwing, but a settle/DB fault must not
    // surface as an unhandled rejection on the detached task. The terminal
    // settle and its budget delta now share ONE transaction, so a fault rolls
    // BOTH back atomically: the row stays 'dispatched' with its reservation
    // intact and the lease sweep reclaims it as 'indeterminate'. There is no
    // longer a window where the state settled but the budget delta was lost.
    // NEVER log the raw error object here: a settle fault is a DrizzleQueryError
    // whose `params` (and message text) embed the bound SQL params — including
    // the up-to-2 MB audio BYTEA. Log only sanitized type/code/message.
    const observed = sanitizeError(error, VOICE_LOG_ERROR_OPTIONS);
    app.logger.error({
      component: "voice_notes",
      event: "voice_note_synthesis_failed",
      vendor: "elevenlabs",
      voiceNoteId: row.id,
      egressKey: egress?.egressKey ?? "service:unresolved",
      providerStatus: 0,
      failureKind: "unexpected",
      observedError: sanitizeVoiceFailureDetail(app, observed.message, input.canonicalScript),
      durationMs: Date.now() - startedAt,
      outcome: "indeterminate",
    }, "voice note dispatch failed unexpectedly");
  } finally {
    // Close the per-dispatch service dispatcher on every path. Close errors
    // must not escape this detached task after its terminal/billing decision.
    await egress?.close().catch(() => undefined);
  }
}

function sanitizeVoiceFailureDetail(
  app: Pick<AppContext, "config">,
  detail: string,
  script: string,
): string {
  let sanitized = redactSensitiveText(detail);
  const knownSecrets = [
    app.config.elevenLabsApiKey,
    app.config.serviceEgressProxyUsername,
    app.config.serviceEgressProxyPassword,
    script,
  ];
  for (const secret of knownSecrets) {
    if (secret) {
      sanitized = sanitized.replaceAll(secret, "[REDACTED]");
    }
  }
  return sanitized.slice(0, 512);
}

export function isPageAllowlisted(csv: string | undefined, pageLabel: string): boolean {
  // Empty (or unset) = NONE — the allowlist fails CLOSED.
  if (!csv) {
    return false;
  }
  return csv
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .includes(pageLabel);
}

function describeScriptRejection(rejection: VoiceScriptRejection): string {
  switch (rejection.reason) {
    case "empty":
      return "Voice script is empty after canonicalization";
    case "too_long":
      return `Voice script is ${rejection.chars} characters; the limit is ${rejection.max}`;
    case "markup":
      return "Voice script must not contain < or > markup";
    case "bad_tag":
      return `Voice script contains an unsupported audio tag: ${rejection.tag}`;
  }
}

function terminalErrorCode(state: VoiceNoteState): string | undefined {
  switch (state) {
    case "quota_denied":
      return "voice_quota_denied";
    case "failed_definite":
      return "voice_failed_definite";
    case "failed_after_dispatch":
      return "voice_failed_after_dispatch";
    case "indeterminate":
      return "voice_indeterminate";
    case "artifact_expired":
      return "artifact_expired";
    default:
      return undefined;
  }
}

// The fields toStatusView + the replay verdict actually read — a structural
// subset satisfied by BOTH the full VoiceNoteRow and the projected
// VoiceNoteStatusRow, so a caller can hand in either.
type VoiceNoteViewFields = Pick<
  VoiceNoteRow,
  "id" | "state" | "scriptChars" | "billed" | "audioSha256" | "audioBytesLen" | "createdAt"
>;

function toStatusView(row: VoiceNoteViewFields): VoiceNoteStatusView {
  const errorCode = terminalErrorCode(row.state);
  return {
    voiceNoteId: row.id,
    state: row.state,
    scriptChars: row.scriptChars,
    // A stale indeterminate reservation eventually uses billed=false as an
    // INTERNAL one-time refund marker. The external verdict remains unknown:
    // no client may interpret that bookkeeping stamp as proof the vendor did
    // not charge.
    billed: row.state === "indeterminate" ? null : row.billed,
    audioSha256: row.audioSha256,
    audioBytesLen: row.audioBytesLen,
    createdAt: row.createdAt.toISOString(),
    ...(errorCode ? { errorCode } : {}),
  };
}
