import { sanitizeError } from "@agency_hub_core/shared";

const MAX_VALIDATION_MESSAGE_CHARS = 512;
const MAX_VALIDATION_ISSUES = 20;
const MAX_REQUEST_FRAGMENT_DEPTH = 8;
const MAX_REQUEST_FRAGMENTS = 200;

interface ValidationIssue {
  keyword?: unknown;
  instancePath?: unknown;
  message?: unknown;
}

interface RequestValidationError {
  validationContext?: unknown;
  validation: ValidationIssue[];
}

function collectRequestStringFragments(
  value: unknown,
  output: Set<string>,
  seen: WeakSet<object>,
  depth: number,
) {
  if (output.size >= MAX_REQUEST_FRAGMENTS || depth > MAX_REQUEST_FRAGMENT_DEPTH) {
    return;
  }
  if (typeof value === "string") {
    if (value.length > 0) {
      output.add(value);
    }
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);
  const entries = Array.isArray(value) ? value : Object.values(value);
  for (const entry of entries) {
    collectRequestStringFragments(entry, output, seen, depth + 1);
    if (output.size >= MAX_REQUEST_FRAGMENTS) {
      return;
    }
  }
}

function removeRequestStringFragments(message: string, requestValues: readonly unknown[]) {
  const fragments = new Set<string>();
  const seen = new WeakSet<object>();
  for (const value of requestValues) {
    collectRequestStringFragments(value, fragments, seen, 0);
  }

  let sanitized = message;
  for (const fragment of [...fragments].sort((left, right) => right.length - left.length)) {
    sanitized = sanitized.split(fragment).join("[REQUEST_VALUE]");
  }
  return sanitized;
}

function safeIssueMessage(issue: ValidationIssue) {
  // Zod v4's ordinary issue messages describe expected type/constraints, not
  // the received value. These two issue kinds are exceptions because their
  // rendered path/message can contain caller-owned object keys.
  if (issue.keyword === "unrecognized_keys") {
    return "Unrecognized field";
  }
  if (issue.keyword === "invalid_key") {
    return "Invalid record key";
  }
  return typeof issue.message === "string" && issue.message.length > 0
    ? issue.message
    : "Invalid value";
}

/**
 * Rebuild the useful Fastify/Zod summary from structured issues, then remove
 * any exact request-string values before redaction and the total-length clamp.
 * The raw Fastify aggregate is deliberately never returned.
 */
export function formatRequestValidationMessage(
  error: RequestValidationError,
  requestValues: readonly unknown[],
) {
  const context = typeof error.validationContext === "string"
    ? error.validationContext
    : "request";
  const issues = error.validation.slice(0, MAX_VALIDATION_ISSUES);
  const rawMessage = issues.map((issue) => {
    const unsafeKeyIssue = issue.keyword === "unrecognized_keys"
      || issue.keyword === "invalid_key";
    const path = !unsafeKeyIssue && typeof issue.instancePath === "string"
      ? issue.instancePath
      : "";
    return `${context}${path} ${safeIssueMessage(issue)}`;
  }).join(", ");
  const withoutRequestValues = removeRequestStringFragments(rawMessage, requestValues);
  return sanitizeError(withoutRequestValues, {
    maxChars: MAX_VALIDATION_MESSAGE_CHARS,
    truncation: "ellipsis",
    fallbackMessage: "Request validation failed",
  }).message;
}
