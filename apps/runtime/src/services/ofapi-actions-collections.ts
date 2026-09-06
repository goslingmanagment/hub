import type { OfapiCollectionAction } from "../../../../packages/contracts/src/ofapi-actions-collections.ts";
import type { OfapiActionRequest } from "./ofapi-actions-types.ts";

/** Build a closed provider request only after account binding and principal checks. */
export function ofapiCollectionRequest(command: OfapiCollectionAction, accountId: string): OfapiActionRequest {
  const account = `/${encodeURIComponent(accountId)}`;
  const userLists = `${account}/user-lists`;
  const vaultLists = `${account}/media/vault/lists`;
  const list = "listId" in command ? encodeURIComponent(command.listId) : "";
  const user = "userId" in command ? encodeURIComponent(command.userId) : "";
  const fan = "fanId" in command ? encodeURIComponent(command.fanId) : "";
  const request = (method: OfapiActionRequest["method"], path: string, resultKind: OfapiActionRequest["resultKind"], body?: unknown): OfapiActionRequest => ({
    method, path, resultKind, estimatedCredits: 1, ...(body === undefined ? {} : { body }),
  });

  switch (command.action) {
    case "user_list_create":
      return request("POST", userLists, "resource", { name: command.name });
    case "user_list_update":
      return request("PUT", `${userLists}/${list}`, "resource", {
        name: command.name, ...(command.isPinnedToFeed === undefined ? {} : { isPinnedToFeed: command.isPinnedToFeed }),
      });
    case "user_list_delete":
      return request("DELETE", `${userLists}/${list}`, "ack");
    case "user_list_add_users":
      return {
        method: "POST", path: `${userLists}/${list}/users`,
        body: { ids: command.ids, ...(command.skip_invalid === undefined ? {} : { skip_invalid: command.skip_invalid }) },
        // A single Hub attempt can make up to five billed provider attempts.
        estimatedCredits: command.skip_invalid === true ? 5 : 1,
        resultKind: command.skip_invalid === true ? "partial" : "ack",
      };
    case "user_list_clear":
      return request("DELETE", `${userLists}/${list}/users`, "resource");
    case "user_list_remove_user":
      return request("DELETE", `${userLists}/${list}/users/${user}`, "ack");
    case "user_list_pin_toggle":
      return request("POST", `${userLists}/${list}/users/${user}/pin`, "ack");
    case "vault_list_create":
      return request("POST", vaultLists, "resource", { name: command.name });
    case "vault_list_update":
      return request("PUT", `${vaultLists}/${list}`, "resource", { name: command.name });
    case "vault_list_delete":
      return request("DELETE", `${vaultLists}/${list}`, "ack");
    case "vault_list_add_media":
      return request("POST", `${vaultLists}/${list}/media`, "resource", { mediaIds: command.mediaIds });
    case "vault_list_remove_media":
      return request("DELETE", `${vaultLists}/${list}/media`, "resource", { mediaIds: command.mediaIds });
    case "vault_media_delete":
      return request("DELETE", `${account}/media/vault/delete-media`, "ack", { mediaIds: command.mediaIds });
    case "user_block":
      return request("POST", `${account}/users/${user}/block`, "resource");
    case "user_unblock":
      return request("DELETE", `${account}/users/${user}/block`, "resource");
    case "user_restrict":
      return request("POST", `${account}/users/${user}/restrict`, "resource");
    case "user_unrestrict":
      return request("DELETE", `${account}/users/${user}/restrict`, "resource");
    case "fan_notes_get":
      return request("GET", `${account}/fans/${fan}/notes`, "read");
    case "fan_notes_update":
      return request("PUT", `${account}/fans/${fan}/notes`, "resource", { notes: command.notes });
    case "fan_notes_clear":
      return request("DELETE", `${account}/fans/${fan}/notes`, "resource");
  }
}
