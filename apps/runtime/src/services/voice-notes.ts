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
  getVoiceNoteByClientRequestId,
  getVoiceNoteById,
  getVoiceProfile,
  insertQuotaDeniedVoiceNote,
  insertVoiceNoteJob,
  reserveVoiceCharBudget,
  settleVoiceCharBudget,
  settleVoiceNoteTerminal,
  type VoiceNoteRow,
  type VoiceNoteState,
} from "@agency_hub_core/db";
import { findPageByLabel } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { canAccessPage, type AuthPrincipal } from "./auth.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import { AppError, NotFoundError } from "./errors.ts";
import { VOICE_AUDIO_MAX_BYTES } from "./voice-elevenlabs-provider.ts";
import {
  canonicalizeVoiceScript,
  computeVoiceRequestHash,
  sha256Hex,
  validateVoiceScript,
  type VoiceScriptRejection,
} from "./voice-script-validation.ts";

// The subset of the app context the service reads. `voiceTtsProvider` is
// present whenever ELEVENLABS_API_KEY was configured at boot; the presence
// check below is deliberately separate from the live `voiceNotesEnabled` flag
// (the flag is the spend gate; the provider's presence is the key-configured
// gate).
type VoiceNotesApp = Pick<AppContext, "db" | "config" | "logger" | "voiceTtsProvider">;

/** Single-dispatch lease: matches the sweep's reclaim window. */
const DISPATCH_LEASE_MS = 120_000;

// Fallbacks that mirror the config-registry defaults. In production the boot
// AppConfig always carries these (zod defaults), so they only guard test
// contexts that construct config by hand.
const DEFAULT_SCRIPT_MAX_CHARS = 600;
const DEFAULT_PAGE_BUDGET = 5000;
const DEFAULT_GLOBAL_BUDGET = 20000;

// Internal rollback sentinel: thrown inside the reserve+insert transaction when
// the queued insert loses the unique (user, clientRequestId) race, so drizzle
// rolls the whole tx back — the budget reservation included — rather than
// leaving it stranded. Caught in createVoiceNote to replay the winner. Mirrors
// the BudgetRefused idiom the repo's reserveVoiceCharBudget already uses.
class VoiceAdmissionLostRace extends Error {}

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

/** Operator trap: the live flag is on but no ELEVENLABS_API_KEY was configured,
 * so the provider was never built. Distinct from voice_disabled (403). */
export class VoiceProviderUnavailableError extends AppError {
  constructor() {
    super(
      "Voice notes are enabled but ELEVENLABS_API_KEY is not configured, so the TTS "
        + "provider was not constructed; set the key and restart the runtime before "
        + "syntheses can run",
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
  app: VoiceNotesApp,
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
  const existing = await getVoiceNoteByClientRequestId(app.db, principal.user.id, body.clientRequestId);
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
  // Distinct from the flag: the provider is built at boot iff ELEVENLABS_API_KEY
  // is configured. Enabled-but-no-provider means the key is unset — an
  // actionable 503 ("configure the key and restart"), not a generic "disabled".
  if (!app.voiceTtsProvider) {
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
  // same principal on the same page (the restricted-capture row is the ledger).
  const source = await getAiGenerationContentByRef(app.db, body.sourceGenerationRef);
  if (
    !source
    || source.generation.feature !== "voice-script"
    || source.generation.userId !== principal.user.id
    || source.generation.pageId !== page.id
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

  const now = new Date();
  const pageBudget = effective.voiceNotesDailyCharBudget ?? DEFAULT_PAGE_BUDGET;
  const globalBudget = effective.voiceNotesGlobalDailyCharBudget ?? DEFAULT_GLOBAL_BUDGET;

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
  };

  // (3+4) Reserve the character budget AND record the idempotency row in ONE
  // transaction. Wrapping both closes two windows the two-commit version left
  // open: (a) a crash between the reserve and the insert can no longer strand a
  // reservation with no row to carry it (a rollback releases it), and (b) the
  // reserve holds its budget-row lock THROUGH the insert, so a same-budget
  // competitor cannot slip a quota_denied row in between and falsely deny a
  // request that actually had budget. A refused reservation rolls back only its
  // own savepoint (nothing consumed) and records the durable quota_denied fact
  // in the same tx; losing the unique race throws a sentinel to roll the whole
  // reservation back (the rollback IS the release), caught below to replay the
  // concurrent winner.
  let admission:
    | { kind: "inserted" }
    | { kind: "quota_denied"; wonDenied: boolean };
  try {
    admission = await app.db.transaction(async (tx) => {
      const reserved = await reserveVoiceCharBudget(tx, {
        pageId: page.id,
        chars: scriptChars,
        pageBudget,
        globalBudget,
        now,
      });
      if (!reserved) {
        const wonDenied = await insertQuotaDeniedVoiceNote(tx, snapshot);
        return { kind: "quota_denied", wonDenied } as const;
      }
      const insertResult = await insertVoiceNoteJob(tx, snapshot);
      if (!insertResult.inserted) {
        // A concurrent duplicate already claimed this (user, clientRequestId).
        // Abort the tx so the reservation rolls back, then replay its row below.
        throw new VoiceAdmissionLostRace();
      }
      return { kind: "inserted" } as const;
    });
  } catch (error) {
    if (error instanceof VoiceAdmissionLostRace) {
      return await replayConcurrentWinner(app, principal, body.clientRequestId, requestHash);
    }
    throw error;
  }

  if (admission.kind === "quota_denied") {
    if (admission.wonDenied) {
      throw new VoiceQuotaDeniedError();
    }
    // A concurrent request already claimed this clientRequestId — replay it.
    return await replayConcurrentWinner(app, principal, body.clientRequestId, requestHash);
  }

  const row = await getVoiceNoteByClientRequestId(app.db, principal.user.id, body.clientRequestId);
  if (!row) {
    // The row we just inserted must exist; a null here is a hard invariant break.
    throw new Error("voice note row missing immediately after a winning insert");
  }

  // (5) Single-dispatch CAS: exactly one attempt token wins queued→dispatched
  // plus the lease.
  const attemptToken = randomUUID();
  const won = await casVoiceNoteDispatch(app.db, {
    id: row.id,
    attemptToken,
    leaseUntil: new Date(now.getTime() + DISPATCH_LEASE_MS),
  });

  // (6) Detached dispatch: return the view NOW; the provider call runs
  // fire-and-forget with its own signal, then fences the settle. A rare CAS loss
  // (a sweep raced us) just returns the latest persisted state.
  if (won) {
    void dispatchVoiceNote(app, {
      row,
      attemptToken,
      reservedChars: scriptChars,
      canonicalScript,
      now,
    });
    return toStatusView({ ...row, state: "dispatched" });
  }
  const latest = await getVoiceNoteById(app.db, row.id);
  return toStatusView(latest ?? row);
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
  const row = await getScopedVoiceNote(app, principal, page.id, id);
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
  const row = await getScopedVoiceNote(app, principal, page.id, id);

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

async function getScopedVoiceNote(
  app: VoiceNotesApp,
  principal: AuthPrincipal,
  pageId: number,
  id: number,
): Promise<VoiceNoteRow> {
  const row = await getVoiceNoteById(app.db, id);
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
  const other = await getVoiceNoteByClientRequestId(app.db, principal.user.id, clientRequestId);
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
 * Replay projection with ONE deliberate exception: a `quota_denied` row
 * re-throws its 429 rather than returning a 202 view. A denied reservation is a
 * hard refusal; surfacing it as a pollable 202 would trap a correct idempotent
 * client on a row that never advances. Same clientRequestId ⇒ same 429 on every
 * call — a fresh attempt needs a fresh clientRequestId.
 */
function replayTerminalOrView(row: VoiceNoteRow): VoiceNoteStatusView {
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
async function dispatchVoiceNote(
  app: VoiceNotesApp,
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

  try {
    const result = await provider.synthesize({
      voiceId: row.profileVoiceId,
      model: row.profileModel,
      settings: row.profileSettings,
      outputFormat: row.profileOutputFormat,
      text: input.canonicalScript,
      signal: controller.signal,
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
          { voiceNoteId: row.id, audioBytesLen: result.audio.byteLength, cap: VOICE_AUDIO_MAX_BYTES },
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
      const billedChars = result.characterCost != null
        ? Math.max(0, Math.round(result.characterCost))
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
    app.logger.warn(
      { voiceNoteId: row.id },
      "voice note synthesis indeterminate; leaving dispatched for the lease sweep",
    );
  } catch (error) {
    // The provider is contractually non-throwing, but a settle/DB fault must not
    // surface as an unhandled rejection on the detached task. The terminal
    // settle and its budget delta now share ONE transaction, so a fault rolls
    // BOTH back atomically: the row stays 'dispatched' with its reservation
    // intact and the lease sweep reclaims it as 'indeterminate'. There is no
    // longer a window where the state settled but the budget delta was lost.
    app.logger.error({ voiceNoteId: row.id, error }, "voice note dispatch failed unexpectedly");
  }
}

function isPageAllowlisted(csv: string | undefined, pageLabel: string): boolean {
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

function toStatusView(row: VoiceNoteRow): VoiceNoteStatusView {
  const errorCode = terminalErrorCode(row.state);
  return {
    voiceNoteId: row.id,
    state: row.state,
    scriptChars: row.scriptChars,
    billed: row.billed,
    audioSha256: row.audioSha256,
    audioBytesLen: row.audioBytesLen,
    createdAt: row.createdAt.toISOString(),
    ...(errorCode ? { errorCode } : {}),
  };
}
