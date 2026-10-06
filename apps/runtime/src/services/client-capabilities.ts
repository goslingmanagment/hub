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
  // H-10: Split for Ping, Hi and Coach drafts (the splitAll flag;
  // docs/ai-gateway-contract.md).
  "split-all-v1",
  // H-15: GET /api/v1/client/pages/:pageLabel/ai-usage.
  "ai-usage-v1",
  // H-8b: GET /api/v1/client/pages/:pageLabel/spenders/stats.
  "spenders-stats-v1",
  // H-8c: GET /api/v1/client/pages/:pageLabel/spenders/awaiting-reply. With it
  // the hub serves all of the `stats` feature; the owner's switches decide from
  // here on.
  "awaiting-reply-v1",
  // H-9c: the archive feed of one conversation,
  // GET /api/v1/client/pages/:pageLabel/conversations/:fanRef/feed. With it the
  // hub serves all of the `preview` feature.
  "archive-feed-v1",
  // H-7b: the greeting lease and send custody (the claim POST and GET). With it
  // the hub serves all of `previewSend`. `newcomers` also needs
  // `audience-new-v1` (H-7c), so it stays `hub_not_ready` until that lands.
  "preview-send-custody-v1",
];

/**
 * Served only while the owner's health intake is on (H-11b,
 * `chatExtensionHealthIngestEnabled`): the client sends `client_health` reports
 * only to a hub that lists it, and keeps them to itself otherwise. Not in
 * SERVED_CLIENT_CAPABILITIES because no feature waits for it and it follows a
 * live switch, not a shipped route.
 */
export const CLIENT_HEALTH_CAPABILITY: ClientHubCapabilityName = "client-health-perf-v1";

/** The bootstrap's `capabilities` under the owner's switches as they are right now. */
export function clientBootstrapCapabilities(switches: { healthIngestEnabled: boolean }): ClientHubCapabilityName[] {
  return switches.healthIngestEnabled
    ? [...SERVED_CLIENT_CAPABILITIES, CLIENT_HEALTH_CAPABILITY]
    : [...SERVED_CLIENT_CAPABILITIES];
}
