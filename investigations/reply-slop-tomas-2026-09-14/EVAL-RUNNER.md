# Local Reply comparison

This opt-in runner compares the existing prompt (A), candidate template (B), and candidate plus one exact persona-line replacement (C). It defaults to `anthropic:claude-sonnet-5`; `--model` also accepts `anthropic:claude-sonnet-4-6`, `anthropic:claude-opus-4-8` and `anthropic:claude-opus-5` for diagnostics. Both Sonnet models use the existing gateway catalog without an import hook. Opus 5 requires the local catalog import hook shown below. Effort defaults to `low`. `--effort low|medium|high` supports a separate diagnostic comparison and is recorded in the plan, request, results and progress output. Default execution is a dry run: no provider call, no credential read and no database startup.

```sh
node --import tsx/esm investigations/reply-slop-tomas-2026-09-14/eval-runner.ts --cases investigations/reply-slop-tomas-2026-09-14/eval-cases.json --case-ids tomas,known-answer,stale-dossier --variants A,B,C --samples 2
```

For the Opus 5 diagnostic at high effort and 4,096 output/thinking tokens, start with this dry run:

```sh
node --import tsx/esm --import ./investigations/reply-slop-tomas-2026-09-14/opus5-catalog-hook.mjs investigations/reply-slop-tomas-2026-09-14/eval-runner.ts --model anthropic:claude-opus-5 --effort high --max-tokens 4096 --case-ids tomas --variants A,B,C --samples 1
```

The hook adds Opus 5 to an isolated copy of the gateway catalog for this Node process. It leaves runtime source/catalog files unchanged. Before assembling the plan, the runner requires the resolved `providerModelId` for both Sonnet models and Opus 5 to match the selected bare model ID exactly; mapping a label to another model is rejected. `plan.json` records `expectedProviderModelId`, the effective `resolvedModelPricing` object and its `resolvedModelPricingSha256`, including the provider model ID and all token/cache rates.

For a four-way Sonnet comparison, run the same cases, prompt files, variant, sample count and token cap in four separate invocations: Sonnet 5 low/high and Sonnet 4.6 low/high. For example, this prepares the Sonnet 4.6 high cell with the v6 candidate; the other cells change only `--model` and `--effort`:

```sh
node --import tsx/esm investigations/reply-slop-tomas-2026-09-14/eval-runner.ts --model anthropic:claude-sonnet-4-6 --effort high --max-tokens 4096 --candidate investigations/reply-slop-tomas-2026-09-14/candidate-v6-bounded.md --case-ids tomas --variants B --samples 2
```

If the comparison also uses v6 system guidance, pass the same `--system-prefix`/`--system-suffix` files and variant C for every cell. Check that each case's `promptSha256` matches across cells before a paid run. Separate invocations have separate budget counters.

Use the actual case ids from the fixture file. `--baseline` and `--candidate` accept Markdown paths; defaults are adjacent `baseline.md` and `candidate-v1.md`. A case JSON has `{ "cases": [{ "id": "tomas", "input": { ...PromptBuildInput } }] }`; every input must be `fast-reply` and supply its exact personality. Optional top-level `variants: {baseline, candidate}` paths resolve relative to the JSON. Optional `personaVariant: {from, to}` overrides the exact replacement for C. Dates in `fanProfile.generatedAt` are revived. The default C replacement is recorded in `plan.json` and fails if the source line does not occur exactly once.

For a separate system-guidance ablation, pass `--system-suffix <file>`. In variant C this **replaces** the persona-line patch: the exact original persona remains, and two newlines plus the file's verbatim text are appended to the final existing system block. No block or cache hint is added or removed. A and B are unchanged. The source path and hash are recorded in `plan.json`; C must be selected. This is local experimental assembly only, not a production builder change.

Add `--verify-storage` to exercise one selected prompt using a fake provider in a fresh local Postgres container. This makes no AI call and produces no quality sample. It proves normal gateway preparation, terminal consumption, ledger finalization, verbatim restricted capture, and evidence export. It does not run Vitest or share a test database.

Add `--run` only for an intentional paid comparison. The only credential read is `ANTHROPIC_API_KEY` from this repository's `.env`; it is never printed, exported, or saved. The runner does not load `.env.production` or use an environment database URL. A new Testcontainers Postgres 16 instance is created with synthetic local principal/page records. A non-loopback database host is rejected. The provider uses the existing Hub Anthropic adapter and direct Mac egress; this differs from the production page proxy. Gateway budgets, reservations, terminal folding, ledger writes, and restricted prompt/completion capture remain in the normal path. The fixture proxy is a local placeholder that the explicit direct resolver never uses.

Limits are two samples per case/variant, 84 total calls, 4,096 total output/thinking tokens per call, 200,000 serialized prompt bytes, a 60-second request timeout, and a $3 aggregate budget per invocation. Separate invocations do not share a budget counter; the operator must track their total. `--max-tokens` defaults to 2,048 and accepts 1..4,096; higher-effort diagnostics can explicitly request 4,096. `--samples` and `--max-calls` can lower their ceilings. Only these four catalog model IDs are accepted. SDK retries are explicitly disabled by forwarding `maxRetries: 0` through the existing gateway SDK adapter. A failed, cancelled, incomplete, or token-truncated request stops the run and is not scored as a usable quality sample.

The existing SDK wrapper observes `message_start.message.model` and `.id`, then yields each original stream event unchanged. Every result preserves `providerReportedModel` and `providerReportedResponseId` alongside its `clientRequestId`, with null values when absent. Paid Sonnet 5, Sonnet 4.6 and Opus 5 calls additionally require the reported model to equal `expectedProviderModelId`, taken from `resolveAnthropicGatewayModel`, for `qualityUsable`. There is no alias rewrite or model fallback. A missing or different model stops the run with `provider_model_unverified_no_retry` after retaining the result, ledger, restricted capture and accounted cost; there is no retry. `providerModelVerified` reports this comparison for all four models; Opus 4.8 retains its previous diagnostic-only verification behavior. A storage smoke cannot verify provider identity and never produces a quality sample.

Each result also records `thinkingDeltaEventCount` and `thinkingDeltaCharacterCount`. These count observed `content_block_delta` events with `delta.type === "thinking_delta"` and the sum of their string lengths in UTF-16 code units. No thinking text is retained by the wrapper. Zero means no such events/text were observed after entering the SDK wrapper; null means no SDK observation was available, including storage smoke. These values can qualify low/high comparisons but are neither exact thinking-token counts nor a measure of all internal reasoning; an interrupted stream can have partial counts. The gateway's existing usage and ledger accounting are unchanged.

Before every call, admission uses one token per serialized UTF-8 prompt byte plus 2,048 envelope tokens, prices all input at the highest 1h cache-write rate, prices the full output cap, and adds 25%. The next call is refused if that bound plus prior accounted usage exceeds $3. Missing/uncertain usage is charged at the full conservative bound for local admission. Costs use the effective gateway catalog recorded in the plan, including the local Opus 5 hook when selected; they are not vendor-invoice reconciliation. Variant ordering reverses on the second sample to reduce a fixed first-request/cache-order bias.

Artifacts default to gitignored `tmp/reply-eval/<mode>-<timestamp>-<id>`. A custom `--out` must also be inside this repository and gitignored. Files use mode 0600 and directories 0700. `plan.json` contains exact assembled prompts and hashes; each terminal gets a separate result file, `results.json` gets updated after every call, and `isolated-gateway-evidence.json` preserves generation/usage rows before the container is removed. These files contain private conversation content and must not be committed. No prompt or completion is printed to the terminal. All runs use local reconstruction through `buildPrompt`, so cache hints can differ from a previously captured production request even when transcript/persona text matches.

This probe tests prompt behavior and local gateway capture. It does not send a platform message, change production settings/personas, deploy code, prove full production transport parity, or estimate population-wide quality from a small case set.

## Further diagnostic switches

`--system-prefix <file>` with C replaces only the first existing system block and preserves the persona. It disables the default one-line persona patch. It may be combined with `--system-suffix`; the plan records each source path and SHA-256. This switch is for local prompt-stack diagnostics, not a change to production assembly.

Some experiments deliberately produce a JSON editorial object. The runner captures the raw output and does not pass it through the production Reply output normalizer; `qualityUsable` means the paid stream completed with `end_turn` and passed any required provider-model check. Such a diagnostic is not proof of client-format compatibility or a human quality judgment.
