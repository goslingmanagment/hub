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

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, "conflict");
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
