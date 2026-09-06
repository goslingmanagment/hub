# OFAPI send v2 and desktop commands

Decision 268. This batch adds closed versioned operations to the existing durable outbox. It does not send messages during migration, enable collectors, or add automatic retries.

`send_message_v2` accepts integer `priceCents` (0 or 300–20000), explicit `lockedText`, reply ID, giphy ID, attached media and preview IDs, release-form tag/partner/guest arrays and an optional vendor banned-word policy. Cents pass through the named mills codec. Large numeric IDs remain exact strings. `reuseProviderOperation` is an explicit recovery choice and is never transmitted in the vendor body.

Before dispatch, the executor fixes a provider operation ID/key, team/account/endpoint/body hash and first-attempt time. A new outbox row can reuse a parent's key only after explicit manual recovery, unchanged scope/body, verified team identity and within the original 24 hours. A child cannot extend that window. Single-use `ofapi_media_*` tokens belong to one logical operation; another send is refused before dispatch. Numeric reusable vault IDs are unaffected. Existing queued/in-flight and binding/auth fences remain authoritative. Neither timeout nor replay header by itself confirms delivery. Only a valid successful message response or an independently matching webhook can establish success.

The closed action list is custom name, message like/unlike and pin/unpin, chat unread/mute/unmute/hide. Each uses a single outbox attempt, assigned-page authorization and provider success evidence. A 422 retains its bounded validation response on the command for the desktop to explain; it never rewrites or automatically resends the draft. New send responses are captured before parsing with page/account attribution.

Banned Words is a versioned retained dictionary. The owner can explicitly refresh at most 1–30 pages of 100 entries. The response shows full versus partial traversal. GET/preview read locally for signed-in desktop clients; preview highlights literal case-insensitive occurrences, exposes vendor alternatives and never executes `regex_pattern`. The owner panel is on OFAPI Credits. No timer refreshes the dictionary. Its tariff is not documented as free: the UI bounds physical calls and the common ledger records actual response metadata; it does not promise a monetary ceiling from an unknown price.

## Validation

`tests/ofapi-command-composer.test.ts` covers exact cents and IDs, one physical request/key, replay ambiguity, capture-before-credit ordering, action paths and escaped dictionary matching. The DB integration suite covers one-attempt restart behavior, explicit same-key recovery, changed-body refusal, token custody races, original TTL and principal/page authorization. Typecheck and dashboard production build pass. Desktop adoption has its own accompanying PR; do not advertise composer fields until both are installed.

## Provider evidence and discrepancies

Live docs checked 2026-09-06:
- https://docs.onlyfansapi.com/api-reference/chat-messages/send-message
- https://docs.onlyfansapi.com/api-reference/banned-words/list-banned-words
- https://docs.onlyfansapi.com/api-reference/fans/set-fans-custom-name
- https://docs.onlyfansapi.com/api-reference/chat-messages/like-message
- https://docs.onlyfansapi.com/api-reference/chat-messages/pin-message
- https://docs.onlyfansapi.com/api-reference/chats/mute-chat-notifications
- https://docs.onlyfansapi.com/api-reference/chats/hide-chat

The send schema labels `rfTag`/`rfPartner`/`rfGuest` as strings while its field descriptions require arrays; the typed composer follows arrays. Pinned older send schema does not describe the complete recovery behavior; live documentation defines printable Idempotency-Key, scope/body matching and 24h cached response. Empty success, 409 in progress, validation mismatch or a replay flag without a message ID remain unconfirmed. Previews support additional provider index forms; this version intentionally exposes an exact subset of attached media IDs to prevent ambiguous mixed indexing.

## Rollout and spend

Apply the full release's migrations in numeric order before enabling consumers; independently prepared batch branches must not be deployed out of that order. No vendor calls or production changes were made for these tests. SDK must be regenerated from a clean commit and installed in desktop. Existing `ofapiDesktopCommandOutboxEnabled` / `ofapiDesktopCommandExecutionEnabled` control execution; owners still choose when to install the desktop consumer. Collector policy remains off for all new background reads. Send and action requests retain observed credit accounting; they are interactive commands and are not activated by collection controls.
