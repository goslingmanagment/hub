-- 0081: W7.3 (A21+B4, decision #132) — negation-guard suppression reasons.
--
-- 'superseded_duplicate_negation': a :chargeback and a :reversal both negate
-- the same original — the later-arriving twin is written/kept INACTIVE so the
-- pair can never double-subtract the same payment.
-- 'reversal_without_settled_original': a negative row whose original never
-- settled (no active posted row under the base id) — kept inactive until a
-- late original arrives (the explicit fixup path reactivates it).
--
-- ADD VALUE inside the runner's per-file transaction is safe on PG 16: the
-- new value only can't be USED in the same transaction, and this file never
-- uses it.
ALTER TYPE transaction_inactive_reason ADD VALUE 'superseded_duplicate_negation';
ALTER TYPE transaction_inactive_reason ADD VALUE 'reversal_without_settled_original';
