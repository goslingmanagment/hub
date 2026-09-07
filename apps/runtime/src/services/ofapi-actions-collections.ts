import type { OfapiCollectionAction } from "../../../../packages/contracts/src/ofapi-actions-collections.ts";
import { negativeReceipt } from "./ofapi-payloads.ts";
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

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function returnedId(value: unknown): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? value : null;
}

function returnedListId(value: unknown): string | null {
  if (typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)) return value;
  return returnedId(value);
}

function exactIds(actual: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(actual)) return false;
  const ids = actual.map(returnedId);
  return ids.length === expected.length && new Set(ids).size === ids.length
    && ids.every(id => id !== null && expected.includes(id));
}

/** Positive receipt evidence only. The shared engine owns HTTP, the envelope and final state. */
export function ofapiCollectionResultConfirmed(command: OfapiCollectionAction, responseData: unknown): boolean {
  const data = record(responseData);
  if (!data || negativeReceipt(data)) return false;
  switch (command.action) {
    case "user_list_create":
    case "vault_list_create":
      return returnedId(data.id) !== null;
    case "user_list_update":
    case "user_list_clear":
    case "vault_list_update":
    case "vault_list_add_media":
    case "vault_list_remove_media":
      return returnedListId(data.id) === command.listId;
    case "user_list_delete":
    case "user_list_pin_toggle":
    case "vault_list_delete":
    case "vault_media_delete":
      return data.success === true;
    case "user_list_add_users": {
      if (command.skip_invalid !== true) return exactIds(data[command.listId], command.ids);
      const failed = record(data.failed);
      if (!failed || !Array.isArray(data.added) || !Object.values(failed).every(reason => typeof reason === "string")) return false;
      return exactIds([...data.added, ...Object.keys(failed)], command.ids);
    }
    case "user_list_remove_user": {
      const list = record(data.list);
      const membership = record(data.userState);
      // userState.id is the list ID, not the removed user's ID.
      return returnedListId(list?.id) === command.listId
        && returnedListId(membership?.id) === command.listId && membership?.hasUser === false;
    }
    case "user_block":
    case "user_unblock":
    case "user_restrict":
    case "user_unrestrict":
      return returnedId(data.id) === command.userId;
    case "fan_notes_get":
      return typeof data.notes === "string";
    case "fan_notes_update":
    case "fan_notes_clear":
      return returnedId(data.id) === command.fanId;
  }
}
