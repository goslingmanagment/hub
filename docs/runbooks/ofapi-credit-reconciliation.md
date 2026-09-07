# OFAPI credit evidence and reconciliation

The ledger preserves what was known at each transition. A governed request first
settles its reserved estimate after capturing the response. Parsing then appends
one `certainty_adjustment` from provider metadata, even if the amount is unchanged:
a zero-credit correction proves the amount and retains the reported balance.
The original estimate is not rewritten. The attempt lock and existing entry-phase
uniqueness prevent replay from adding a second receipt or physical request.
Receipt time is the original `response_observed_at`; the existing monotone balance
guard prevents delayed parsing from replacing a newer balance observation.

Underlying spend reads use signed arithmetic: REST settlements plus their attributed
corrections. A cached request estimated at one credit and confirmed at zero costs
zero in the daily, operation, page, chatter and forecast views. Only REST rows
count as physical requests; certainty corrections do not. A correction arriving
in a window after its original request can make that window negative. Refills
remain outside spend. Zero-credit receipts carry balance evidence but cannot
extend the observed spending period used for the forecast denominator.

The chatter response adds optional `netRestCredits` and
`netTotalEstimatedCredits` for exact signed window facts. Installed desktop SDKs
require nonnegative legacy fields: `restCredits = max(0, netRestCredits)` and
`totalEstimatedCredits = restCredits + webhook.estimatedCredits` preserve that
compatibility and the legacy component sum. The signed total is
`netRestCredits + webhook.estimatedCredits`. For REST −10 and webhook estimate 5,
legacy fields are 0/5 and signed fields are −10/−5. Cached 1→0 requests still
show zero in both field pairs. These compatibility floors do not alter ledger,
owner reports or forecasts. Existing desktop clients accept the response but show
the floored estimate for negative periods until their SDK and renderer adopt the
optional signed fields; that client upgrade is separate from this server patch.

Reconciliation computes the residual between reported balances after known costs.
`external` does not prove an external actor or a payment, and `refill` does not
prove a deposit receipt. The raw ledger and daily all-source totals retain those
rows. The UI labels them as balance reconciliation or balance growth.

The runway and refill recommendation use net recorded activity: REST, corrections
and estimated webhook accruals. Unexplained balance residuals are exposed with the
forecast lookback window and separately for the calendar month; they are excluded
from the recurring spending rate. When a residual exists the dashboard warns that
actual costs can exceed this forecast and requires checking the difference.
Monthly recorded activity plus the separately reported monthly residual gives
the previous all-source monthly movement. The conservative all-source burn
monitor, real balance, admission floors and reservation ceilings are unchanged;
the monitor is distinct from the activity-based forecast.

A fresh balance does not mean reconciliation has run. The balance probe records
an observation immediately; the hourly reconciliation runs at `:05` UTC. A top-up
after that run will only appear among inferred increases after a later pass.
Check the latest observation and `reconciliation.lastRunAt` before claiming a
missing deposit. Investigate a large residual against the actual provider team,
key history and provider receipts; do not rewrite the ledger from an inference.

This change does not backfill historical equal-cost receipts or completed capture
counters. Retained raw observations and terminal facts remain authoritative for
those historical investigations; no provider recapture is needed to read them.
