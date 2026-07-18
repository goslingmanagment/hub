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

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, 401, "unauthorized");
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
  constructor(message: string) {
    super(message, 409, "conflict");
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
