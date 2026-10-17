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
  // the hub serves all of `previewSend`.
  "preview-send-custody-v1",
  // H-7c: GET /api/v1/client/pages/:pageLabel/audience-new, the "new
  // subscribers" list. With it the hub serves all of `newcomers` on OnlyFans;
  // the owner's switches decide from here on. Fansly's `newcomers` does not
  // need it (R20 HF-2): the extension finds its new subscribers itself.
  "audience-new-v1",
  // R20 HF-3: the claim route takes a manual greeting group (no AI generation)
  // and admits the greeting custody by platform (client-claim-admission.ts).
  // With it and the custody the hub serves all of `newcomers` on Fansly (R20
  // HF-2); the page's own row decides from here on.
  "manual-greeting-v1",
  // R20 HF-8в: the AI feature stream takes `coverageCheck` and answers each of
  // its ids in the `context_v1` frame, for a caller that advertises
  // `coverage-check-v1` in `x-kernel-ai-capabilities`. Ids only: nothing reaches
  // the prompt, nothing is stored.
  "coverage-check-v1",
  // R20 HF-10: the reads by conversation. The shared recaps read, the dossier
  // save from a generation and the archive feed take `conversationRef` (on
  // Fansly the group, checked against the fan; client-conversation.ts). On
  // OnlyFans the field equal to the fan changes nothing; on Fansly `recap` and
  // `preview` need it (R20 HF-2): without it they read `hub_not_ready` there.
  "conversation-recaps-v1",
  // R20 HF-5: the AI feature stream admits Hi on Fansly by the body's
  // `startProof` (the start of the conversation and its personal messages, as
  // the client's page saw them) and takes the fan's avatar at the top level,
  // for a caller that advertises `hi-start-proof-v1` in
  // `x-kernel-ai-capabilities` and sends no `clientContext`.
  "hi-start-proof-v1",
  // R20 HF-4б: the voice notes in the narrow token. The three voice-note routes
  // (create, status, audio) behind the page's `voice` flag; the render's body
  // takes `fanRef`, the fan apart from the Fansly group (R20 HF-4а); and the
  // bootstrap's `voice` reads `lane_off` on a page the voice-notes lane does
  // not serve. With it the hub serves all of `voice`; the owner's switches and
  // the lane decide from here on.
  "voice-notes-v1",
  // Who sent each outgoing message: POST
  // /api/v1/client/pages/:pageLabel/send-attributions (clientSendAttributions),
  // the person's own sends from the page's composer as the extension observed
  // them (0286). No owner switch: the extension reports while the hub lists it.
  "send-attribution-v1",
  // chat-extension X54: the AI feature stream takes `livePpvContext`, the PPV
  // state of the open OnlyFans chat read from the platform. Taking the field is
  // not using it: the fresh text's switch (`aiLiveTextContextMode`, the page's
  // `freshText` flag) decides.
  "live-ppv-v1",
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
