-- Stage 14: explicit fee capture (target §3.5 door 4.8). Nullable, no
-- defaults, no rewrite; populated by the OFAPI writers going forward. The
-- shadow table carries the same trio so the webhook path flows fee/VAT/tax
-- through the projection into the truth ingest.
ALTER TABLE transactions
  ADD COLUMN platform_fee_mills bigint,
  ADD COLUMN vat_amount_mills   bigint,
  ADD COLUMN tax_amount_mills   bigint;

ALTER TABLE ofapi_spend_projection_events
  ADD COLUMN platform_fee_mills bigint,
  ADD COLUMN vat_amount_mills   bigint,
  ADD COLUMN tax_amount_mills   bigint;
