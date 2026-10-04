import type { ClientHubCapabilityName } from "@agency_hub_core/contracts";

/**
 * What this hub serves to the chat extension: the bootstrap's `capabilities`.
 *
 * A token joins the list in the PR that ships the route or frame behind it.
 * Until it does, every feature that needs it reads `hub_not_ready`
 * (`CLIENT_FEATURE_REQUIREMENTS` in client-features.ts), whatever the owner's
 * switches say.
 */
export const SERVED_CLIENT_CAPABILITIES: readonly ClientHubCapabilityName[] = [
  // The AI feature stream's `context_v1` frame (H-4b).
  "context-v1",
  // The shared recaps read (H-13). The `recap` feature also needs
  // `recap-profile-v1` (H-5), so it stays `hub_not_ready` until that lands.
  "shared-recaps-v1",
];
