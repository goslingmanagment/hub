# Lease loss stops new physical read attempts

Author worktree: `/Users/dmitriy/code/goose/.worktrees/hub-perf-lease_cancel-20260912`

Base: deployed `31b73a9691f32f8c33c3fe479bca68533c7048d6`. No commits, production calls or database/test suites were run by the author. The coordinator owns serialized runtime verification and independent review.

## Cause and scope

`executeNextSyncPageChunk` previously recorded a false/failed lease heartbeat only in local `leaseFenced`. It checked that flag after `executeStreamChunk` completed. A logical Fansly/legacy OFAPI read already awaiting rate admission or retry delay had no access to the flag, so `executeObservedRequest` could start later physical attempts after ownership was known lost. Ordinary database lease fencing protected business application; it did not prevent those extra network calls. This is a pre-existing conditional defect, not a regression newly introduced by the performance commit.

The fix gates new read attempts after **observed** lease loss. The existing 30-second heartbeat cadence and database ownership predicates are unchanged. It does not claim immediate cancellation from the instant an operator pauses a stream, nor does it abort already-dispatched response reception.

## Implementation

- The page executor creates one `AbortController` per chunk and aborts with the existing `PageSyncLeaseLostError` on a false heartbeat or heartbeat persistence error.
- A shared `AsyncLocalStorage<AbortSignal>` scope is opened only around `executeStreamChunk`. Nested adapter/hydration/lane contexts inherit it through their async chain. Other chunks and unscoped API/command execution have independent context. `run` restores the caller's scope when control returns; admission listeners are removed on both success and abort.
- `executeObservedRequest` checks before/after rate admission and again after asynchronous `started` telemetry. Admission and retry delays terminate on cancellation. A cancellation before `execute` becomes a local `policy` terminal event when an attempt was already admitted; it is never handed to the transport retry classifier.
- An already-started `execute` and `onResponse` finish normally. The adapter sees zero remaining retries if the signal was aborted while the response was in flight, so a successful response still reaches the existing capture path while a failed response cannot open another retry. The executor keeps its existing lease-lost result and business completion fencing.
- The DB rate limiter checks around profile/reservation awaits and uses an interruptible timer. A custom non-cancellable admission promise may drain its existing work, but cannot dispatch an HTTP attempt. Already reserved pacing slots are not rolled back or reused.
- Fansly's in-memory fallback also cancels its waits. A cancelled chain node remains linked until its predecessor settles; otherwise a third request could accidentally bypass the predecessor's pacing slot. This ordering case has a dedicated adapter test.
- Legacy OFAPI observed reads check after awaited account/collection hooks and before fetch. When collection admission succeeded but cancellation prevents dispatch, the existing `onCollectionCancelled` hook releases that exact unused collection reservation. Governed one-attempt transport, outbox dispatch, transport timeout signals and write retry policies are untouched.

The shared package does not depend on the DB package. The typed lease-loss reason flows from the runtime into the shared scope; shared code needs no knowledge of page/stream identifiers. Explicit signal fields in approximately twenty independently built request contexts were rejected because a nested/new context could omit the fence. Existing page-sync observation and transaction context already uses per-execution async-local scoping.

## Prepared verification

`tests/http-request-cancellation.test.ts`:

- Pre-cancelled scope performs no rate admission, telemetry or execute.
- Cancellation during a deferred rate reservation returns before that reservation finishes and never executes later.
- HTTP and transport retry sleeps cancel without a second execute.
- Cancellation during asynchronous attempt telemetry prevents execute and produces local policy failure, not a transport retry.
- A complete response arriving after cancellation still passes through `onResponse` and returns capture material.
- Overlapping cancelled/active page scopes plus an unrelated unscoped request remain isolated.
- Completed admission listeners are removed; nested scope restores outer scope and the caller ends unscoped.

`tests/adapter-request-cancellation.test.ts` uses real adapter/client code with mocked physical transport:

- Fansly retry classification/observer cancellation results in exactly one fetch.
- A Fansly response already in flight still returns; its existing timeout signal is not aborted by lease cancellation.
- Cancelling a queued fallback waiter preserves predecessor/successor pacing order.
- Cancellation during either OFAPI pre-fetch hook performs zero fetches and releases only an actually acquired unused collection reservation.

`tests/sync-executor.test.ts` adds four combinations of rate/retry wait and heartbeat false/error, plus received-response capture after heartbeat loss. They execute the real shared request loop through the real executor (handler boundary is controlled) and assert no business completion, durable retry or failure capture after lease loss.

`tests/sync-rate-limiter.test.ts` pins that profile initialization completing after lease loss cannot reserve a new rate slot.

Coordinator command requested:

```sh
pnpm exec vitest run tests/http-request-cancellation.test.ts tests/adapter-request-cancellation.test.ts tests/sync-executor.test.ts tests/sync-rate-limiter.test.ts tests/adapter-fansly-global-delay.test.ts tests/adapter-fansly-followers-delay.test.ts tests/ofapi-command-executor.test.ts --maxWorkers=1 --no-file-parallelism
```

Broader relevant checks: existing Fansly retry/transport suites, OFAPI governed/collection-refusal suites, full unit suite and page-sync lease-fencing integration fixture. No new network route or schema is introduced.

Author checks completed:

- `pnpm install --offline --frozen-lockfile` — pass, lockfile unchanged.
- ESLint on all eleven touched TypeScript files — pass. OFAPI/client test lint repeated after adding unused-reservation cleanup — pass.
- `git diff --check` — pass.
- New files registered with explicit `git add -N` for patch visibility.

Runtime results are pending the coordinator's serialized test run. Do not treat prepared fixtures as executed evidence. The independent reviewer should specifically inspect async-local isolation, started/policy accounting, fallback chain cleanup, OFAPI reservation cleanup, and capture-after-loss behavior.

## Proposed decision entry

Page-sync lease loss terminates admission to new observed read attempts. A false or failed lease heartbeat aborts a per-chunk async-local request scope with `PageSyncLeaseLostError`; rate admission, retry delay and each physical dispatch boundary honor it. The signal is not passed to in-flight transport, and response handling/capture remains allowed before existing database lease fencing rejects business completion. The shared request loop does not classify this control outcome as a transport retry. Unscoped callers and governed one-attempt/outbox execution retain their current behavior. Cancelled pacing reservations are not reclaimed; a known unused OFAPI collection admission is released through its existing cancellation hook. Async-local scoping is chosen to cover nested lane and hydration contexts without introducing a process-global cancellation flag or a second ownership query per HTTP attempt.

## Rollback

Code-only revert, no schema/config change. Reverting restores the previous bounded but unnecessary post-fence retry behavior; it does not repair or delete any business facts. No new deployment flag is required.
