# OFAPI account actions

This batch adds 34 closed action definitions and their owner form fields: seven
banking/legal/tax reads, three payout operations, eight Saved for Later operations,
and sixteen account settings operations. The common action plane supplies owner
authorization, encrypted intent/response custody, binding checks, a single physical
attempt, credit settlement and retained receipts. These domain definitions do not
make HTTP calls themselves.

The implementation follows the owner's expanded scope after S12. No authenticated
provider calls, monetary operations, configuration changes or production activation
were used for development. Provider API spend: zero. No user-subscription operation
exists in this action family.

## Live contract check

Every operation's public `.md` documentation was fetched on 2026-09-06. Its embedded
OpenAPI request body and query definitions were compared with the repository's
pinned OpenAPI. `vendor-operations.json` records the 34 method/path/action mappings,
documentation URLs and SHA-256 hashes of the inspected live documents.

- The live automatic-messaging and automatic-posting examples both use 12 hours;
  the pinned examples use 24 and 48. Both sources allow exactly 6, 12, 24 and 48.
  The implementation accepts the documented enum and leaves scheduling with
  OnlyFans. [Messaging](https://docs.onlyfansapi.com/api-reference/saved-for-later-messages/enable-update-automatic-messaging),
  [posting](https://docs.onlyfansapi.com/api-reference/saved-for-later-posts/enable-update-automatic-posting).
- The blocked-countries schema omits nullable metadata although its live prose
  explicitly allows `null` to clear all countries. Both `null` and `[]` are accepted.
  Country and state lists replace the existing settings; omitted states mean `[]`
  under the documented default. The form describes the replacement.
  [Geoblocking](https://docs.onlyfansapi.com/api-reference/settings/update-blocked-countries).
- Welcome-message release-form fields are typed as strings by both schemas while
  their descriptions specify arrays. The adapter follows the descriptions and the
  existing Hub composer representation. It accepts stored vault and completed
  `ofapi_media_` IDs; binary uploads go through the existing upload workflow.
  The documented welcome price is whole USD, 0 or 3–200. The owner field uses USD,
  the Hub contract uses integer cents and shared money codecs construct the wire
  number. [Welcome message](https://docs.onlyfansapi.com/api-reference/settings/update-welcome-message).
- The social-button create example uses `Instagram`, contrary to the lowercase
  documented enum. Only enum values such as `instagram` are accepted. Reorder IDs
  are declared strings but shown as numbers; safe numeric IDs use numbers, larger
  IDs remain exact strings. Update supports the label only; it does not invent
  link/type update fields. [Create](https://docs.onlyfansapi.com/api-reference/settings/add-social-media-button),
  [reorder](https://docs.onlyfansapi.com/api-reference/settings/reorder-social-media-buttons),
  [update](https://docs.onlyfansapi.com/api-reference/settings/update-social-media-button).

## Operation semantics

- Profile writes preserve omitted fields. Explicit nullable values or the localized
  clear-field selection clear only the chosen fields. Set-and-clear conflicts are
  rejected. Avatar and header require completed OFAPI upload IDs.
- Subscription price accepts free or USD 4.99–200, using integer cents and shared
  codecs. The form shows the provider's three-price-changes-per-day constraint.
- Withdrawal takes the documented whole-USD amount. Its `new` request receipt does
  not mean funds have reached a bank. The form directs the owner to the existing
  balances/limits view and manual payout frequency before submission. Unknown or
  rejected receipts never become a confirmed withdrawal request.
- Automatic enable/update requires the requested interval in the response. Disable
  accepts the documented empty data array. Closing Hub or pausing collectors does
  not disable the provider's existing automatic schedule; use the explicit disable
  action. No local scheduler or automatic startup activation is introduced.
- Username availability is a POST read: `data.success=false` is a valid answer,
  unlike a false mutation acknowledgement. Social button updates verify the target
  ID and label; reorder verifies the returned order. Malformed/contradictory 2xx
  receipts remain unconfirmed and must not trigger an automatic repeat.

## Validation and rollout

`tests/ofapi-actions-account.test.ts` covers the consequential request and receipt
boundaries: closed scope and binding input, supported provider periods, partial or
contradictory receipts, USD conversion and range limits, profile omission/clearing,
geography replacement, paid welcome media/previews, username availability, exact
large IDs and social-button target/order verification. Every one of the 34 actions
has a Russian form definition. Shared engine integration and browser validation are
part of the parent batch's checks.

Local verification of this domain batch: focused Vitest 11/11 passed; `pnpm
typecheck` passed its existing 1,909-error strictness debt budget; dashboard
`tsc -b` passed; focused lint passed. The unrestricted raw `tsc --noEmit` reports
the repository's pre-existing strictness debt and is not the repository check gate.

Each owner action uses one estimated provider credit, with actual response charging
owned by the common plane. Cached reads may charge less; this is not a promise of
zero-cost reads. No polling collector is added. After the common plane and this
batch are deployed, the owner chooses an account and one action, reads current
settings where needed, reviews the prepared values and sends that one action.
Autosend/autopost enablement is an explicit provider configuration change. To stop
it later, submit its disable action; turning off Hub alone is insufficient.

Banking support remains read-only because the published family has seven read
operations. This batch does not invent writes for bank accounts, identity, DAC7 or
tax forms. User subscriptions and paid subscribe-to-user calls remain excluded at
the owner's request.
