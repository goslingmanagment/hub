import { AppError, TooManyRequestsError } from "../../services/errors.ts";

/**
 * The Agent Read Plane's own error vocabulary.
 *
 * Two rules this file exists to keep:
 *
 * 1. **Only an `AppError` crosses the boundary.** The global error handler turns
 *    anything else into a static 500 with a fixed body that never passes through
 *    the route serializer. A duck-typed `{error, message, statusCode}` literal is
 *    NOT an AppError; that exact mistake answered 500 to three days of rate-limited
 *    logins.
 * 2. **A refusal must not become an existence oracle.** `staticNotFound()` is the
 *    ONE 404 the plane ever produces, byte-identical whether the resource is
 *    missing or merely outside the key's grant. The declarative page-scope
 *    middleware produces the same body for agents before any handler runs, and a
 *    test compares the two bytes.
 */

/** The key is valid, the capability was never granted. */
export class AgentCapabilityMissingError extends AppError {
  constructor(capability: string) {
    super(`agent key lacks the ${capability} capability`, 403, "agent_capability_missing");
  }
}

/** The daily request or row budget for this key is spent. */
export class AgentBudgetExhaustedError extends AppError {
  constructor(message = "agent key daily budget exhausted") {
    super(message, 429, "agent_budget_exhausted");
  }
}

/** `agentReadPlaneMode=off`, or the operation's own sub-flag is off. */
export class AgentPlaneDisabledError extends AppError {
  constructor(message = "agent read plane is disabled") {
    super(message, 503, "agent_plane_disabled");
  }
}

/** The `message_archive` rebuild swapped the table under a reader (#134). */
export class ArchiveRebuildingError extends AppError {
  constructor(message = "message archive is being rebuilt; retry shortly") {
    super(message, 503, "archive_rebuilding");
  }
}

/**
 * A cursor that is malformed, forged, foreign, or describes a different snapshot.
 *
 * The message is CONSTANT across every cause. `requestHash` and `pageIds`
 * mismatches are oracles of somebody else's scope, and an empty 200 instead of
 * this 400 would silently reshape the snapshot when a grant changes mid-traversal.
 */
export class AgentCursorInvalidError extends AppError {
  constructor() {
    super("cursor is not valid for this request", 400, "agent_cursor_invalid");
  }
}

/**
 * THE 404 of the plane. Missing and out-of-grant are the same bytes; the real
 * reason goes only to the internal audit trail.
 *
 * The message matches what `NotFoundError` produces for the page-scope
 * middleware verdict, so the middleware's pre-handler refusal and a handler's own
 * refusal are indistinguishable.
 */
export function staticNotFound(): AppError {
  return new AppError("Not found", 404, "not_found");
}

/**
 * The plane's own `errorResponseBuilder` for `@fastify/rate-limit`.
 *
 * The plugin THROWS whatever the builder returns. The shared builder is
 * hard-coded to "Too many login attempts", which on an agent route would be both
 * wrong and confusing; and a non-AppError return becomes a static 500 (#187).
 */
export function agentRateLimitErrorBuilder(): AppError {
  return new TooManyRequestsError("agent read plane rate limit exceeded");
}

/**
 * BIGINT -> number at the JSON edge.
 *
 * The pool sets `setTypeParser(20, BigInt)`, so every bigint column arrives as a
 * JavaScript BigInt and `JSON.stringify` THROWS on one. Converting is therefore
 * mandatory, and converting silently is not acceptable on money: above 2^53 a
 * number stops counting, and mills that stop counting are wrong amounts served as
 * facts. Overflow raises a 500 rather than shipping a quiet lie.
 */
export function toSafeNumber(value: bigint | number | string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed)) {
    throw new AppError(
      "a stored integer exceeds the range this API can serve without losing precision",
      500,
      "internal_error",
    );
  }
  return parsed;
}

/** `toSafeNumber` with a floor for non-nullable columns. */
export function toSafeNumberOr(
  value: bigint | number | string | null | undefined,
  fallback: number,
): number {
  return toSafeNumber(value) ?? fallback;
}
