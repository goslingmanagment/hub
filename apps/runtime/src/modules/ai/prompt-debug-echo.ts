import { z } from "zod";

const DEBUG_INPUT_CAPABILITY = "debug-input-v1";
const MAX_CAPABILITIES_HEADER_LENGTH = 256;
const MAX_DEBUG_ECHO_WINDOW_MS = 24 * 60 * 60 * 1000;
const ISO_TIMESTAMP_WITH_OFFSET = z.string().datetime({ offset: true });

function normalizedUsername(value: string) {
  return value.trim().toLowerCase();
}

export function hasDebugInputCapability(
  header: string | string[] | undefined,
): boolean {
  if (typeof header !== "string" || header.length > MAX_CAPABILITIES_HEADER_LENGTH) {
    return false;
  }
  return header
    .split(",")
    .map((token) => token.trim())
    .some((token) => token === DEBUG_INPUT_CAPABILITY);
}

// The single echo key carries the allowlist AND the deadline in one value
// ("user1,user2@<ISO>"), so enabling or disabling is always one atomic write:
// a still-live deadline left over from a previous window can never re-open
// echo when only a user list is edited. The deadline is split on the LAST "@"
// so usernames containing "@" cannot shift the boundary.
function parsePromptDebugEcho(
  valueRaw: string | null | undefined,
  now: Date,
): { users: string[] } | null {
  if (!valueRaw) {
    return null;
  }
  const trimmed = valueRaw.trim();
  if (trimmed.toLowerCase() === "none") {
    return null;
  }
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) {
    return null;
  }
  const deadline = trimmed.slice(at + 1).trim();
  if (!ISO_TIMESTAMP_WITH_OFFSET.safeParse(deadline).success) {
    return null;
  }
  const deadlineMs = Date.parse(deadline);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= now.getTime()) {
    return null;
  }
  const users = trimmed
    .slice(0, at)
    .split(",")
    .map(normalizedUsername)
    .filter((candidate) => candidate.length > 0 && candidate !== "none" && candidate !== "all");
  if (users.length === 0) {
    return null;
  }
  return { users };
}

export function isPromptDebugEchoAllowed(
  valueRaw: string | null | undefined,
  username: string,
  now: Date = new Date(),
): boolean {
  const parsed = parsePromptDebugEcho(valueRaw, now);
  if (!parsed) {
    return false;
  }
  const wanted = normalizedUsername(username);
  if (wanted.length === 0) {
    return false;
  }
  return parsed.users.includes(wanted);
}

export function validatePromptDebugEcho(
  value: string,
  now: Date = new Date(),
): string | null {
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === "none") {
    return null;
  }
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) {
    return 'chatMuseAiPromptDebugEcho must be "none" or "user1,user2@<ISO deadline>"';
  }
  const deadline = trimmed.slice(at + 1).trim();
  if (!ISO_TIMESTAMP_WITH_OFFSET.safeParse(deadline).success) {
    return "chatMuseAiPromptDebugEcho deadline must be an ISO timestamp with timezone";
  }
  const deadlineMs = Date.parse(deadline);
  if (!Number.isFinite(deadlineMs)) {
    return "chatMuseAiPromptDebugEcho deadline must be an ISO timestamp";
  }
  if (deadlineMs <= now.getTime()) {
    return 'chatMuseAiPromptDebugEcho deadline is already in the past; use "none" to disable';
  }
  if (deadlineMs > now.getTime() + MAX_DEBUG_ECHO_WINDOW_MS) {
    return "chatMuseAiPromptDebugEcho deadline may be at most 24 hours in the future";
  }
  const tokens = trimmed.slice(0, at).split(",").map(normalizedUsername);
  if (tokens.some((token) => token.length === 0 || token === "none" || token === "all")) {
    return "chatMuseAiPromptDebugEcho users must be a CSV of usernames; all is forbidden";
  }
  return null;
}
