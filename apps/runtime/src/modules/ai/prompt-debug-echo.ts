const DEBUG_INPUT_CAPABILITY = "debug-input-v1";
const MAX_CAPABILITIES_HEADER_LENGTH = 256;

// The capability header is client-controlled compatibility NEGOTIATION, not
// authorization: it says "this client understands and wants the debug_input_v1
// frame" so an old client never receives an unknown frame. The authorization —
// whether echo is allowed at all — is the server-side kill-switch
// `chatMuseAiPromptDebugEchoEnabled` (below), and the data boundary is the
// unchanged page-authorization the feature lane already enforces (#140).
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
