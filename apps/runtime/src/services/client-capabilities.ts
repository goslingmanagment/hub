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
  // chat (H-4c). Taking the field is not using it: a page needs its
  // `freshText` flag.
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
  // R20 HF-4б: the voice notes in the narrow token. The voice-note routes
  // (create, status, audio, and the free allowance read: the page's limits and
  // what is left of today's characters) behind the page's `voice` flag; the
  // render's body takes `fanRef`, the fan apart from the Fansly group (R20
  // HF-4а); and the bootstrap's `voice` reads `lane_off` on a page the
  // voice-notes lane does not serve. With it the hub serves all of `voice`;
  // the owner's switches and the lane decide from here on.
  "voice-notes-v1",
  // Who sent each outgoing message: POST
  // /api/v1/client/pages/:pageLabel/send-attributions (clientSendAttributions),
  // the person's own sends from the page's composer as the extension observed
  // them (0286). No owner switch: the extension reports while the hub lists it.
  "send-attribution-v1",
  // Who wrote each fan note: POST
  // /api/v1/client/pages/:pageLabel/note-attributions (clientNoteAttributions),
  // the extension's confirmed note writes (0324): Fansly notes, and on
  // OnlyFans OnlyMonster's fan notes (0327). No owner switch, like send
  // attribution: the write already happened on the site.
  "note-attribution-v1",
  // Who created each note of a fan and who edited it last: GET
  // /api/v1/client/pages/:pageLabel/fans/:fanRef/note-attributions
  // (clientFanNoteAttributions), read back from the same rows. No owner switch.
  "note-attribution-read-v1",
  // chat-extension X54: the AI feature stream takes `livePpvContext`, the PPV
  // state of the open OnlyFans chat read from the platform. Taking the field is
  // not using it: the fresh text's flag (the page's `freshText`) decides.
  "live-ppv-v1",
  // chat-extension X52: the AI feature stream takes `liveTextContext` on
  // `chat-review` and `coach-chat` too, not only on the four features that
  // draft a message to the fan (AI_LIVE_TEXT_FEATURES). Recap still refuses it.
  "live-text-review-coach-v1",
  // chat-extension X52: Recap (`fan-summary`, full and short) takes
  // `liveTextContext` too, and a recap built with it stays shared and a
  // dossier's proof (AI_LIVE_TEXT_SHARED_FEATURES; owner ruling 2026-10-17).
  "live-text-recap-v1",
  // The voice script and questionnaire fill take the open chat's latest text too.
  "live-text-fansly-tools-v1",
  // The Fansly lane of `livePpvContext`: the purchase state of each paid
  // attachment of the open Fansly chat, read from Fansly by the client at the
  // click (one item per media or bundle). It is applied where the hub marks
  // the attachment (context/fansly-ppv.ts), under the same `freshText` flag.
  "live-ppv-fansly-v1",
  // The AI feature stream takes `recap: "off"`, the chatter's «с Recap»
  // unticked for the chat: the generation reads neither the fan dossier nor
  // Coach's attached recaps, and its meta frame says none were attached.
  "recap-off-v1",
  // chat-extension «Рассылка»: Fix (`improve-draft`) takes `draftPurpose:
  // "outreach"` — the draft is the model's mass message about new content, and
  // the rewrite adapts it into a personal message for one fan (by name and
  // context where it fits, less like a broadcast); the content is attached by
  // the client, so the message points to no post, link or price.
  "outreach-fix-v1",
  // Chat Memory week 1: POST /api/v1/client/activity, the extension's beat once
  // a minute while a tab of a granted page is open (the actual shift).
  "chatter-activity-v1",
  // Chat Memory week 1: GET /api/v1/client/pages/:pageLabel/in-conversation,
  // who wrote to which fan of the page in the last 15 minutes.
  "in-conversation-v1",
  // Chat Memory week 2: GET …/fans/:fanRef/card and POST …/fans/:fanRef/links.
  "fan-card-v1",
  // Chat Memory week 3: GET …/win-back and POST …/win-back/attempts.
  "win-back-v1",
  // Chat Memory week 3: GET …/handoff.
  "handoff-v1",
  // Chat Memory week 4: POST …/fans/:fanRef/customs and …/customs/:customId.
  "fan-customs-v1",
  // «Онлайн»: GET …/online, POST …/online/presence (Fansly and OnlyFans), …/online/probe (OnlyFans, the owner's
  // `onlineProbe`) and …/online/attempts.
  "online-v1",
  // Fan queues: GET …/fan-queues, POST …/fan-queues/:queueId/take and /release,
  // POST …/fan-queues/items/:itemId/done. No owner switch: a page without a queue
  // shows none.
  "fan-queues-v1",
  // Hi on Fansly takes `fanAccount`: the fan's username, display name and bio
  // as the page already loaded his account, for a caller that advertises
  // `hi-fan-account-v1` in `x-kernel-ai-capabilities` and sends no
  // `clientContext`. They fill only what the hub's own record of the fan lacks
  // (a new follower the sync has not brought in yet; fansly-fan-identity.ts).
  "hi-fan-account-v1",
  // Coach as deep as the chatter chooses: a `coach-chat` request that
  // advertises `coach-depth-v1` (with `context-v1`) in `x-kernel-ai-capabilities`
  // reads up to the owner's `aiTranscriptDeepMaxRows` (the bootstrap's
  // `limits.deepMax`), is told how deep its transcript reaches and how much the
  // archive holds, and may end its answer with one ```more block when older
  // history would change its advice. The archive feed answers `depthMarks` with
  // `depth`: the conversation's stored count and the time each count reaches.
  "coach-depth-v1",
  // Fan marks: GET …/fans/:fanRef/marks — the fan's memberships in «бомж»
  // lists of every Fansly page of the agency and the FANSLY BLOCKLIST posts
  // that name his username.
  "fan-marks-v1",
  // chat-extension Telegram spec §5.7: pages of platform `telegram` and their
  // AI lane. The AI feature route takes Reply, Fix and Coach on a Telegram
  // page with the chat in `clientContext` and the fan in `fanRef`, cut to the
  // owner's live window (ai-platform-features.ts, features/index.ts). The
  // extension offers Telegram only against a hub that serves it.
  "telegram-ai-v1",
  // Reply, Fix, Hi and Ping on an OnlyFans page take `fanCustomName`: the
  // chatter's own name for the fan as ChatSpace shows it, for a caller that
  // advertises `fan-custom-name-v1` in `x-kernel-ai-capabilities` and sends no
  // `clientContext` (context/fan-names.ts). The hub holds no saved name for
  // OnlyFans itself.
  "fan-custom-name-v1",
  // The caller's personal daily AI limit (the owner's, per Moscow day over all
  // pages): GET /api/v1/client/ai/limit, `quota.personal` in the AI meta frame,
  // and 429 `quota_denied` with reason `personal_daily_limit` + `retryAfterMs`.
  "ai-limit-v1",
  // The OnlyFans feed from ChatSpace: POST
  // /api/v1/client/pages/:pageLabel/onlyfans-feed (clientOnlyfansFeed), what the
  // page's ChatSpace already received, behind the page's `ofFeed`.
  "onlyfans-feed-v1",
  // The page's poll of ChatSpace for the feed: POST
  // /api/v1/client/pages/:pageLabel/onlyfans-feed/poll (clientOnlyfansPoll),
  // lent to one tab of the team, behind the page's `ofPoll`; the feed takes
  // `subscriber` records.
  "onlyfans-poll-v1",
  // The always-on ChatSpace tab (apps/chatspace-browser): POST
  // /api/v1/client/chatspace/tab-state (clientChatspaceTabState), its report
  // once a minute; kept for the server's hub user alone and watched by the
  // API's ops watchdog (services/chatspace-tab-watch.ts).
  "chatspace-tab-state-v1",
  // The tab's report takes `socket` (the socket's own state: no traffic needed
  // to know it is up) and each account's `subscribed` (ChatSpace's own set).
  "chatspace-tab-state-v2",
  // «Рассылки» kept by Hub, shared by the page's team (services/client-outreaches.ts):
  // GET …/outreaches, GET and POST …/outreaches/:outreachId, POST
  // …/outreaches/:outreachId/sends (each fan's send claimed once) and GET
  // …/outreach-touches. No owner switch, like fan queues: an extension without
  // it keeps its outreaches in the browser.
  "outreach-store-v1",
];

/**
 * Served only while the owner's health intake is on (H-11b,
 * `chatExtensionHealthIngestEnabled`): the client sends `client_health` reports
 * only to a hub that lists it, and keeps them to itself otherwise. Not in
 * SERVED_CLIENT_CAPABILITIES because no feature waits for it and it follows a
 * live switch, not a shipped route.
 */
export const CLIENT_HEALTH_CAPABILITY: ClientHubCapabilityName = "client-health-perf-v1";

/**
 * Served only while the owner's `aiLiveImagesEnabled` is on: the AI feature
 * stream takes `liveImages`, the fan's newest photos of the open chat as bytes
 * (context/live-images.ts). Switched off, the client sends none: it uploads
 * photos only to a hub that lists it.
 */
export const LIVE_IMAGES_CAPABILITY: ClientHubCapabilityName = "live-images-v1";

/**
 * Served only while the owner's `aiDraftMediaEnabled` is on: the AI feature
 * stream takes `draftMedia`, the media attached to the message being written
 * (context/draft-media.ts). Switched off, the client sends none.
 */
export const DRAFT_MEDIA_CAPABILITY: ClientHubCapabilityName = "draft-media-v1";

/** The bootstrap's `capabilities` under the owner's switches as they are right now. */
export function clientBootstrapCapabilities(
  switches: { healthIngestEnabled: boolean; liveImagesEnabled?: boolean; draftMediaEnabled?: boolean },
): ClientHubCapabilityName[] {
  return [
    ...SERVED_CLIENT_CAPABILITIES,
    ...(switches.healthIngestEnabled ? [CLIENT_HEALTH_CAPABILITY] : []),
    ...(switches.liveImagesEnabled === true ? [LIVE_IMAGES_CAPABILITY] : []),
    ...(switches.draftMediaEnabled === true ? [DRAFT_MEDIA_CAPABILITY] : []),
  ];
}
