import { ofapiCollectionRefusalDisposition } from "@agency_hub_core/shared";

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
  constructor(message: string) {
    super(message, 400, "bad_request");
  }
}

/** Decision 347 (§4.5): why a PRESENTED device token that matched a row was
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

// Decision 347 (§4.2): a user flagged must_change_password (frozen #116b flag)
// may not sign a device in by password until an owner resets it. Its own code
// so clients map it to a specific line instead of a generic 403.
export class PasswordChangeRequiredError extends AppError {
  constructor(message = "The owner must reset this account's password before it can sign in") {
    super(message, 403, "password_change_required");
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
   * redemption uses used | expired | revoked (Decision 347). */
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
