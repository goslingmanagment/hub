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

export function isPromptDebugEchoAllowed(
  usersRaw: string | null | undefined,
  untilRaw: string | null | undefined,
  username: string,
  now: Date = new Date(),
): boolean {
  if (!usersRaw || !untilRaw || usersRaw.trim().toLowerCase() === "none" || untilRaw.trim().toLowerCase() === "none") {
    return false;
  }

  const trimmedUntil = untilRaw.trim();
  if (!ISO_TIMESTAMP_WITH_OFFSET.safeParse(trimmedUntil).success) {
    return false;
  }
  const untilMs = Date.parse(trimmedUntil);
  if (!Number.isFinite(untilMs) || untilMs <= now.getTime()) {
    return false;
  }

  const wanted = normalizedUsername(username);
  if (wanted.length === 0) {
    return false;
  }
  return usersRaw
    .split(",")
    .map(normalizedUsername)
    .filter((candidate) => candidate.length > 0 && candidate !== "none" && candidate !== "all")
    .includes(wanted);
}

export function validatePromptDebugEchoUsers(value: string): string | null {
  const tokens = value.split(",").map(normalizedUsername);
  if (tokens.length === 1 && tokens[0] === "none") {
    return null;
  }
  if (tokens.some((token) => token.length === 0 || token === "none" || token === "all")) {
    return "chatMuseAiPromptDebugEchoUsers must be a CSV of usernames or none; all is forbidden";
  }
  return null;
}

export function validatePromptDebugEchoUntil(
  value: string,
  now: Date = new Date(),
): string | null {
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === "none") {
    return null;
  }
  if (!ISO_TIMESTAMP_WITH_OFFSET.safeParse(trimmed).success) {
    return "chatMuseAiPromptDebugEchoUntil must be an ISO timestamp with timezone or none";
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    return "chatMuseAiPromptDebugEchoUntil must be an ISO timestamp or none";
  }
  if (parsed > now.getTime() + MAX_DEBUG_ECHO_WINDOW_MS) {
    return "chatMuseAiPromptDebugEchoUntil may be at most 24 hours in the future";
  }
  return null;
}
