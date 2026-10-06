import { ofapiCollectionRefusalDisposition, type Platform } from "@agency_hub_core/shared";

export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class BadRequestError extends AppError {
  /** Documented structured extension (docs/error-handling.md §3): a machine
   * reason beside the human message, serialized only when non-null. Decision
   * 349 uses it for the password rule on link redemption (too_short | too_long
   * | common), so the /join page can say WHICH rule was broken without matching
   * on prose; the chat extension's own-AI-spend read uses it for why its query
   * was refused (CLIENT_AI_USAGE_REFUSAL_REASONS), its Spenders statistics
   * for a time zone the hub does not know (CLIENT_SPENDER_STATS_REFUSAL_REASONS),
   * and a client read that takes a cursor for a cursor this hub did not issue
   * for the request (CLIENT_CURSOR_REFUSAL_REASONS: `cursor_invalid`).
   * Every other bad request stays reason-less. */
  readonly reason: string | null;

  constructor(message: string, options?: { reason?: string | null }) {
    super(message, 400, "bad_request");
    this.reason = options?.reason ?? null;
  }
}

/** Decision 349 (§4.5): why a PRESENTED device token that matched a row was
 * refused. An unknown digest carries no reason (no enumeration oracle);
 * `user_disabled` is unreachable because deactivation revokes every token. */
export type AuthFailureReason = "token_revoked" | "token_expired";

export class UnauthorizedError extends AppError {
  /** Documented structured extension (docs/error-handling.md §3): serialized as
   * `reason` in the body only when non-null. */
  readonly reason: AuthFailureReason | null;

  constructor(message = "Unauthorized", options?: { reason?: AuthFailureReason | null }) {
    super(message, 401, "unauthorized");
    this.reason = options?.reason ?? null;
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(message, 403, "forbidden");
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(message, 404, "not_found");
  }
}

// Coach feature (spec §7 compat): an unknown AI feature key carries its own
// structured code so clients distinguish "this hub is too old to serve the
// feature" from a generic missing-resource 404 (the extension's «Coach
// requires a newer Agency Hub» mapping keys on this code, never on 404 alone).
export class UnknownAiFeatureError extends AppError {
  constructor(message = "Unknown AI feature") {
    super(message, 404, "unknown_ai_feature");
  }
}

export class ConflictError extends AppError {
  /** Documented structured extension (docs/error-handling.md §3): the machine
   * reason for the conflict, serialized only when non-null. Account-link
   * redemption uses used | expired | revoked (Decision 349). */
  readonly reason: string | null;

  constructor(message: string, options?: { reason?: string | null }) {
    super(message, 409, "conflict");
    this.reason = options?.reason ?? null;
  }
}

/** The selected persona changed after the client read the metadata catalog. */
export class PersonaDefinitionChangedError extends AppError {
  constructor() {
    super(
      "AI persona definition changed; refresh the persona catalog and retry",
      409,
      "persona_definition_changed",
    );
  }
}

export class SnapshotRestartRequiredError extends AppError {
  readonly snapshotPath = "/api/v1/events/snapshot" as const;

  constructor(readonly replayFloor: number) {
    super(
      `Snapshot cursor is below replay continuity floor ${replayFloor}; restart without snapshotCursor/stateCursor`,
      409,
      "sync_snapshot_restart_required",
    );
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = "Too many requests") {
    super(message, 429, "rate_limit_exceeded");
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = "Service unavailable") {
    super(message, 503, "service_unavailable");
  }
}

// W3.1 (decision #124): Fansly egress fails closed — resolving a Fansly page
// without a stored proxy refuses the whole resolution instead of egressing
// from the shared VPS IP. 409 because the page's stored state conflicts with
// the fail-closed egress policy; assigning a proxy clears it.
export class ProxyMissingError extends AppError {
  constructor(message: string) {
    super(message, 409, "proxy_missing");
  }
}

export const LEGACY_SYNC_RETIRED_CODE = "legacy_sync_retired";

/** Something of the legacy sync engine was asked for a page it no longer
 *  serves. Since step 4 every Fansly page is read by the Fansly Sync Engine
 *  (`sync/onlyfans/boundary.ts`): a legacy sync lever (request, trigger,
 *  pause, resume, reset) of a Fansly page the engine does not own, and an
 *  `/account/me` lever (page verify, a credentials or proxy change) of a
 *  Fansly page the engine does not run, have nothing to act on. 409
 *  `legacy_sync_retired`; nothing is written, queued, sent or stored. */
export class LegacySyncRetiredError extends AppError {
  readonly pageLabel: string;
  readonly platform: Platform;

  constructor(input: { pageLabel: string; platform: Platform }) {
    super(
      `Page ${input.pageLabel}: the legacy sync executor serves no ${input.platform} page since step 4; `
        + `the Fansly Sync Engine reads it (see \`pnpm cli sync page status --page ${input.pageLabel}\`)`,
      409,
      LEGACY_SYNC_RETIRED_CODE,
    );
    this.name = "LegacySyncRetiredError";
    this.pageLabel = input.pageLabel;
    this.platform = input.platform;
  }
}

// Stage 29: quota/budget breaches carry their own code (the ledger's
// gateway_outcome value) so clients can distinguish them from generic 429s.
export class QuotaDeniedError extends AppError {
  constructor(message = "AI gateway quota exceeded") {
    super(message, 429, "quota_denied");
  }
}

// Stage 30 product gates (min messages, hi-greeting lock, active-ping block,
// draft required): each denial carries its own code so clients map the CG-*
// wording structurally; the message strings stay stable for clients that
// still match on them (#120 follow-up).
export class ProductGateError extends AppError {
  constructor(message: string, code: `gate_${string}`) {
    super(message, 400, code);
  }
}

// Review #136: a collection-policy refusal (packages/db OfapiCollectionPolicyError)
// is a local decision, never a vendor or transport failure, so it must reach a
// client as a typed, non-retryable answer instead of 500 `internal_error`.
// One code, the machine `reason` alongside it; the status says how it clears:
// 429 when only time clears it (daily budget, interval window — the shape of
// `quota_denied`/`rate_limit_exceeded` in the registry, with `retryAfterMs`
// advice), 409 when only an owner's policy change clears it (paused, off,
// on-demand only, details disabled — the shape of `proxy_missing`).
export class OfapiCollectionRefusedError extends AppError {
  readonly retryAfterMs: number | null;

  constructor(readonly reason: string, options?: { retryAt?: Date | null; now?: Date }) {
    const cap = ofapiCollectionRefusalDisposition(reason) === "cap";
    super(
      cap
        ? "OFAPI collection budget for this category is exhausted; retry after it resets"
        : "OFAPI collection policy refuses this read; change the collection policy to allow it",
      cap ? 429 : 409,
      "ofapi_collection_refused",
    );
    const retryAt = options?.retryAt ?? null;
    this.retryAfterMs = retryAt === null
      ? null
      : Math.max(0, retryAt.getTime() - (options?.now ?? new Date()).getTime());
  }
}

// Chat extension (hub-pr-plan H-2b): a client route, or an AI call of the
// extension's narrow token, asked for a feature that is not available to it.
// 409 because only the owner (or an extension update, for `client_outdated`)
// lifts it: never retried automatically. Documented structured extension
// (docs/error-handling.md §3): the machine `reason` beside the code, one of the
// open vocabulary CLIENT_FEATURE_UNAVAILABLE_REASONS (`disabled`, `flag_off`,
// `platform_unsupported`, `binding_missing`, `hub_not_ready`, `not_granted`,
// `client_outdated`).
export class ClientFeatureDisabledError extends AppError {
  constructor(readonly flag: string, readonly reason: string) {
    super(`Chat-extension feature "${flag}" is unavailable (${reason})`, 409, "client_feature_disabled");
  }
}

// chat-extension H-4c: the fresh text a client sent with an AI request
// (`liveTextContext`) contradicts what the hub holds: a message the hub knows
// as sent by the other side, or a message id of another chat. The snapshot is
// not of the conversation the request names, so nothing is generated. 400: the
// request itself is wrong and the same request never succeeds; the client
// re-reads the open chat and asks again. The message names message IDS ONLY.
// It is logged and shown, and must never carry a fan's text.
const CONTEXT_CONFLICT_IDS_SHOWN = 10;

export class ContextConflictError extends AppError {
  constructor(readonly messageIds: readonly string[]) {
    const shown = messageIds.slice(0, CONTEXT_CONFLICT_IDS_SHOWN).join(", ");
    const more = messageIds.length > CONTEXT_CONFLICT_IDS_SHOWN
      ? ` and ${messageIds.length - CONTEXT_CONFLICT_IDS_SHOWN} more`
      : "";
    super(
      `liveTextContext conflicts with the hub's transcript of this conversation (message ids: ${shown}${more})`,
      400,
      "context_conflict",
    );
  }
}

// chat-extension H-5: the dossier save named a generation of the caller whose
// record has not appeared. The gateway writes the record right after the
// stream's `done` frame, so a request made in that gap is repeated shortly.
// 409: nothing is wrong with the request, the hub's state is not there yet.
// It can stay for good when the record's write failed, so a client bounds its
// repeats.
export class GenerationNotReadyError extends AppError {
  constructor() {
    super("The generation is not recorded yet; ask again shortly", 409, "generation_not_ready");
  }
}

// chat-extension H-5: the caller's generation exists and will never become the
// fan's dossier. 409, never retried. Documented structured extension
// (docs/error-handling.md §3): the machine `reason` beside the code, one of the
// open vocabulary CLIENT_GENERATION_NOT_ELIGIBLE_REASONS.
export class GenerationNotEligibleError extends AppError {
  constructor(readonly reason: string) {
    super(`The generation cannot be saved as the fan's dossier (${reason})`, 409, "generation_not_eligible");
  }
}

// chat-extension H-7b: the greeting lease or the send custody of a fan refuses
// the action (`POST /api/v1/client/pages/:pageLabel/fans/:fanRef/claim`, and
// `attempt_conflict` on the manual resolve). Each refusal has its own code and
// no `reason` (docs/error-handling.md §3). 409: the state of the fan refuses
// it, and none of them is retried automatically.
export const CLIENT_CLAIM_REFUSAL_MESSAGES = {
  claim_busy: "Another person or client install holds the lease on this fan",
  claim_expired: "The lease is not live: it expired, was released, or was never taken",
  custody_held: "A send to this fan is not resolved yet",
  custody_not_owned: "This send attempt was not dispatched by this person and client install",
  greeting_done: "The fan is already greeted",
  generation_mismatch: "The greeting was confirmed for another generation, variant or part count",
  part_already_sent: "This part is already sent",
  attempt_conflict: "The attempt or message id is already recorded with other facts",
} as const;

export type ClientClaimRefusalCode = keyof typeof CLIENT_CLAIM_REFUSAL_MESSAGES;

export class ClientClaimRefusedError extends AppError {
  constructor(code: ClientClaimRefusalCode) {
    super(CLIENT_CLAIM_REFUSAL_MESSAGES[code], 409, code);
  }
}

// chat-extension H-7b: more sends from the preview than the per-person rate
// allows (CLIENT_PREVIEW_SEND_RATE_LIMIT per window). 429: only time clears it.
// Documented structured extension (docs/error-handling.md §3): `retryAfterMs`,
// when the window frees a slot; the route also sends it as `Retry-After`.
export class ClientPreviewSendRateLimitedError extends AppError {
  constructor(readonly retryAfterMs: number) {
    super("Too many sends from the preview; try again shortly", 429, "preview_send_rate_limited");
  }
}
