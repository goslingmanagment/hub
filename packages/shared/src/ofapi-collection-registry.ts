/** Collection capability is distinct from permission to start collecting. */
export const OFAPI_COLLECTION_CATEGORIES = [
  "core_messages", "core_payments", "core_audience", "posts_comments", "visitors",
  "tracking_links", "smart_links", "vault_catalog", "vault_files", "balances",
  "profile_notifications", "content_history",
] as const;
export type OfapiCollectionCategory = typeof OFAPI_COLLECTION_CATEGORIES[number];
export type OfapiCollectionMode = "off" | "on_demand" | "scheduled";
export type OfapiCollectionPurpose = "background" | "interactive" | "one_off";
export interface OfapiCollectionContext {
  category: OfapiCollectionCategory;
  purpose: OfapiCollectionPurpose;
  jobId?: string;
  detail?: boolean;
  reservedCredits?: number;
}
export interface OfapiCollectionSettings {
  pageId: number | null;
  category: OfapiCollectionCategory;
  mode: OfapiCollectionMode;
  intervalMinutes: number;
  dailyCreditLimit: number;
  maxCallsPerRun: number;
  includeDetails: boolean;
}
/** Existing callers may use their old config only until this category receives a policy. */
export const OFAPI_COLLECTION_LEGACY_OPERATIONS = [
  "ofapi_chats", "ofapi_chat_messages", "ofapi_transactions", "ofapi_chargebacks", "ofapi_fans_active",
  "ofapi_tracking_links", "ofapi_trial_links", "ofapi_trial_link_subscribers",
  "ofapi_capture_chat_messages", "ofapi_capture_posts", "ofapi_export_quote_create", "ofapi_export_quote_status", "ofapi_export_start",
  "ofapi_gateway_chats", "ofapi_gateway_chat_messages", "ofapi_gateway_chat_search", "ofapi_gateway_chat_message", "ofapi_gateway_chat_media",
  "ofapi_gateway_users_list", "ofapi_gateway_user", "ofapi_gateway_transactions", "ofapi_gateway_user_lists", "ofapi_gateway_user_list_users",
  "ofapi_gateway_vault_media", "ofapi_gateway_vault_lists", "ofapi_gateway_vault_media_item",
] as const;
export const OFAPI_COLLECTION_REGISTRY = OFAPI_COLLECTION_CATEGORIES.map(id => ({
  id,
  label: ({ core_messages: "Messages", core_payments: "Payments", core_audience: "Audience",
    posts_comments: "Posts and comments", visitors: "Profile visitors", tracking_links: "Tracking links",
    smart_links: "Smart links", vault_catalog: "Vault catalog", vault_files: "Vault files",
    balances: "Balances and payouts", profile_notifications: "Profile and notifications",
    content_history: "Stories, highlights and queue history" })[id],
  modes: id === "vault_files" ? ["off"] as const : ["off", "on_demand", "scheduled"] as const,
  baseline: ["core_messages", "core_payments", "core_audience"].includes(id),
  consumers: id === "core_messages" ? ["chatters", "Agent Read"] : ["dashboard", "Agent Read"],
  supportsOneOff: true,
  priceUnit: id === "vault_files" ? "calls_and_bytes" as const : "physical_calls" as const,
  prerequisites: id === "vault_files" ? ["explicit bounded file selection"] : ["active OFAPI page binding"],
  scope: "page" as const,
  legacyOperations: OFAPI_COLLECTION_LEGACY_OPERATIONS.filter(operation => classifyOfapiCollectionOperation(operation) === id),
}));

/** Fixed migration baseline. Unknown operations fail closed at the collection boundary. */
export function classifyOfapiCollectionOperation(operation: string): OfapiCollectionCategory | "diagnostic" | "command" | null {
  if (operation === "ofapi_export_cancel") return "command";
  if (operation === "ofapi_export_inventory") return "diagnostic";
  if (["ofapi_upload_vault", "ofapi_upload_cdn", "ofapi_upload_status"].includes(operation)) return "vault_files";
  if (/^ofapi_command_/.test(operation)) return "command";
  if (["ofapi_balance_ping", "ofapi_credential_preflight", "ofapi_admin_accounts", "ofapi_webhook_crud", "ofapi_webhook_inventory",
    "ofapi_stored_tracking_links", "ofapi_stored_trial_links"].includes(operation)) return "diagnostic";
  if (/chat|message/.test(operation) && !/export/.test(operation)) return "core_messages";
  if (/transaction|chargeback/.test(operation)) return "core_payments";
  if (/fans_active|subscriber|fan_profile|user_detail|users_get/.test(operation) && !/link/.test(operation)) return "core_audience";
  if (["ofapi_gateway_user", "ofapi_gateway_users_list", "ofapi_gateway_user_lists", "ofapi_gateway_user_list_users"].includes(operation)) return "core_audience";
  if (["ofapi_gateway_upload_status", "ofapi_export_quote_status"].includes(operation)) return "diagnostic";
  if (/visitor/.test(operation)) return "visitors";
  if (/smart_link/.test(operation)) return "smart_links";
  if (/tracking|trial_link/.test(operation)) return "tracking_links";
  if (/vault.*download|vault.*file/.test(operation)) return "vault_files";
  if (/vault/.test(operation)) return "vault_catalog";
  if (/post|comment/.test(operation)) return "posts_comments";
  if (/balance|payout/.test(operation)) return "balances";
  if (/story|stories|highlight|queue/.test(operation)) return "content_history";
  if (/fans_|following|notification|users_|profile|_me$/.test(operation)) return "profile_notifications";
  if (/export/.test(operation)) return "core_messages";
  return null;
}
