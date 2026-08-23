-- WP-F7 — `page_payout_methods` and `page_payout_requests`: the money-out head.
--
-- ── THE CREDENTIAL RULE, AND WHY IT IS A COLUMN CONSTRAINT ───────────────────
--
-- `/payments/payoutmethods` serves `metadata` as a JSON-ENCODED STRING, and the
-- two live providers behave differently in the one way that matters:
--
--   providerId 2  (Paxum — NOT PayPal; A22-4 corrected the spec)
--                 decodes to `{email}` and the server returns the FULL address.
--   providerId 30 (USDT)
--                 decodes to `field0…field10` where `field1` is ALREADY
--                 server-masked (38 `X` plus four visible characters).
--
-- One provider hands us a plaintext identifier and the other does not, so the
-- masking has to be OURS. `masked_label` is the ONLY thing derived from
-- `metadata` that ever reaches a projection; the full processor payload stays
-- in the raw journal under the restricted class (DP 7 keeps it 100 years, and
-- neither payout kind is on `AGENT_OBSERVATION_PAYLOAD_ALLOWLIST`, so the agent
-- read plane can never serve it).
--
-- The CHECK below is that rule made mechanical rather than promised: a
-- `masked_label` that contains an `@` MUST match `^.\*\*\*@` — one leading
-- character, three asterisks, then the domain. A full address cannot satisfy
-- it, so a canonicalizer regression that let one through fails at the INSERT
-- rather than at a code review. An unknown provider decodes to NOTHING and
-- lands with `masked_label` NULL and `provider_label` `unmapped:<id>`.
--
-- ── THE STATUS MAP IS ONE CODE DEEP ─────────────────────────────────────────
--
-- All 83 payout requests on the walked page carried `status = 8`, whose UI
-- label is `Processed`. Every other payout status is unknown. So the integer
-- and the label are projected TOGETHER with `status_confidence`, and code 8 is
-- never treated as "the success code" in any conditional. An unknown code lands
-- `unmapped:<code>` / `unmapped` and the capture handler raises one anomaly the
-- first time it sees it.
--
-- ── MONEY ───────────────────────────────────────────────────────────────────
--
-- `amount` is ALREADY MILLS on the wire — the same unit the kernel uses (proved
-- against the rendered UI on seven independent fields). BIGINT mills through
-- the `packages/shared` constructors, no scaling anywhere.
--
-- ── NO FAN REFS ─────────────────────────────────────────────────────────────
--
-- Both tables are page-scope: these are the CREATOR's own payouts, not a fan's
-- purchases. `method_ref` and `payout_ref` are the platform's own ids for the
-- page's own rows, so no column here is fan-ref-shaped and the §9.3 erasure
-- column ratchet has nothing to bind to. That is a property of the data, not an
-- exemption.
--
-- `missing_since` IS HOW A RETIRED PAYOUT METHOD IS RECORDED (DP 7). A later
-- FULL listing that stops naming a method marks it; nothing here is ever
-- deleted on a schedule.
--
-- There is NO `page_wallet_snapshots` table (A28-8): `/account/wallets/earnings`
-- is already `getEarningsOverview`, and this package adds no wallet-balance
-- route.

CREATE TABLE "page_payout_methods" (
  "page_id"                 bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"                text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "method_ref"              text NOT NULL,
  -- The platform's provider code, RAW. NULL when the served value was not an
  -- integer — the label still says what was served.
  "provider_id"             integer,
  -- DERIVED at parse time from `provider_id` alone, never from `metadata`:
  -- `paxum` (2), `usdt` (30), `unmapped:<id>` for anything else.
  "provider_label"          text NOT NULL,
  -- Observed live as 1 / 0 / 3. No UI label was rendered for any of them, so
  -- they stay RAW INTEGERS and are never given invented names.
  "type"                    integer,
  "flags"                   integer,
  "status"                  integer,
  -- OURS, never the provider's. See the credential rule above.
  "masked_label"            text,
  -- FALSE when `metadata` was a string that did not parse as JSON. The row is
  -- still written — an unreadable method and an absent one are different facts.
  "metadata_parse_ok"       boolean NOT NULL DEFAULT true,
  -- Set when a later FULL listing stops naming this method. NEVER a delete.
  "missing_since"           timestamp with time zone,
  "first_observed_at"       timestamp with time zone NOT NULL,
  "last_observed_at"        timestamp with time zone NOT NULL,
  "content_hash"            char(64) NOT NULL,
  "source_event_id"         bigint NOT NULL,
  "source_observation_id"   bigint NOT NULL,
  "source_account_seq"      bigint NOT NULL,
  "created_at"              timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"              timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "page_payout_methods_pkey" PRIMARY KEY ("page_id", "method_ref"),
  CONSTRAINT "page_payout_methods_refs_check" CHECK (
    length("method_ref") > 0 AND length("provider_label") > 0
  ),
  -- THE CREDENTIAL RULE, ENFORCED BY THE DATABASE. A label carrying an `@` must
  -- be the pinned mask and nothing else.
  CONSTRAINT "page_payout_methods_masked_label_check" CHECK (
    "masked_label" IS NULL
    OR position('@' in "masked_label") = 0
    OR "masked_label" ~ '^.\*\*\*@[^@]+$'
  ),
  CONSTRAINT "page_payout_methods_content_hash_check"
    CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "page_payout_methods_source_account_seq_check" CHECK ("source_account_seq" > 0),
  CONSTRAINT "page_payout_methods_observed_order_check"
    CHECK ("last_observed_at" >= "first_observed_at")
);

CREATE TABLE "page_payout_requests" (
  "page_id"                 bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "platform"                text NOT NULL REFERENCES "platforms"("key") ON DELETE RESTRICT,
  "payout_ref"              text NOT NULL,
  -- MILLS. The wire unit IS mills; there is no scaling anywhere in this lane.
  "amount_mills"            bigint,
  -- `payoutMethodId` — joins `page_payout_methods.method_ref` by value. NO
  -- foreign key: a payout can name a method the creator has since removed, and
  -- an FK would make the honest history unstorable.
  "method_ref"              text,
  -- RAW, always. 8 is the only code ever observed.
  "status_code"             integer,
  -- `Processed` for 8, `unmapped:<code>` for everything else.
  "status_label"            text,
  -- `mapped` | `unmapped`. The map is ONE code deep and says so.
  "status_confidence"       text NOT NULL,
  -- The provider's own instants (Unix ms on the wire).
  "requested_at"            timestamp with time zone,
  "updated_at_platform"     timestamp with time zone,
  "version"                 integer,
  "first_observed_at"       timestamp with time zone NOT NULL,
  "last_observed_at"        timestamp with time zone NOT NULL,
  "content_hash"            char(64) NOT NULL,
  "source_event_id"         bigint NOT NULL,
  "source_observation_id"   bigint NOT NULL,
  "source_account_seq"      bigint NOT NULL,
  "created_at"              timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"              timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "page_payout_requests_pkey" PRIMARY KEY ("page_id", "payout_ref"),
  CONSTRAINT "page_payout_requests_refs_check" CHECK (
    length("payout_ref") > 0 AND ("method_ref" IS NULL OR length("method_ref") > 0)
  ),
  CONSTRAINT "page_payout_requests_amount_check"
    CHECK ("amount_mills" IS NULL OR "amount_mills" >= 0),
  CONSTRAINT "page_payout_requests_status_confidence_check"
    CHECK ("status_confidence" IN ('mapped', 'unmapped')),
  CONSTRAINT "page_payout_requests_content_hash_check"
    CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "page_payout_requests_source_account_seq_check" CHECK ("source_account_seq" > 0),
  CONSTRAINT "page_payout_requests_observed_order_check"
    CHECK ("last_observed_at" >= "first_observed_at")
);

-- "the page's payout history, newest first" — the only read this table has.
CREATE INDEX "page_payout_requests_page_requested_idx"
  ON "page_payout_requests" ("page_id", "requested_at" DESC);
