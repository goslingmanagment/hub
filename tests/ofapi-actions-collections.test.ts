import { describe, expect, it } from "vitest";
import { ofapiCollectionActionSchema } from "../packages/contracts/src/ofapi-actions-collections.ts";
import { ofapiCollectionRequest } from "../apps/runtime/src/services/ofapi-actions-collections.ts";

const build = (value: unknown) => ofapiCollectionRequest(ofapiCollectionActionSchema.parse(value), "acct_bound");

describe("OFAPI collection actions", () => {
  it("rejects subscription purchases, arbitrary endpoints and caller-supplied account bindings", () => {
    for (const value of [
      { action: "user_subscribe", pageId: 7, userId: "123" },
      { action: "user_unsubscribe", pageId: 7, userId: "123" },
      { action: "user_block", pageId: 7, userId: "123", accountId: "acct_other" },
      { action: "user_block", pageId: 7, userId: "123", path: "/acct_other/users/123/subscribe" },
      { action: "user_block", pageId: 0, userId: "123" },
      { action: "user_list_add_users", pageId: 7, listId: "following", ids: ["123"] },
      { action: "user_list_clear", pageId: 7, listId: "FOLLOWING" },
      { action: "user_list_remove_user", pageId: 7, listId: "following", userId: "123" },
    ]) expect(ofapiCollectionActionSchema.safeParse(value).success).toBe(false);
  });

  it("keeps decimal IDs lossless and prevents resource IDs from changing the route", () => {
    expect(build({ action: "user_list_remove_user", pageId: 7, listId: "friends", userId: "9007199254740993" })).toMatchObject({
      method: "DELETE", path: "/acct_bound/user-lists/friends/users/9007199254740993",
    });
    for (const listId of ["../users", "123?account=other", "123/../456", "%2f", ""]) {
      expect(ofapiCollectionActionSchema.safeParse({ action: "user_list_delete", pageId: 7, listId }).success).toBe(false);
    }
    expect(ofapiCollectionActionSchema.safeParse({ action: "user_block", pageId: 7, userId: 9007199254740992 }).success).toBe(false);
  });

  it("reserves five credits only for explicitly selected skip-invalid and requires partial-result interpretation", () => {
    const value = { action: "user_list_add_users", pageId: 7, listId: "tagged", ids: ["123", "9007199254740993"] };
    expect(build({ ...value, skip_invalid: true })).toEqual({
      method: "POST", path: "/acct_bound/user-lists/tagged/users", body: { ids: value.ids, skip_invalid: true }, estimatedCredits: 5, resultKind: "partial",
    });
    expect(build(value)).toMatchObject({ body: { ids: value.ids }, estimatedCredits: 1, resultKind: "ack" });
    expect(build(value).body).not.toHaveProperty("skip_invalid");
    expect(build({ ...value, skip_invalid: false })).toMatchObject({ body: { ids: value.ids, skip_invalid: false }, estimatedCredits: 1 });
  });

  it("rejects empty, duplicated or unbounded batches before provider spend", () => {
    for (const ids of [[], ["123", "123"], ["0"], ["123", 456], Array.from({ length: 1001 }, (_, i) => String(i + 1))]) {
      expect(ofapiCollectionActionSchema.safeParse({ action: "user_list_add_users", pageId: 7, listId: "tagged", ids }).success).toBe(false);
    }
    expect(ofapiCollectionActionSchema.safeParse({ action: "vault_media_delete", pageId: 7, mediaIds: [] }).success).toBe(false);
  });

  it("distinguishes deletion of a list, clearing its members and removing one member", () => {
    expect(build({ action: "user_list_delete", pageId: 7, listId: "123" }).path).toBe("/acct_bound/user-lists/123");
    expect(build({ action: "user_list_clear", pageId: 7, listId: "123" }).path).toBe("/acct_bound/user-lists/123/users");
    expect(build({ action: "user_list_remove_user", pageId: 7, listId: "123", userId: "456" }).path).toBe("/acct_bound/user-lists/123/users/456");
    expect(build({ action: "user_list_pin_toggle", pageId: 7, listId: "friends", userId: "456" })).toEqual({
      method: "POST", path: "/acct_bound/user-lists/friends/users/456/pin", estimatedCredits: 1, resultKind: "ack",
    });
    expect(ofapiCollectionActionSchema.safeParse({ action: "user_list_pin_toggle", pageId: 7, listId: "friends", userId: "456", pinned: true }).success).toBe(false);
  });

  it("preserves explicit false and null feed pin states without fabricating optional settings", () => {
    const value = { action: "user_list_update", pageId: 7, listId: "123", name: "VIP" };
    expect(build(value).body).toEqual({ name: "VIP" });
    expect(build({ ...value, isPinnedToFeed: false }).body).toEqual({ name: "VIP", isPinnedToFeed: false });
    expect(build({ ...value, isPinnedToFeed: null }).body).toEqual({ name: "VIP", isPinnedToFeed: null });
    expect(ofapiCollectionActionSchema.safeParse({ ...value, name: "x".repeat(65) }).success).toBe(false);
    expect(ofapiCollectionActionSchema.safeParse({ action: "vault_list_update", pageId: 7, listId: "123", name: "x".repeat(256) }).success).toBe(false);
  });

  it("retains DELETE request bodies and distinguishes membership removal from vault deletion", () => {
    const mediaIds = ["9007199254740993", "456"];
    expect(build({ action: "vault_list_add_media", pageId: 7, listId: "123", mediaIds })).toMatchObject({ method: "POST", path: "/acct_bound/media/vault/lists/123/media", body: { mediaIds } });
    expect(build({ action: "vault_list_remove_media", pageId: 7, listId: "123", mediaIds })).toMatchObject({ method: "DELETE", path: "/acct_bound/media/vault/lists/123/media", body: { mediaIds } });
    expect(build({ action: "vault_media_delete", pageId: 7, mediaIds })).toMatchObject({ method: "DELETE", path: "/acct_bound/media/vault/delete-media", body: { mediaIds } });
  });

  it.each([
    ["user_block", "POST", "block"], ["user_unblock", "DELETE", "block"],
    ["user_restrict", "POST", "restrict"], ["user_unrestrict", "DELETE", "restrict"],
  ])("maps %s to the exact moderation operation without purchasing a subscription", (action, method, suffix) => {
    expect(build({ action, pageId: 7, userId: "123" })).toEqual({ method, path: `/acct_bound/users/123/${suffix}`, estimatedCredits: 1, resultKind: "resource" });
  });

  it("keeps native notes verbatim and routes only to the provider notes resource", () => {
    const value = { pageId: 7, fanId: "9007199254740993" };
    expect(build({ action: "fan_notes_get", ...value })).toMatchObject({ method: "GET", path: "/acct_bound/fans/9007199254740993/notes", resultKind: "read" });
    expect(build({ action: "fan_notes_update", ...value, notes: "  private OF note\nnext line  " }).body).toEqual({ notes: "  private OF note\nnext line  " });
    expect(build({ action: "fan_notes_clear", ...value })).toMatchObject({ method: "DELETE", path: "/acct_bound/fans/9007199254740993/notes" });
    expect(build({ action: "fan_notes_update", ...value, notes: "" }).body).toEqual({ notes: "" });
    expect(ofapiCollectionActionSchema.safeParse({ action: "fan_notes_update", ...value, notes: "x".repeat(16001) }).success).toBe(false);
  });
});
