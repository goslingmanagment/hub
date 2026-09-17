# Separate finding: transcript count can overstate exactness

Status: **statically derived; not reproduced with a test or production query**.
Source: exact commit `ac92197ba9760833ae035c3f5e8a90d084010fe6`.
This is outside the bounded missing-head diagnosis. No fix, test, wider audit or
migration gate change was performed.

The transcript count reuses a query builder capped below the count probe's
threshold. For **more than 1,500 matching deduplicated rows**, the source implies
an output of `{value:1500, exact:true}` even though more matches exist. Exactly
1,500 matching rows is not itself an incorrect exact count. The earlier shorthand
“>=1500 is wrong” is corrected by this explicit boundary.

Exact current source chain:

| Location at ac921 | Relevant expression |
|---|---|
| `packages/db/src/repositories/agent-transcript.ts:47` | `AGENT_TRANSCRIPT_UNION_MAX_ROWS = 1500` |
| Same file `:116` | `Math.min(input.limit, AGENT_TRANSCRIPT_UNION_MAX_ROWS)` |
| `apps/runtime/src/modules/agent-read/runtime.ts:51` | `AGENT_COUNT_PROBE_MAX = 5001` |
| `apps/runtime/src/modules/agent-read/handlers-threads.ts:839` | Passes that constant to `countAgentTranscript` |
| `packages/db/src/repositories/agent-transcript.ts:451` | Builder receives `limit: probeMax + 1`, i.e. 5002 |
| Same file `:452–456` | Counts the clamped subquery; reports inexact only when `value > probeMax` |

The query builder consequently restricts the count input to 1,500 rows. That
result cannot exceed 5,001, so the inexact branch is unreachable on this runtime
call path solely from hitting the builder's cap.

| Actual matching population | Statically implied result | Assessment |
|---|---|---|
| 0 | value 0, exact true | This finding does not invalidate zero |
| 1,500 | value 1,500, exact true | Exact count can be correct |
| More than 1,500 | value 1,500, exact true | Exactness is overstated; count is truncated |

“Matching” means the same deduplicated/filter-scoped transcript population as the
builder, not every raw source row. No observed production population above the
cap has been established here. The finding cannot turn nonempty matching input
into zero and is **not the cause of candidate-transcript.json's empty result**.
It supplies no evidence about target message ID 949097710298869762, provider
loss, A0 readiness, suppression, savings or latency.

Source SHA-256 pins:

- `agent-transcript.ts`: `b891009a63f4dc0e9570196c9be599ffffe834690e66d7c24540175f988dd87b`
- `handlers-threads.ts`: `1c64d95eb43b3de101c72e043f79353f5479d7574479ab049169a2725436b78e`
- `runtime.ts`: `48b99bad6f53cd0b8cba32813e52e295123d79f2aba17a63ae5245ff5371e393`

All lines and pins were read from git objects at the named commit. No source file
or completed observation artifact was edited.
