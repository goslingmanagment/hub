# OFAPI list, vault and moderation actions

Owner scope expansion on 2026-09-06 authorizes implementation of list and moderation operations. It explicitly excludes subscriptions to other users. This batch adds 20 closed action definitions and owner forms to the shared governed action lane. Production dispatch remains off until the owner enables that lane; creating this code performs no account changes.

## Included operations

| Hub action | Provider method and account-relative path | Result evidence |
|---|---|---|
| `user_list_create` | POST `/user-lists` | Returned list ID |
| `user_list_update` | PUT `/user-lists/{listId}` | Returned list ID |
| `user_list_delete` | DELETE `/user-lists/{listId}` | Acknowledgement |
| `user_list_add_users` | POST `/user-lists/{listId}/users` | Normal list-keyed ID map; with `skip_invalid`, exact added/failed map |
| `user_list_clear` | DELETE `/user-lists/{listId}/users` | Returned list ID |
| `user_list_remove_user` | DELETE `/user-lists/{listId}/users/{userId}` | Provider list and user-state acknowledgement |
| `user_list_pin_toggle` | POST `/user-lists/{listId}/users/{userId}/pin` | Acknowledgement of a toggle, not a desired-state setter |
| `vault_list_create` | POST `/media/vault/lists` | Returned list ID |
| `vault_list_update` | PUT `/media/vault/lists/{listId}` | Returned list ID |
| `vault_list_delete` | DELETE `/media/vault/lists/{listId}` | Acknowledgement |
| `vault_list_add_media` | POST `/media/vault/lists/{listId}/media` | Returned list ID |
| `vault_list_remove_media` | DELETE `/media/vault/lists/{listId}/media` | Returned list ID |
| `vault_media_delete` | DELETE `/media/vault/delete-media` | Acknowledgement |
| `user_block`, `user_unblock` | POST, DELETE `/users/{userId}/block` | Returned user ID |
| `user_restrict`, `user_unrestrict` | POST, DELETE `/users/{userId}/restrict` | Returned user ID |
| `fan_notes_get` | GET `/fans/{fanId}/notes` | Provider note |
| `fan_notes_update`, `fan_notes_clear` | PUT, DELETE `/fans/{fanId}/notes` | Returned fan ID |

All operations use the server-bound account, explicit page, strict request schema and exact provider verb. Resource identifiers are escaped path segments. Numeric user/media IDs remain decimal strings beyond the JavaScript safe-integer range. Default list aliases such as `friends` and `tagged` are supported.

## Spend and result rules

- Every ordinary operation reserves an estimate of 1 credit. `user_list_add_users` with explicitly selected `skip_invalid=true` reserves 5: one Hub request can trigger up to five billed internal provider attempts. Actual debit comes from response evidence.
- The Hub still dispatches once. No automatic retry is added, including for list toggles and destructive operations. An ambiguous outcome must be checked before a new deliberate action.
- Partial list results retain exact `data.added` IDs and `data.failed` keyed reasons. Missing/contradictory/unaccounted IDs must not become an all-added claim. List-level failures remain failures, not synthetic per-user results.
- Deleting a vault list, removing a member from that list and deleting the underlying vault media are three distinct actions. DELETE bodies retain the explicit media IDs.
- Native OF notes are an explicitly labelled provider resource. The action lane preserves the response separately and never invokes the local append-only note writer or infers bidirectional synchronization.
- Forms cover all 20 actions with named fields. Notes use a text field; there is no arbitrary JSON-body editor or path proxy.

The 1000-ID batch cap, 64-digit numeric-ID cap, 128-character list-ID cap and 16,000-character note cap are Hub admission limits, not claims of vendor limits. User-list names are capped at 64 and vault-list names at 255 characters, consistent with documented create/rename constraints. The update schema preserves explicit false/null feed-pinning values and omission; it does not rewrite notes or names.

## Vendor verification and discrepancies

All 20 live operation pages were read on 2026-09-06 via their public `.md` representations. [collection-sources.json](collection-sources.json) records each URL, SHA-256 of the retrieved document, method, path and body fields. Compared with `reference/onlyfansapi/openapi.yaml`, request contracts match after ignoring regenerated example strings. No method/path/body discrepancy was found for this batch.

Some provider examples are insufficient state evidence: the block-user example includes `isBlocked:false` despite its operation title. Returned objects are preserved without fabricating a confirmed moderation flag. The pin endpoint documents a bodyless toggle and cannot express “make pinned=true”; its UI name and action identity disclose that behavior.

References: [partial user-list add](https://docs.onlyfansapi.com/api-reference/user-list-collections/add-users-to-user-list), [pin toggle](https://docs.onlyfansapi.com/api-reference/user-list-collections/pin-unpin-user-in-user-list), [vault media deletion](https://docs.onlyfansapi.com/api-reference/media-vault/delete-vault-media), [native notes](https://docs.onlyfansapi.com/api-reference/fans/create-edit-fan-notes). Every other operation's direct source is in the evidence file.

## Validation and rollout

Domain regressions cover principal/binding-field rejection, explicit exclusion of subscribe/unsubscribe, ID precision and path rejection, partial-result routing and five-credit estimates, batch bounds, optional booleans, pin toggle semantics, DELETE payloads, moderation verb pairs and native-note separation. The integrator runs shared action-lane and database integration checks in addition to these domain tests.

Development made zero authenticated provider calls and spent zero OFAPI credits. This batch starts no background collector or automatic moderation. Review and merge the shared action engine first, then this domain batch; owner activation and any production mutation are separate rollout steps.

## Deliberate exclusions

`POST /users/{userId}/subscribe` is excluded by the owner's explicit instruction: it can purchase a subscription. Unsubscribe is also omitted because changing existing subscriptions was not requested. The `following` alias is rejected by user-list mutations so that the subscription-membership list is outside this command surface too. No action/schema/form or generic write escape hatch can invoke either subscription endpoint.
