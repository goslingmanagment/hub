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
  // The AI feature stream takes `liveTextContext`, the fresh text of the open
  // chat (H-4c). Taking the field is not using it: `aiLiveTextContextMode`
  // rests off, and a page needs its `freshText` flag.
  "live-text-v1",
  // The shared recaps read (H-13).
  "shared-recaps-v1",
  // The dossier save from a stored generation (H-5). With it the hub serves
  // all of the `recap` feature; the owner's switches decide from here on.
  "recap-profile-v1",
  // H-10a: Split for Ping and Hi (the splitAll flag). Coach drafts follow in H-10b.
  "split-all-v1",
];
