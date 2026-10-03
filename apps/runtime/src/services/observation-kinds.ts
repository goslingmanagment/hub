// WP-F0(c)(i) — the observation-kind coverage ratchet.
//
// THE MISTAKE THIS PREVENTS (BL-C3, and it really happened): a capture lane
// journals `observations.kind = "link_stats_tracking"`, no canonicalizer family
// ever claims that kind, the health-floor registry cannot see it because it is
// built from the families, and the parse debt sits there forever with nothing
// reporting it. Nothing was LOST — DP 7 keeps the body verbatim for 100 years
// and a family added later replays all of it — but three safety nets were.
//
// THE GUARANTEE, STATED HONESTLY: **a CI-enforced registry**, and nothing more.
// Not "structurally impossible". The typed write seam ([S2]) was DEFERRED by
// the owner (A28-7), so `RawPayloadInsertRow.endpoint` is still `string` and
// `tsc` cannot reject an unregistered literal. What catches it is this file
// plus `tests/observation-kind-coverage.test.ts`, at the PR that introduces it.
//
// THE CAVEAT THAT KEEPS IT HONEST: BL-C3 survived intact because link-stats had
// a direct projection-write path. Every family the endpoints-cover initiative
// adds is `projectionOnly: true` and canonicalizer-fed with no such fallback —
// so the same mistake on a new kind shows up as an EMPTY projection, not a
// redundant one, until the kind is claimed and replayed. The recovery is still
// complete; the gap is simply visible as missing data.
//
// HOW TO ADD A KIND: register it below with its writer. Then either a
// canonicalizer family claims it, or it goes in RAW_ONLY_OBSERVATION_KINDS with
// a one-line reason. Both halves are deliberate edits; neither is optional.

import { CANONICALIZER_FAMILIES } from "./canonicalize/index.ts";
import { FANSLY_REPLAY_FAMILY } from "./canonicalize/fansly-replay.ts";
import { OFAPI_READTHROUGH_OBSERVATION_KIND } from "./health-floors.ts";

/** One kind a writer in this tree can put in `observations.kind`. `source` is
 *  load-bearing: a family with `kinds: null` claims EVERY kind of its source
 *  (the command_result family does exactly that). */
export interface WrittenObservationKind {
  kind: string;
  source: string;
  /** Where it is written — the file a reviewer opens when this list changes. */
  writer: string;
}

export const WRITTEN_OBSERVATION_KINDS: readonly WrittenObservationKind[] = [
  { kind: "fansly.ws.frame.v1", source: "fansly_ws", writer: "services/fansly-ws/worker.ts" },
  { kind: "ofapi.collection_read_materialized.v1", source: "ofapi_capture", writer: "services/ofapi-collection-read-transport.ts" },
  { kind: "ofapi.collection_read_response.v1", source: "ofapi_capture", writer: "services/ofapi-collection-read-transport.ts" },
  { kind: "ofapi_gateway_chat_search", source: "readthrough", writer: "services/ofapi-read-gateway.ts" },
  // Release 1 control-plane witnesses; these do not start business collectors.
  { kind: "ofapi.marketing_response.v1", source: "operator", writer: "services/ofapi-smart-links.ts" },
  { kind: "ofapi.action_response.v1", source: "operator", writer: "services/ofapi-actions.ts" },
  { kind: "ofapi.binding.replaced", source: "operator", writer: "services/ofapi-binding-refresh.ts" },
  { kind: "ofapi.account.response", source: "pull", writer: "services/ofapi-credential-policy.ts" },
  { kind: "ofapi_admin_accounts", source: "operator", writer: "services/ofapi-credential-policy.ts" },
  { kind: "ofapi_credential_preflight", source: "operator", writer: "services/ofapi-credential-policy.ts" },
  { kind: "ofapi_webhook_event_catalog", source: "operator", writer: "services/ofapi-credential-policy.ts" },
  { kind: "ofapi_webhook_inventory", source: "operator", writer: "services/ofapi-credential-policy.ts" },
  { kind: "ofapi_webhook_crud", source: "operator", writer: "services/ofapi-credential-policy.ts" },
  { kind: "ofapi_balance_ping", source: "operator", writer: "services/ofapi-credential-policy.ts" },
  // ── the sync plane: `RawPayloadInsertRow.endpoint` → observations.kind ────
  // (services/sync/shared.ts persistRawPayload). This is the seam BL-C3 went
  // through, and the seam ~27–30 of this initiative's new Fansly kinds will
  // arrive on.
  { kind: "account_lookup", source: "pull", writer: "sync/fansly/capture.ts" },
  { kind: "account_me", source: "pull", writer: "services/sync/executor-handlers.ts" },
  { kind: "dm_conversations", source: "pull", writer: "sync/fansly/capture.ts" },
  { kind: "dm_messages", source: "pull", writer: "services/sync/fansly-dm-messages.ts" },
  { kind: "earnings_accounts", source: "pull", writer: "services/sync/executor-handlers.ts" },
  { kind: "earnings_transactions", source: "pull", writer: "services/sync/transactions.ts" },
  { kind: "fan_earnings_stats", source: "pull", writer: "services/sync/fan-earnings-capture.ts" },
  { kind: "fan_earnings_monthly", source: "pull", writer: "services/sync/fan-earnings-capture.ts" },
  { kind: "fans_active", source: "pull", writer: "services/sync/executor-handlers.ts" },
  { kind: "followers", source: "pull", writer: "services/sync/executor-handlers.ts" },
  { kind: "group_detail", source: "pull", writer: "sync/fansly/capture.ts" },
  { kind: "post_tips", source: "pull", writer: "services/sync/executor-handlers.ts" },
  { kind: "posts", source: "pull", writer: "services/sync/executor-handlers.ts" },
  { kind: "purchase_history", source: "pull", writer: "services/sync/executor-handlers.ts" },
  // Decision 358: a witness page the purchase-history contract proof re-asked
  // for. Same body as `purchase_history` (real order rows), journaled apart so
  // it never forks a completed target chain; canonicalized by the same family.
  { kind: "purchase_history_contract_probe", source: "pull", writer: "services/sync/executor-handlers.ts" },
  { kind: "purchase_history_contract_storm", source: "pull", writer: "services/sync/executor-handlers.ts" },
  { kind: "subscribers", source: "pull", writer: "services/sync/executor-handlers.ts" },
  // ── WP-F1: the `stats_snapshot` lane (services/sync/fansly-stats.ts) ──────
  // Every one is claimed by the `fansly-stats` family. `media_offer_stats` was
  // registered here by F1 with the PARSER but no writer, so the kind would be
  // claimed the day a capture could write it rather than accruing parse debt
  // nothing reports (the BL-C3 shape); WP-F4 is that writer, and it stays in
  // the SAME family — one family, one sweep, one health-floor gauge.
  { kind: "account_stats", source: "pull", writer: "services/sync/fansly-stats.ts" },
  { kind: "media_offer_stats", source: "pull", writer: "services/sync/fansly-media-stats.ts" },
  { kind: "earnings_stats_snapshot", source: "pull", writer: "services/sync/fansly-stats.ts" },
  {
    kind: "earnings_monthlystats_snapshot",
    source: "pull",
    writer: "services/sync/fansly-stats.ts",
  },
  { kind: "tracking_links", source: "pull", writer: "services/sync/fansly-stats.ts" },
  { kind: "discovery_feed", source: "pull", writer: "services/sync/fansly-stats.ts" },
  { kind: "broadcast_stats", source: "pull", writer: "services/sync/fansly-stats.ts" },
  { kind: "broadcast_stats_deleted", source: "pull", writer: "services/sync/fansly-stats.ts" },
  { kind: "broadcast_scheduled", source: "pull", writer: "services/sync/fansly-stats.ts" },
  { kind: "polls", source: "pull", writer: "services/sync/fansly-stats.ts" },
  { kind: "recapstats", source: "pull", writer: "services/sync/fansly-stats.ts" },
  // ── WP-F2: the `notifications` lane (services/sync/fansly-notifications.ts) ──
  // ONE kind for the whole lane: the head poll, the deep backfill and the
  // type-filter probe all journal the same envelope shape, and the request
  // params say which walk produced it. A kind per phase would split one fact
  // across three parse paths for nothing.
  { kind: "notifications", source: "pull", writer: "services/sync/fansly-notifications.ts" },
  // ── WP-F3: the `catalog` lane (services/sync/fansly-catalog.ts) ────────────
  // ONE kind PER ROUTE here, and the contrast with WP-F2 above is deliberate:
  // the notification lane journals one envelope shape from three walks, while
  // these nine routes serve nine different shapes. A shared kind would force
  // one parser to sniff which route produced a body it can no longer identify.
  { kind: "vault_albums", source: "pull", writer: "services/sync/fansly-catalog.ts" },
  { kind: "uservault_albums", source: "pull", writer: "services/sync/fansly-catalog.ts" },
  { kind: "subscription_tiers", source: "pull", writer: "services/sync/fansly-catalog.ts" },
  { kind: "gift_codes", source: "pull", writer: "services/sync/fansly-catalog.ts" },
  { kind: "automated_messages", source: "pull", writer: "services/sync/fansly-catalog.ts" },
  { kind: "account_walls", source: "pull", writer: "services/sync/fansly-catalog.ts" },
  { kind: "vault_media", source: "pull", writer: "services/sync/fansly-catalog.ts" },
  { kind: "vault_album_walk_completed", source: "pull", writer: "services/sync/fansly-catalog.ts" },
  { kind: "account_media_batch", source: "pull", writer: "services/sync/fansly-catalog.ts" },
  {
    kind: "account_media_bundle_batch",
    source: "pull",
    writer: "services/sync/fansly-catalog.ts",
  },
  // ── WP-F5: the `post_replies` lane (services/sync/fansly-post-replies.ts) ──
  // ONE kind for one route. Its observation payload is an ENVELOPE
  // (`{walk, response}`) because the post id lives in the request PATH: an
  // empty reply page is a body with no way to say which post it is about, and
  // that is precisely the body `missing_since` is computed from. The response,
  // [A20]-trimmed (only `accounts[]` allowlisted), lands in
  // `sync_raw_payloads.response_payload` without the envelope.
  { kind: "post_replies", source: "pull", writer: "services/sync/fansly-post-replies.ts" },
  // ── WP-F7: the `payouts` lane (services/sync/fansly-payouts.ts) ───────────
  // ONE kind per route, two routes. Both are RESTRICTED-CLASS bodies:
  // `payout_methods` carries the creator's payout credentials (provider 2
  // returns a plaintext email) and `payout_requests` carries the money-out
  // history. Neither is on `AGENT_OBSERVATION_PAYLOAD_ALLOWLIST` — which is an
  // ALLOWLIST and fails closed, so absence is the enforcement — and
  // `tests/fansly-payouts-restricted.test.ts` pins that they stay off it.
  { kind: "payout_methods", source: "pull", writer: "services/sync/fansly-payouts.ts" },
  { kind: "payout_requests", source: "pull", writer: "services/sync/fansly-payouts.ts" },
  // BL-C3 itself. Both halves of the pair, so the incident's own kinds are the
  // first thing this registry pins.
  { kind: "link_stats_tracking", source: "pull", writer: "services/ofapi-link-stats-sync.ts" },
  { kind: "link_stats_trial", source: "pull", writer: "services/ofapi-link-stats-sync.ts" },

  // ── the OFAPI webhook plane (vendor-named events) ────────────────────────
  { kind: "posts.liked", source: "webhook", writer: "services/ofapi-webhook-capture.ts" },
  { kind: "messages.received", source: "webhook", writer: "services/ofapi-webhook-capture.ts" },
  { kind: "messages.sent", source: "webhook", writer: "services/ofapi-webhook-capture.ts" },
  { kind: "messages.deleted", source: "webhook", writer: "services/ofapi-webhook-capture.ts" },
  { kind: "messages.ppv.unlocked", source: "webhook", writer: "services/ofapi-webhook-capture.ts" },
  { kind: "tips.received", source: "webhook", writer: "services/ofapi-webhook-capture.ts" },
  { kind: "transactions.new", source: "webhook", writer: "services/ofapi-webhook-capture.ts" },
  { kind: "subscriptions.new", source: "webhook", writer: "services/ofapi-webhook-capture.ts" },
  { kind: "subscriptions.renewed", source: "webhook", writer: "services/ofapi-webhook-capture.ts" },
  { kind: "users.typing", source: "webhook", writer: "services/ofapi-webhook-capture.ts" },
  { kind: "users.online", source: "webhook", writer: "services/ofapi-webhook-capture.ts" },
  { kind: "users.offline", source: "webhook", writer: "services/ofapi-webhook-capture.ts" },
  { kind: "accounts.connected", source: "webhook", writer: "services/ofapi-webhook-capture.ts" },
  { kind: "accounts.reconnected", source: "webhook", writer: "services/ofapi-webhook-capture.ts" },
  {
    kind: "accounts.session_expired",
    source: "webhook",
    writer: "services/ofapi-webhook-capture.ts",
  },
  {
    kind: "accounts.authentication_failed",
    source: "webhook",
    writer: "services/ofapi-webhook-capture.ts",
  },
  {
    kind: "accounts.otp_code_required",
    source: "webhook",
    writer: "services/ofapi-webhook-capture.ts",
  },
  {
    kind: "accounts.face_otp_required",
    source: "webhook",
    writer: "services/ofapi-webhook-capture.ts",
  },
  { kind: "chat_queue.updated", source: "webhook", writer: "services/ofapi-webhook-capture.ts" },
  { kind: "chat_queue.finished", source: "webhook", writer: "services/ofapi-webhook-capture.ts" },
  // The webhook lane's own rejection witnesses — journaled BEFORE any parse, so
  // a malformed or mis-identified delivery is still a fact we hold.
  {
    kind: "ofapi.webhook.invalid_identity",
    source: "webhook",
    writer: "services/ofapi-webhook-capture.ts",
  },
  { kind: "ofapi.webhook.malformed", source: "webhook", writer: "services/ofapi-webhook-capture.ts" },
  {
    kind: "ofapi.webhook.fact_conflict",
    source: "webhook",
    writer: "services/ofapi-webhook-capture.ts",
  },
  {
    kind: "ofapi_webhook_lineage_backfill",
    source: "webhook",
    writer: "services/dm-corrections-lineage-intake.ts",
  },

  // ── the OFAPI capture plane (governed jobs; the UNTYPED seam) ────────────
  {
    kind: "ofapi.chat_messages_page.v1",
    source: "ofapi_capture",
    writer: "services/ofapi-capture-jobs.ts",
  },
  { kind: "ofapi.data_export_control.v1", source: "ofapi_capture", writer: "services/ofapi-export-quotes.ts" },
  { kind: "ofapi_export_inventory", source: "operator", writer: "services/ofapi-credential-policy.ts" },
  // Written as `kind: value.operation` by onAdminResponse (ofapi-credential-policy.ts):
  // the literal never appears at the writer, so the census cannot grep them.
  { kind: "ofapi_command_send_v2", source: "operator", writer: "services/ofapi-credential-policy.ts" },
  { kind: "ofapi_banned_words", source: "operator", writer: "services/ofapi-credential-policy.ts" },
  { kind: "ofapi_vendor_usage", source: "operator", writer: "services/ofapi-credential-policy.ts" },
  { kind: "ofapi.media_source.v1", source: "operator", writer: "services/ofapi-media-sources.ts" },
  { kind: "ofapi.media_upload_response.v1", source: "ofapi_capture", writer: "services/ofapi-media-uploads.ts" },
  { kind: "ofapi.typed_export_artifact.v1", source: "ofapi_capture", writer: "services/ofapi-typed-exports.ts" },
  { kind: "ofapi.posts_page.v1", source: "ofapi_capture", writer: "services/ofapi-capture-jobs.ts" },
  {
    kind: "ofapi.capture_completed.v1",
    source: "ofapi_capture",
    writer: "services/ofapi-capture-jobs.ts",
  },
  {
    kind: "ofapi.posts_capture_completed.v1",
    source: "ofapi_capture",
    writer: "services/ofapi-capture-jobs.ts",
  },
  {
    kind: "ofapi.export_artifact_pointer.v1",
    source: "ofapi_capture",
    writer: "services/ofapi-export-artifact.ts",
  },
  {
    kind: "ofapi.interactive_response.v1",
    source: "ofapi_capture",
    writer: "services/ofapi-capture-transport.ts",
  },
  {
    kind: "ofapi.data_export_create.v1",
    source: "ofapi_capture",
    writer: "services/ofapi-export-quotes.ts",
  },
  {
    kind: "ofapi.data_export_start.v1",
    source: "ofapi_capture",
    writer: "services/ofapi-export-quotes.ts",
  },
  {
    kind: "ofapi.data_export_status.v1",
    source: "ofapi_capture",
    writer: "services/ofapi-export-quotes.ts",
  },

  // ── the OFAPI read-through gateway (kind = the allowlisted operation) ────
  {
    kind: OFAPI_READTHROUGH_OBSERVATION_KIND,
    source: "readthrough",
    writer: "services/ofapi-read-gateway-capture.ts",
  },
  { kind: "ofapi_gateway_chats", source: "readthrough", writer: "services/ofapi-read-gateway.ts" },
  {
    kind: "ofapi_gateway_chat_message",
    source: "readthrough",
    writer: "services/ofapi-read-gateway.ts",
  },
  {
    kind: "ofapi_gateway_chat_messages",
    source: "readthrough",
    writer: "services/ofapi-read-gateway.ts",
  },
  {
    kind: "ofapi_gateway_chat_media",
    source: "readthrough",
    writer: "services/ofapi-read-gateway.ts",
  },
  {
    kind: "ofapi_gateway_transactions",
    source: "readthrough",
    writer: "services/ofapi-read-gateway.ts",
  },
  {
    kind: "ofapi_gateway_upload_status",
    source: "readthrough",
    writer: "services/ofapi-read-gateway.ts",
  },
  { kind: "ofapi_gateway_user", source: "readthrough", writer: "services/ofapi-read-gateway.ts" },
  {
    kind: "ofapi_gateway_users_list",
    source: "readthrough",
    writer: "services/ofapi-read-gateway.ts",
  },
  {
    kind: "ofapi_gateway_user_lists",
    source: "readthrough",
    writer: "services/ofapi-read-gateway.ts",
  },
  {
    kind: "ofapi_gateway_user_list_users",
    source: "readthrough",
    writer: "services/ofapi-read-gateway.ts",
  },
  {
    kind: "ofapi_gateway_vault_lists",
    source: "readthrough",
    writer: "services/ofapi-read-gateway.ts",
  },
  {
    kind: "ofapi_gateway_vault_media",
    source: "readthrough",
    writer: "services/ofapi-read-gateway.ts",
  },
  {
    kind: "ofapi_gateway_vault_media_item",
    source: "readthrough",
    writer: "services/ofapi-read-gateway.ts",
  },

  // ── the command-result plane ─────────────────────────────────────────────
  // The command_result family declares `kinds: null`, so it claims all three
  // by source. They are listed because "written" is a census, not a wish.
  {
    kind: "command.failed_retryable",
    source: "command_result",
    writer: "services/ofapi-command-executor.ts",
  },
  {
    kind: "command.failed_terminal",
    source: "command_result",
    writer: "services/ofapi-command-executor.ts",
  },
  {
    kind: "command.indeterminate",
    source: "command_result",
    writer: "services/ofapi-command-executor.ts",
  },

  // ── the desktop client-capture plane ─────────────────────────────────────
  { kind: "desktop.ai_acceptance", source: "client_capture", writer: "services/ingest-observations.ts" },
  { kind: "desktop.guard_audit", source: "client_capture", writer: "services/ingest-observations.ts" },
  { kind: "desktop.send_audit", source: "client_capture", writer: "services/ingest-observations.ts" },
  { kind: "desktop.ai_spend", source: "client_capture", writer: "services/ingest-observations.ts" },
  { kind: "desktop.credit_spend", source: "client_capture", writer: "services/ingest-observations.ts" },
  {
    kind: "desktop.data_purge_notice",
    source: "client_capture",
    writer: "services/ingest-observations.ts",
  },
  { kind: "harvest.messages", source: "client_capture", writer: "services/ingest-observations.ts" },
  {
    kind: "harvest.fan_transactions",
    source: "client_capture",
    writer: "services/ingest-observations.ts",
  },
  { kind: "harvest.outbox", source: "client_capture", writer: "services/ingest-observations.ts" },
  {
    kind: "harvest.message_guard_events",
    source: "client_capture",
    writer: "services/ingest-observations.ts",
  },
  {
    kind: "harvest.usage_events",
    source: "client_capture",
    writer: "services/ingest-observations.ts",
  },
  { kind: "harvest.ai_spend_log", source: "client_capture", writer: "services/ingest-observations.ts" },
  { kind: "harvest.credit_log", source: "client_capture", writer: "services/ingest-observations.ts" },

  // ── the operator plane ───────────────────────────────────────────────────
  {
    kind: "dm_archive_material_reconstruction",
    source: "operator",
    writer: "services/dm-corrections-lineage-intake.ts",
  },
  {
    kind: "ofapi.coverage_revoked.v1",
    source: "operator",
    writer: "packages/db/src/repositories/ofapi-message-coverage.ts",
  },
];

/**
 * Kinds minted at RUNTIME, which no static list can enumerate. Each rule names
 * its writer and why the kind cannot be a literal — "dynamic" is a claim that
 * has to be justified, not a way to opt out of the ratchet.
 */
export interface DynamicObservationKindRule {
  id: string;
  writer: string;
  justification: string;
  matches: (kind: string) => boolean;
}

export const DYNAMIC_OBSERVATION_KIND_RULES: readonly DynamicObservationKindRule[] = [
  {
    id: "endpoint:failed",
    writer: "services/sync/shared.ts persistFailedSyncPayload",
    justification:
      "Minted per endpoint at runtime as `${endpoint}:failed` — the error body of a "
      + "capture that did not succeed. Journaled deliberately (DP 7: a failure is a fact) "
      + "and parsed by nothing: an error body is not platform truth.",
    matches: (kind) =>
      kind.endsWith(":failed")
      && WRITTEN_OBSERVATION_KINDS.some((entry) =>
        entry.source === "pull" && kind === `${entry.kind}:failed`
      ),
  },
  {
    id: "desktop.unknown:<kind>",
    writer: "services/ingest-observations.ts ingestKindFor",
    justification:
      "A desktop client kind outside the ingest allowlist is journaled as "
      + "`desktop.unknown:<kind>` rather than dropped — captured, never trusted. The "
      + "vendor half is the client's string and cannot be enumerated here.",
    matches: (kind) => kind.startsWith("desktop.unknown:"),
  },
  {
    id: "operator audit event types",
    writer: "services/auth.ts recordAuditObservation",
    justification:
      "The operator audit dual-write journals `kind = eventType` (auth.login, "
      + "user.page_assigned, api_key.revoked, device_token.*). audit_log is the queryable "
      + "truth; the observation is the immutable witness, claimed by no canonicalizer "
      + "BY DESIGN — an operator action is not platform truth to project.",
    matches: (kind) =>
      /^(auth|user|api_key|device_token|page|model|config|erasure|agent_key)\./.test(kind),
  },
  // NOT a rule, and deliberately so: services/observations-rejournal.ts writes
  // `kind = rawRow.endpoint` (and observations-account-me-rejournal.ts writes
  // `account_me`). Neither mints a NEW value space — every kind they can
  // write is already a registered sync-plane kind above, so the static half of
  // the ratchet already covers it. A rule here would only launder future
  // unregistered sync kinds through the word "dynamic".
];

/**
 * Written kinds that NO canonicalizer family claims, each with the one line
 * that says why that is a decision and not an oversight. An entry here is a
 * promise that the body is captured and replayable — never that it is parsed.
 */
export interface RawOnlyObservationKind {
  kind: string;
  justification: string;
}

export const RAW_ONLY_OBSERVATION_KINDS: readonly RawOnlyObservationKind[] = [
  { kind: "purchase_history_contract_storm", justification: "Decision 358: the purchase-history lane's own verdict that a rejection storm was raised, journaled before the stream is blocked so the next run can tell an owner unblock from an executor retry. A lane fact, not a provider fact; nothing to canonicalize." },
  { kind: "ofapi.collection_read_materialized.v1", justification:"Completion evidence for one bounded GET capture step. Its normalized facts are independently replayed from the retained response and projection-only snapshot event." },
  { kind: "ofapi_gateway_chat_search", justification: "A query-scoped list of message IDs; retained as read evidence, never a message body or full-history coverage assertion." },
  { kind: "ofapi.binding.replaced", justification: "Control-plane audit evidence. Binding, access and credit state use their existing control repositories; this response is not a business fact." },
  { kind: "ofapi.account.response", justification: "Control-plane audit evidence. Binding, access and credit state use their existing control repositories; this response is not a business fact." },
  { kind: "ofapi_admin_accounts", justification: "Journaled as an identity projection at every HTTP status; session material and _meta are removed before insert, non-200 bodies withheld. Control-plane audit evidence. Binding, access and credit state use their existing control repositories; this response is not a business fact." },
  { kind: "ofapi_credential_preflight", justification: "Control-plane audit evidence. Binding, access and credit state use their existing control repositories; this response is not a business fact." },
  { kind: "ofapi_webhook_event_catalog", justification: "Control-plane available-event catalog; owner diagnostics rebuild directly from the captured response without changing subscriptions." },
  { kind: "ofapi_webhook_inventory", justification: "Control-plane audit evidence. Binding, access and credit state use their existing control repositories; this response is not a business fact." },
  { kind: "ofapi_webhook_crud", justification: "Control-plane audit evidence. Binding, access and credit state use their existing control repositories; this response is not a business fact." },
  { kind: "ofapi_balance_ping", justification: "Control-plane audit evidence. Binding, access and credit state use their existing control repositories; this response is not a business fact." },
  {
    kind: "account_lookup",
    justification:
      "Identity resolution for a single ref, used inline by the capture that asked for it; "
      + "no durable fact of its own beyond the identity the replay family already mints.",
  },
  {
    kind: "earnings_accounts",
    justification:
      "Payout-account identifiers. Captured for completeness, never projected — and "
      + "deliberately denied to the agent read plane for the same reason.",
  },
  {
    kind: "fans_active",
    justification:
      "A volatile audience slice recomputed every sweep; the durable audience facts come "
      + "from followers/subscribers, which the replay family does claim.",
  },
  {
    kind: "group_detail",
    justification:
      "Per-conversation permission flags and user settings; the conversation FACT is "
      + "minted from dm_conversations by the replay family, so this would double-count.",
  },
  {
    kind: "link_stats_tracking",
    justification:
      "BL-C3: written by the link-stats lane and claimed by no family. It has a direct "
      + "projection-write path (page_link_stat_snapshots), which is exactly why the "
      + "incident lost no numbers. Listing it here is the incident's tombstone; a "
      + "canonicalizer family for it is a separate, undecided piece of work.",
  },
  {
    kind: "link_stats_trial",
    justification: "The second half of the BL-C3 pair — same lane, same reasoning.",
  },
  {
    kind: "users.typing",
    justification:
      "SUBSCRIBED and journaled (kind = the vendor event) but outside "
      + "OFAPI_WEBHOOK_CANONICALIZED_KINDS: a typing indicator is a transient UI signal "
      + "with a lifetime of seconds, not a durable platform fact — the presence projection "
      + "claims users.online/offline and deliberately stops there.",
  },
  {
    kind: "ofapi.webhook.invalid_identity",
    justification:
      "A delivery whose account identity did not resolve. Journaled as evidence BEFORE "
      + "any parse; there is no page to attribute a canonical event to.",
  },
  {
    kind: "ofapi.webhook.malformed",
    justification:
      "A delivery that failed envelope validation. Same rule: capture first, and a body "
      + "we could not read cannot mint a fact.",
  },
  {
    kind: "ofapi.webhook.fact_conflict",
    justification:
      "Two deliveries that disagree about one fact. Kept as the conflict witness; "
      + "resolution is an operator act, not a canonicalization.",
  },
  {
    kind: "ofapi_webhook_lineage_backfill",
    justification:
      "The corrections reconciler's lineage witness — it links two EXISTING events; it "
      + "is not itself a new platform fact.",
  },
  {
    kind: "ofapi.data_export_create.v1",
    justification:
      "The vendor data-export lifecycle: the request we made. Operational evidence for a "
      + "job, not a platform fact — the exported ARTIFACT is what carries facts.",
  },
  {
    kind: "ofapi.data_export_start.v1",
    justification: "The second step of the same export lifecycle — see data_export_create.",
  },
  {
    kind: "ofapi.data_export_control.v1", justification: "Durable provider cancel/retry acknowledgement; captured lifecycle evidence is read by the export control and status state machine.",
  },
  {
    kind: "ofapi_export_inventory", justification: "Credential-visible owner control inventory, captured before parsing and read locally; it does not authorize export work or certify imported facts.",
  },
  {
    kind: "ofapi_command_send_v2", justification: "Transport receipt of one v2 send attempt, journaled before the executor parses it; the command outbox settles from its own captured result, and the delivered message reaches the archive through the webhook lane, not this row.",
  },
  {
    kind: "ofapi_banned_words", justification: "One page of the vendor's banned-word list, captured as the evidence behind the local policy check; a vocabulary snapshot, not a business fact about a fan or a page.",
  },
  {
    kind: "ofapi_vendor_usage", justification: "Vendor-side credit usage report for the owner's cost view; the ledger and the reservation tables remain the accounting authority, this row is read-only corroboration.",
  },
  {
    kind: "ofapi.data_export_status.v1",
    justification: "The poll step of the same export lifecycle — see data_export_create.",
  },
  {
    kind: "ofapi.capture_completed.v1",
    justification:
      "A terminal disposition witness for a capture job: operational state, and the "
      + "coverage row is where it is read.",
  },
  {
    kind: "ofapi.posts_capture_completed.v1",
    justification: "The posts half of the same terminal witness.",
  },
  {
    kind: "ofapi.export_artifact_pointer.v1",
    justification:
      "A POINTER to an export artifact, not the artifact and not a platform fact.",
  },
  {
    kind: "ofapi.coverage_revoked.v1",
    justification:
      "An owner-initiated revocation of a coverage claim. Operator act; the coverage "
      + "table is the state it moves.",
  },
  {
    kind: "dm_archive_material_reconstruction",
    justification:
      "An operator-run archive reconstruction witness. It records that a repair RAN; the "
      + "material itself arrives through message.material_observed.",
  },
  {
    kind: "ofapi_gateway_chats",
    justification:
      "Read-through gateway pages are served to a client and journaled as evidence. Only "
      + "the chat-messages surface has a projector (the readthrough reconcile, registered "
      + "as an off-sweep claimant); the rest are capture-first evidence with no fact of "
      + "their own that a live lane does not already mint.",
  },
  { kind: "ofapi_gateway_chat_message", justification: "Read-through evidence — see ofapi_gateway_chats." },
  { kind: "ofapi_gateway_chat_messages", justification: "Read-through evidence — see ofapi_gateway_chats." },
  { kind: "ofapi_gateway_chat_media", justification: "Read-through evidence — see ofapi_gateway_chats." },
  { kind: "ofapi_gateway_transactions", justification: "Read-through evidence — see ofapi_gateway_chats." },
  { kind: "ofapi_gateway_upload_status", justification: "Read-through evidence — see ofapi_gateway_chats." },
  { kind: "ofapi_gateway_user", justification: "Read-through evidence — see ofapi_gateway_chats." },
  { kind: "ofapi_gateway_users_list", justification: "Read-through evidence — see ofapi_gateway_chats." },
  { kind: "ofapi_gateway_user_lists", justification: "Read-through evidence — see ofapi_gateway_chats." },
  { kind: "ofapi_gateway_user_list_users", justification: "Read-through evidence — see ofapi_gateway_chats." },
  { kind: "ofapi_gateway_vault_lists", justification: "Read-through evidence — see ofapi_gateway_chats." },
  { kind: "ofapi_gateway_vault_media", justification: "Read-through evidence — see ofapi_gateway_chats." },
  { kind: "ofapi_gateway_vault_media_item", justification: "Read-through evidence — see ofapi_gateway_chats." },
];

/** Claimants that parse observations OUTSIDE the minutely sweep and are
 *  therefore absent from CANONICALIZER_FAMILIES on purpose. Registering one is
 *  a deliberate act: an unregistered off-sweep parser is indistinguishable
 *  from no parser at all. */
export const OFF_SWEEP_OBSERVATION_CLAIMANTS: readonly {
  id: string;
  kinds: readonly string[];
  justification: string;
}[] = [
  {
    id: "OFAPI_MARKETING_ADMIN_PROJECTION",
    kinds: ["ofapi.marketing_response.v1"],
    justification: "services/projections/ofapi-marketing.ts registers and runs this encrypted operator-response consumer with resumable receipts and an owner rebuild. Frozen command identity and target reconstruct administrative configuration without manufacturing page business events; collection analytics still use the canonical read family.",
  },
  {
    id: "OFAPI_ACTION_RECEIPT_PROJECTION",
    kinds: ["ofapi.action_response.v1"],
    justification: "services/ofapi-actions.ts replays encrypted administrative action receipts into owner-scoped results and idempotent credit accounting. It does not manufacture page business events. Reads and explicit repair resume local settlement without repeating vendor actions.",
  },
  {
    id: "FANSLY_REPLAY_FAMILY",
    kinds: FANSLY_REPLAY_FAMILY.kinds ?? [],
    justification:
      "Deliberately absent from CANONICALIZER_FAMILIES (canonicalize/fansly-replay.ts "
      + "says so in its header): it is flag-driven backfill, not steady-state sweep work.",
  },
  {
    id: "OFAPI_MEDIA_UPLOAD_MATERIALIZATION",
    kinds: ["ofapi.media_source.v1", "ofapi.media_upload_response.v1"],
    justification: "Owned source bytes remain immutable upload authority. The exact governed upload parser and webhook reconciler append safe media metadata facts; one-use CDN tokens stay in captured authority and explicit owner handoff only.",
  },
  {
    id: "OFAPI_TYPED_EXPORT_MATERIALIZATION",
    kinds: ["ofapi.typed_export_artifact.v1"],
    justification: "The owner import transaction verifies frozen account, row, window and checksum contracts and materializes typed export rows and visitor days directly. Invalid bytes remain immutable parse evidence.",
  },
  {
    id: "OFAPI_CAPTURE_MATERIALIZATION",
    kinds: ["ofapi.chat_messages_page.v1", "ofapi.interactive_response.v1"],
    justification:
      "services/ofapi-capture-materialization.ts drains these two kinds on its own tick "
      + "(the kind list there is the same one, verbatim) — governed capture pages are "
      + "materialized, not swept, so no family claims them and that is correct.",
  },
  {
    id: "OFAPI_READTHROUGH_OBSERVATION_KIND",
    kinds: [OFAPI_READTHROUGH_OBSERVATION_KIND],
    justification:
      "Consumed by the read-through reconcile projector, a non-family consumer with its "
      + "own health floor (health-floors.ts).",
  },
];

export type ObservationKindClaim =
  | { claimed: true; by: "family" | "off_sweep" | "dynamic" | "raw_only"; id: string }
  | { claimed: false };

/** The one function the ratchet asks: does anything in this tree own this
 *  kind? Exported so a caller can be given the reason, not just a boolean. */
export function claimObservationKind(entry: WrittenObservationKind): ObservationKindClaim {
  for (const family of CANONICALIZER_FAMILIES) {
    if (family.source !== entry.source) {
      continue;
    }
    if (family.kinds === null || family.kinds.includes(entry.kind)) {
      return { claimed: true, by: "family", id: `${family.source}:${family.lane}` };
    }
  }
  for (const claimant of OFF_SWEEP_OBSERVATION_CLAIMANTS) {
    if (claimant.kinds.includes(entry.kind)) {
      return { claimed: true, by: "off_sweep", id: claimant.id };
    }
  }
  // The explicit allowlist is consulted BEFORE the dynamic rules: a kind that
  // someone wrote a justification for must report as allowlisted, or its
  // justification would read as orphaned and be deleted as dead weight.
  const allowlisted = RAW_ONLY_OBSERVATION_KINDS.find((row) => row.kind === entry.kind);
  if (allowlisted) {
    return { claimed: true, by: "raw_only", id: allowlisted.kind };
  }
  for (const rule of DYNAMIC_OBSERVATION_KIND_RULES) {
    if (rule.matches(entry.kind)) {
      return { claimed: true, by: "dynamic", id: rule.id };
    }
  }
  return { claimed: false };
}
