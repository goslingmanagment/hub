import { describe, expect, it } from "vitest";
import { ofapiAccountActionOptions, ofapiAccountActionSchema, type OfapiAccountAction } from "../packages/contracts/src/ofapi-actions-account.ts";
import { ofapiAccountRequest, ofapiAccountResultConfirmed } from "../apps/runtime/src/services/ofapi-actions-account.ts";
import { ofapiAccountForms } from "../apps/dashboard/src/pages/ofapi-actions/account-forms.ts";

const parse = (action: string, parameters: Record<string, unknown> = {}) => ofapiAccountActionSchema.parse({ action, pageId: 7, ...parameters });
const request = (action: string, parameters: Record<string, unknown> = {}) => ofapiAccountRequest(parse(action, parameters), "acct_bound");

describe("account settings, banking reads and provider automation actions", () => {
  it("exposes every account action through an owner form without introducing user subscriptions or bank writes", () => {
    const names = ofapiAccountActionOptions.map(option => option.shape.action.value);
    expect(names).toHaveLength(34);
    expect(new Set(names).size).toBe(names.length);
    expect(ofapiAccountForms.map(form => form.action).sort()).toEqual([...names].sort());
    expect(names.some(name => /subscribe|unsubscribe/.test(name))).toBe(false);
    for (const name of names.filter(name => name.startsWith("bank_"))) {
      expect(request(name)).toMatchObject({ method: "GET", resultKind: "read", estimatedCredits: 1 });
      expect(request(name).body).toBeUndefined();
    }
    expect(ofapiAccountActionSchema.safeParse({ action: "subscribe_user", pageId: 7, userId: "1" }).success).toBe(false);
  });

  it("keeps the server binding authoritative and rejects arbitrary request fields and path IDs", () => {
    for (const injection of [{ accountId: "acct_foreign" }, { path: "/settings" }, { method: "DELETE" }, { url: "https://example.com" }]) {
      expect(ofapiAccountActionSchema.safeParse({ action: "account_settings_read", pageId: 7, ...injection }).success).toBe(false);
    }
    expect(() => request("social_button_delete", { buttonId: "../bank" })).toThrow();
    expect(ofapiAccountRequest(parse("account_settings_read"), "acct_/foreign?key=bad").path).toBe("/acct_%2Fforeign%3Fkey%3Dbad/settings");
    expect(request("social_button_delete", { buttonId: "9007199254740993" }).path).toBe("/acct_bound/settings/social-media-buttons/9007199254740993");
  });

  it("uses only native automation endpoints and exact supported hour intervals", () => {
    for (const period of [6, 12, 24, 48]) {
      expect(request("saved_message_autosend_update", { period })).toEqual({ method: "PATCH", path: "/acct_bound/saved-for-later/messages/settings/enable-or-update-automatic-messaging", body: { period }, estimatedCredits: 1, resultKind: "ack" });
      expect(request("saved_post_autopost_update", { period })).toMatchObject({ method: "PATCH", path: "/acct_bound/saved-for-later/posts/settings/enable-or-update-automatic-posting", body: { period } });
    }
    for (const period of [0, 1, 8, 24.5, 72, "24"]) expect(() => parse("saved_post_autopost_update", { period })).toThrow();
    expect(request("saved_message_autosend_disable").body).toBeUndefined();
    expect(request("saved_post_autopost_disable").method).toBe("PATCH");
    expect(request("saved_messages_read").query).toEqual({ limit: "10", offset: "0" });
    expect(request("saved_posts_read", { limit: 100, offset: 100 }).query).toEqual({ limit: "100", offset: "100" });
    expect(() => parse("saved_messages_read", { limit: 0 })).toThrow();
    expect(() => parse("saved_messages_read", { offset: -1 })).toThrow();
  });

  it("requires the provider's period echo and empty disable result, not any successful HTTP status", () => {
    const enable = parse("saved_message_autosend_update", { period: 12 });
    expect(ofapiAccountResultConfirmed(enable, 200, { data: { period: 12 } })).toBe(true);
    for (const body of [{ data: { period: 24 } }, { data: { success: true } }, {}, null]) expect(ofapiAccountResultConfirmed(enable, 200, body)).toBe(false);
    const disable = parse("saved_post_autopost_disable");
    expect(ofapiAccountResultConfirmed(disable, 200, { data: [] })).toBe(true);
    expect(ofapiAccountResultConfirmed(disable, 200, { data: [{ period: 12 }] })).toBe(false);
    expect(ofapiAccountResultConfirmed(enable, 500, { data: { period: 12 } })).toBe(false);
  });

  it("converts money through shared codecs and accepts a withdrawal request without claiming settlement", () => {
    expect(request("payout_withdrawal_request", { amountCents: 5000 }).body).toEqual({ amount: 50 });
    for (const amountCents of [0, -100, 5050, Number.MAX_SAFE_INTEGER + 1]) expect(() => parse("payout_withdrawal_request", { amountCents })).toThrow();
    const withdrawal = parse("payout_withdrawal_request", { amountCents: 5000 });
    expect(ofapiAccountResultConfirmed(withdrawal, 200, { data: { list: [{ state: "new", rejectReason: null }] } })).toBe(true);
    for (const data of [{ list: [] }, { list: [{ state: "rejected", rejectReason: "Insufficient balance" }] }, { success: true }, { list: [{ state: "new" }] }]) expect(ofapiAccountResultConfirmed(withdrawal, 200, { data })).toBe(false);
    expect(ofapiAccountForms.find(form => form.action === "payout_withdrawal_request")?.description).toContain("а не поступление денег в банк");
    expect(() => parse("payout_frequency_update", { frequency: "daily" })).toThrow();
    expect(request("payout_frequency_update", { frequency: "manual" }).body).toEqual({ frequency: "manual" });
  });

  it("keeps subscription pricing exact at free, minimum and maximum boundaries", () => {
    expect(request("subscription_price_update", { priceCents: 0 }).body).toEqual({ price: "free" });
    expect(request("subscription_price_update", { priceCents: 499 }).body).toEqual({ price: "4.99" });
    expect(request("subscription_price_update", { priceCents: 20_000 }).body).toEqual({ price: "200" });
    for (const priceCents of [1, 498, 20_001, 499.5]) expect(() => parse("subscription_price_update", { priceCents })).toThrow();
  });

  it("preserves omitted profile fields and clears only specifically selected nullable fields", () => {
    expect(request("account_profile_update", { name: "New name" }).body).toEqual({ name: "New name" });
    expect(request("account_profile_update", { clearFields: ["about", "website"] }).body).toEqual({ about: null, website: null });
    expect(request("account_profile_update", { name: null }).body).toEqual({ name: null });
    expect(() => parse("account_profile_update")).toThrow();
    expect(() => parse("account_profile_update", { about: "Keep me", clearFields: ["about"] })).toThrow();
    expect(() => parse("account_profile_update", { avatar: "12345" })).toThrow();
    expect(() => parse("account_profile_update", { website: "javascript:alert(1)" })).toThrow();
    expect(request("account_profile_update", { avatar: "ofapi_media_abc123" }).body).toEqual({ avatar: "ofapi_media_abc123" });
  });

  it("treats geography as a complete replacement, preserving explicit clears and region data", () => {
    expect(request("blocked_countries_update", { blockedCountries: ["US", "RU"], blockedStates: ["US-CA"] }).body).toEqual({ blockedCountries: ["US", "RU"], blockedStates: ["US-CA"] });
    expect(request("blocked_countries_update", { blockedCountries: [] }).body).toEqual({ blockedCountries: [], blockedStates: [] });
    expect(request("blocked_countries_update", { blockedCountries: null }).body).toEqual({ blockedCountries: null, blockedStates: [] });
    expect(() => parse("blocked_countries_update", { blockedCountries: ["us"] })).toThrow();
    expect(() => parse("blocked_countries_update", { blockedCountries: ["US", "US"] })).toThrow();
  });

  it("requires welcome media for paid content and keeps previews and release-form IDs exact", () => {
    expect(() => parse("welcome_message_update", { text: "", priceCents: 0 })).toThrow();
    expect(() => parse("welcome_message_update", { text: "Paid", priceCents: 300 })).toThrow();
    expect(() => parse("welcome_message_update", { text: "Paid", priceCents: 300, mediaFiles: ["123"], previews: ["999"] })).toThrow();
    expect(request("welcome_message_update", { text: "Hello", priceCents: 500, mediaFiles: ["ofapi_media_abc", "9007199254740993"], previews: ["ofapi_media_abc"], rfTag: ["123", "9007199254740993"] }).body).toEqual({ text: "Hello", lockedText: false, price: 5, mediaFiles: ["ofapi_media_abc", "9007199254740993"], previews: ["ofapi_media_abc"], rfTag: [123, "9007199254740993"] });
    expect(ofapiAccountResultConfirmed(parse("welcome_message_update", { text: "Hello", priceCents: 0 }), 200, { data: { id: "123", template: "reply_on_subscribe" } })).toBe(true);
  });

  it("keeps an unavailable username a valid read answer and does not confuse false settings acknowledgements", () => {
    const username = parse("username_availability_read", { username: "already_used" });
    expect(request("username_availability_read", { username: "already_used" })).toMatchObject({ method: "POST", resultKind: "read" });
    expect(ofapiAccountResultConfirmed(username, 200, { data: { success: false } })).toBe(true);
    expect(ofapiAccountResultConfirmed(parse("account_drm_update", { enabled: false }), 200, { data: { success: false } })).toBe(false);
    expect(request("account_drm_update", { enabled: false }).body).toEqual({ enabled: false });
  });

  it("validates social button arrays against the affected button and submitted order", () => {
    expect(() => parse("social_button_create", { label: "IG", type: "Instagram", value: "alice" })).toThrow();
    expect(() => parse("social_button_update", { buttonId: "123", label: "IG", value: "different" })).toThrow();
    expect(() => parse("social_buttons_reorder", { buttonIds: ["123", "123"] })).toThrow();
    expect(request("social_buttons_reorder", { buttonIds: ["123", "9007199254740993"] }).body).toEqual({ button_ids: [123, "9007199254740993"] });
    const update = parse("social_button_update", { buttonId: "123", label: "IG" });
    expect(ofapiAccountResultConfirmed(update, 200, { data: [{ id: 123, label: "IG" }] })).toBe(true);
    expect(ofapiAccountResultConfirmed(update, 200, { data: [{ id: 456, label: "IG" }] })).toBe(false);
    const reorder = parse("social_buttons_reorder", { buttonIds: ["123", "456"] });
    expect(ofapiAccountResultConfirmed(reorder, 200, { data: [{ id: 123 }, { id: 456 }] })).toBe(true);
    expect(ofapiAccountResultConfirmed(reorder, 200, { data: [{ id: 456 }, { id: 123 }] })).toBe(false);
    expect(() => ofapiAccountRequest({ action: "social_button_delete", pageId: 7, buttonId: "123", endpoint: "/bank" } as unknown as OfapiAccountAction, "acct_bound")).toThrow();
  });
});
