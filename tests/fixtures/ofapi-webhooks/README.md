# OFAPI webhook fixtures

Copied 2026-06-11 from the ChatGoose desktop repo (`chatgoose_desktop_fable
tests/fixtures/webhooks/`, the primary brief for this receiver). Captured live
during its Phase-0 webhook spike (2026-06-10), then anonymized — structure
preserved exactly; names/usernames/texts/ids/avatar URLs replaced with stable
fakes (cross-references between events stay consistent).

## Delivery contract (live-verified)

- Envelope: `{event, account_id, payload}` — there is **no event-id field in the body**.
- **Dedupe key:** `x-ofapi-idempotency-key` header, format `evt_<40 hex>`. At-least-once
  delivery, up to 5 retries, 15 s response timeout.
- **Signature:** `signature` header = hex `HMAC-SHA256(rawJsonBody, signing_secret)`.
  Verify against the *raw* request bytes — re-serializing the JSON breaks the MAC.
- User-agent: `OnlyFansAPI.com/Webhook-Client`. Content-Type: `application/json`.

`unverified_*.json` are documented example payloads from docs.onlyfansapi.com for
event types that did not fire during the capture window; everything else is
live-captured. `_meta` on each fixture is capture provenance, not wire format.

Used by `tests/ofapi-event-mapping.test.ts` and the `tests/ofapi-*.integration.test.ts`
suites (signed with a test secret and replayed through the receiver end-to-end).
