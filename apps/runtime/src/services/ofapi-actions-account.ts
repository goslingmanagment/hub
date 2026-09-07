import { millsFromCents, millsToDollarsNumber } from "@agency_hub_core/shared";
import { ofapiAccountActionSchema, type OfapiAccountAction } from "../../../../packages/contracts/src/ofapi-actions-account.ts";
import { ofapiWireId } from "./ofapi-command-composer.ts";
import { negativeReceipt } from "./ofapi-payloads.ts";
import type { OfapiActionRequest } from "./ofapi-actions-types.ts";

const readPaths = {
  bank_payout_details_read: "/banking/details/bank", bank_legal_form_read: "/banking/details/legal-form",
  bank_legal_tax_status_read: "/banking/details/legal-info", bank_dac7_form_read: "/banking/details/dac7-form",
  bank_account_country_read: "/banking/details/account-country", bank_countries_read: "/banking/countries",
  bank_payout_systems_read: "/banking/available-payout-systems", payout_eligibility_read: "/payouts/eligibility",
  saved_message_settings_read: "/saved-for-later/messages/settings", saved_post_settings_read: "/saved-for-later/posts/settings",
  account_settings_read: "/settings", blocked_countries_read: "/settings/blocked-countries",
  welcome_message_read: "/settings/welcome-message", account_drm_read: "/settings/drm", social_buttons_read: "/settings/social-media-buttons",
} as const;

/** The account comes exclusively from the server's verified page binding. */
export function ofapiAccountRequest(input: OfapiAccountAction, accountId: string): OfapiActionRequest {
  const command = ofapiAccountActionSchema.parse(input);
  const root = `/${encodeURIComponent(accountId)}`;
  const request = (method: OfapiActionRequest["method"], path: string, body?: unknown, resultKind: OfapiActionRequest["resultKind"] = "ack"): OfapiActionRequest => ({ method, path: `${root}${path}`, ...(body === undefined ? {} : { body }), estimatedCredits: 1, resultKind });
  if (command.action in readPaths) return request("GET", readPaths[command.action as keyof typeof readPaths], undefined, "read");
  switch (command.action) {
    case "payout_frequency_update": return request("PATCH", "/payouts/payout-frequency", { frequency: command.frequency });
    case "payout_withdrawal_request": return request("POST", "/payouts/request-manual-withdrawal", { amount: millsToDollarsNumber(millsFromCents(command.amountCents)) });
    case "saved_messages_read": case "saved_posts_read": return { ...request("GET", `/saved-for-later/${command.action === "saved_messages_read" ? "messages" : "posts"}`, undefined, "read"), query: { limit: String(command.limit), offset: String(command.offset) } };
    case "saved_message_autosend_update": return request("PATCH", "/saved-for-later/messages/settings/enable-or-update-automatic-messaging", { period: command.period });
    case "saved_message_autosend_disable": return request("PATCH", "/saved-for-later/messages/settings/disable-automatic-messaging");
    case "saved_post_autopost_update": return request("PATCH", "/saved-for-later/posts/settings/enable-or-update-automatic-posting", { period: command.period });
    case "saved_post_autopost_disable": return request("PATCH", "/saved-for-later/posts/settings/disable-automatic-posting");
    case "account_profile_update": {
      const { action: _action, pageId: _pageId, clearFields, ...body } = command;
      for (const key of clearFields ?? []) body[key] = null;
      return request("POST", "/settings/profile", body);
    }
    case "subscription_price_update": return request("PATCH", "/settings/subscription-price", { price: command.priceCents === 0 ? "free" : String(millsToDollarsNumber(millsFromCents(command.priceCents))) });
    case "blocked_countries_update": return request("PUT", "/settings/blocked-countries", { blockedCountries: command.blockedCountries, blockedStates: command.blockedStates });
    case "welcome_message_enabled_update": return request("PATCH", "/settings/welcome-message", { enabled: command.enabled });
    case "welcome_message_update": return request("POST", "/settings/welcome-message", {
      text: command.text, lockedText: command.lockedText, price: millsToDollarsNumber(millsFromCents(command.priceCents)),
      mediaFiles: command.mediaFiles.map(ofapiWireId), previews: command.previews.map(ofapiWireId),
      ...(command.rfTag.length ? { rfTag: command.rfTag.map(ofapiWireId) } : {}),
      ...(command.rfGuest.length ? { rfGuest: command.rfGuest.map(ofapiWireId) } : {}),
      ...(command.rfPartner.length ? { rfPartner: command.rfPartner.map(ofapiWireId) } : {}),
      ...(command.isForward === undefined ? {} : { isForward: command.isForward }),
    }, "resource");
    case "account_drm_update": return request("PATCH", "/settings/drm", { enabled: command.enabled });
    case "username_availability_read": return request("POST", "/settings/username-exists", { username: command.username }, "read");
    case "social_buttons_reorder": return request("POST", "/settings/social-media-buttons/reorder", { button_ids: command.buttonIds.map(ofapiWireId) });
    case "social_button_create": return request("POST", "/settings/social-media-buttons", { label: command.label, type: command.type, value: command.value });
    case "social_button_update": return request("PUT", `/settings/social-media-buttons/${encodeURIComponent(command.buttonId)}`, { label: command.label });
    case "social_button_delete": return request("DELETE", `/settings/social-media-buttons/${encodeURIComponent(command.buttonId)}`);
    default: throw new Error("Unsupported account action");
  }
}

function object(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function resourceId(value: unknown): string | null { const id = object(value)?.id; return typeof id === "string" && /^\d+$/.test(id) ? id : typeof id === "number" && Number.isSafeInteger(id) && id >= 0 ? String(id) : null; }

/** A confirmed withdrawal means an accepted request; it never means money reached the bank. */
export function ofapiAccountResultConfirmed(command: OfapiAccountAction, status: number, body: unknown): boolean {
  if (status < 200 || status >= 300) return false;
  const envelope = object(body);
  if (!envelope || !("data" in envelope) || negativeReceipt(envelope)) return false;
  const data = envelope.data;
  const row = object(data);
  // Only this read uses a false success field as its ordinary domain answer.
  // Provider errors still override that answer and every mutation receipt.
  if (negativeReceipt(row, { allowFalseSuccess: command.action === "username_availability_read" })) return false;
  if (command.action === "username_availability_read") return typeof row?.success === "boolean";
  if (command.action in readPaths || command.action === "saved_messages_read" || command.action === "saved_posts_read") return Array.isArray(data) || row !== null;
  switch (command.action) {
    case "payout_withdrawal_request": return Array.isArray(row?.list) && row.list.length > 0 && row.list.every(item => object(item)?.state === "new" && object(item)?.rejectReason === null);
    case "saved_message_autosend_update": case "saved_post_autopost_update": return row?.period === command.period;
    case "saved_message_autosend_disable": case "saved_post_autopost_disable": return Array.isArray(data) && data.length === 0;
    case "welcome_message_update": return resourceId(data) !== null && row?.template === "reply_on_subscribe";
    case "social_button_create": return Array.isArray(data) && data.some(item => resourceId(item) !== null && object(item)?.label === command.label && object(item)?.socialMedia === command.type);
    case "social_button_update": return Array.isArray(data) && data.some(item => resourceId(item) === command.buttonId && object(item)?.label === command.label);
    case "social_buttons_reorder": return Array.isArray(data) && data.length === command.buttonIds.length && data.every((item, index) => resourceId(item) === command.buttonIds[index]);
    default: return row?.success === true;
  }
}
