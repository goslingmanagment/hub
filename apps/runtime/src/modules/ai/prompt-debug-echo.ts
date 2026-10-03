import { AI_STREAM_CAPABILITIES, type AiStreamCapability } from "@agency_hub_core/contracts";

const MAX_CAPABILITIES_HEADER_LENGTH = 256;

function isAiStreamCapability(token: string): token is AiStreamCapability {
  return (AI_STREAM_CAPABILITIES as readonly string[]).includes(token);
}

// The capability header is client-controlled compatibility NEGOTIATION, not
// authorization: each token says "this client understands and wants the
// matching frame or field" so an old client never receives an unknown frame.
// The header is deliberately NOT declared in the route schema: a malformed or
// oversized value is ignored here (empty set), never a 400 from Fastify.
// Parsing: a single string of at most 256 chars, split on commas, trimmed,
// case-sensitive, known tokens only; an array value yields nothing. A header
// repeated on the wire is NOT an array: Node joins its lines into one
// ", "-separated string, which parses as the union within the same cap.
export function parseAiStreamCapabilities(
  header: string | string[] | undefined,
): ReadonlySet<AiStreamCapability> {
  const capabilities = new Set<AiStreamCapability>();
  if (typeof header !== "string" || header.length > MAX_CAPABILITIES_HEADER_LENGTH) {
    return capabilities;
  }
  for (const raw of header.split(",")) {
    const token = raw.trim();
    if (isAiStreamCapability(token)) {
      capabilities.add(token);
    }
  }
  return capabilities;
}

// For the debug_input_v1 frame the authorization — whether echo is allowed at
// all — is the server-side kill-switch `chatMuseAiPromptDebugEchoEnabled`
// (below), and the data boundary is the unchanged page-authorization the
// feature lane already enforces (#140).
export function hasDebugInputCapability(
  header: string | string[] | undefined,
): boolean {
  return parseAiStreamCapabilities(header).has("debug-input-v1");
}

// The whole gate. The owner decided the assembled prompt is not withheld from
// the agency's own chatters, so echo is a plain fleet-wide boolean rather than a
// timed per-user allowlist (Decision #140 addendum): a live-config kill-switch,
// audited on flip through the owner PATCH, default off so a deploy is inert.
// A missing/non-boolean effective value reads as false — fail closed.
export function isPromptDebugEchoEnabled(
  enabled: boolean | undefined,
): boolean {
  return enabled === true;
}
