import { createHash } from "node:crypto";

/**
 * Opaque identity of the exact definition used to assemble a prompt. Clients
 * compare it only; the domain prefix permits a future canonicalization change.
 */
export function aiPersonaDefinitionId(input: {
  key: string;
  displayName: string;
  systemBlock: string;
}): string {
  const digest = createHash("sha256")
    .update("agency-hub:ai-persona-definition:v1\0", "utf8")
    .update(input.key, "utf8")
    .update("\0", "utf8")
    .update(input.displayName, "utf8")
    .update("\0", "utf8")
    .update(input.systemBlock, "utf8")
    .digest("base64url");
  return `v1:${digest}`;
}
