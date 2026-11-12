import { describe, expect, it } from "vitest";
import type { Database } from "@agency_hub_core/db";
import { assertOfapiConfiguredAccess } from "../apps/runtime/src/services/ofapi-vendor-usage.ts";
import { ofapiActionRequest } from "../apps/runtime/src/services/ofapi-actions-registry.ts";

const ACCOUNT = "acct_test1";
const FINGERPRINT = "a".repeat(64);

function declared(capabilities: string[] | null): Database {
  return { execute: async () => ({ rows: [{ version: 1, capabilities, account_ids: null, visibility: "unknown", updated_at: "" }] }) } as unknown as Database;
}
const noDeclaration = { execute: async () => ({ rows: [] }) } as unknown as Database;

type Request = { operation: string; method: string; pathname?: string; accountId?: string | null };
const check = (db: Database, request: Request) => assertOfapiConfiguredAccess(db, FINGERPRINT, request);
const action = (command: Record<string, unknown>): Request => {
  const request = ofapiActionRequest({ pageId: 1, ...command } as never, ACCOUNT);
  return { operation: `ofapi_command_action_${String(command.action)}`, method: request.method, pathname: request.path, accountId: ACCOUNT };
};

const vaultUpload: Request = { operation: "ofapi_upload_vault", method: "POST", pathname: `/${ACCOUNT}/media/vault` };
const listCreate = action({ action: "vault_list_create", name: "Album" });
const listAddMedia = action({ action: "vault_list_add_media", listId: "123", mediaIds: ["456"] });
const uploadStatus: Request = { operation: "ofapi_upload_status", method: "GET", pathname: `/${ACCOUNT}/media/uploads/ofapi_media_x/status` };

const refusedWithVault: Array<[string, Request]> = [
  ["a post", { operation: "ofapi_command_action_post_create", method: "POST", pathname: `/${ACCOUNT}/posts` }],
  ["a story", { operation: "ofapi_command_action_story_create", method: "POST", pathname: `/${ACCOUNT}/stories` }],
  ["a message", { operation: "ofapi_publish_message", method: "POST", pathname: `/${ACCOUNT}/chats/1/messages` }],
  ["an upload for a post", { operation: "ofapi_upload_cdn", method: "POST", pathname: `/${ACCOUNT}/media/upload` }],
  ["deleting a vault list", action({ action: "vault_list_delete", listId: "123" })],
  ["renaming a vault list", action({ action: "vault_list_update", listId: "123", name: "Other" })],
  ["deleting vault media", action({ action: "vault_media_delete", mediaIds: ["456"] })],
  ["removing media from a list", action({ action: "vault_list_remove_media", listId: "123", mediaIds: ["456"] })],
];

const mismatched: Array<[string, Request]> = [
  ["vault upload label on the post upload path", { ...vaultUpload, pathname: `/${ACCOUNT}/media/upload` }],
  ["vault upload label on a post path", { ...vaultUpload, pathname: `/${ACCOUNT}/posts` }],
  ["vault upload label without a path", { operation: "ofapi_upload_vault", method: "POST" }],
  ["list create label on a message path", { ...listCreate, pathname: `/${ACCOUNT}/chats/1/messages` }],
  ["list create label with DELETE", { ...listCreate, method: "DELETE" }],
  ["add media label on the remove-media request", { ...action({ action: "vault_list_remove_media", listId: "123", mediaIds: ["456"] }), operation: "ofapi_command_action_vault_list_add_media" }],
  ["add media label on the delete-media path", { ...listAddMedia, pathname: `/${ACCOUNT}/media/vault/delete-media` }],
  ["add media label with a trailing segment", { ...listAddMedia, pathname: `${listAddMedia.pathname}/extra` }],
  ["add media label for another account", { ...listAddMedia, accountId: "acct_other" }],
];

describe("OFAPI key scope: vault", () => {
  const vaultKey = declared(["reads", "webhooks", "links", "vault"]);

  it("lets exactly the three vault writes and the upload status read through", async () => {
    for (const request of [vaultUpload, listCreate, listAddMedia, uploadStatus]) {
      await expect(check(vaultKey, request)).resolves.toBeUndefined();
    }
  });

  it.each(refusedWithVault)("refuses %s", async (_, request) => {
    await expect(check(vaultKey, request)).rejects.toThrow(/does not allow/);
  });

  it.each(mismatched)("refuses the %s for every key", async (_, request) => {
    for (const db of [vaultKey, declared(null), declared(["reads", "commands", "uploads", "vault"]), noDeclaration]) {
      await expect(check(db, request)).rejects.toThrow(/does not match its method and path/);
    }
  });

  it("keeps scopes without vault as before", async () => {
    const readsOnly = declared(["reads", "webhooks", "links"]);
    for (const request of [vaultUpload, listCreate, listAddMedia, ...refusedWithVault.map(([, r]) => r)]) {
      await expect(check(readsOnly, request)).rejects.toThrow(/does not allow/);
    }
    const uploads = declared(["uploads"]);
    await expect(check(uploads, vaultUpload)).resolves.toBeUndefined();
    await expect(check(uploads, refusedWithVault[3]![1])).resolves.toBeUndefined();
    await expect(check(uploads, uploadStatus)).resolves.toBeUndefined();
    await expect(check(uploads, listCreate)).rejects.toThrow(/does not allow/);
    const commands = declared(["commands"]);
    for (const request of [listCreate, listAddMedia, ...refusedWithVault.filter(([name]) => name !== "an upload for a post").map(([, r]) => r)]) {
      await expect(check(commands, request)).resolves.toBeUndefined();
    }
    await expect(check(commands, vaultUpload)).rejects.toThrow(/does not allow/);
    for (const request of [vaultUpload, listCreate, ...refusedWithVault.map(([, r]) => r)]) {
      await expect(check(declared(null), request)).resolves.toBeUndefined();
      await expect(check(noDeclaration, request)).resolves.toBeUndefined();
    }
  });
});
