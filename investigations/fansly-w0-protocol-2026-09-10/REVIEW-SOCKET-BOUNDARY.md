# Independent socket boundary review

Reviewed 2026-09-14T00:19:24.745150+00:00 against worktree HEAD `2fb440d6c2c05500df91729592043c9cce6b4dd6`; observed origin/main `478fca4220d3d07d61a9200d1860316e770cb4fe`. Scope: the uncommitted ESLint transport policy and its new regression suite, plus the approved constructor as the allowed source fixture. No application source changes, tests, provider requests, production reads or deployment performed by this reviewer.

## Verdict

No actionable findings in this scoped change. Validation remains pending: the 72 generated cases were inspected, not executed. This is a repository lint policy, not a security sandbox or runtime containment guarantee.

## Evidence and reasoning

- `eslint.config.mjs:4–22` extracts the existing money and undici selectors without changing their matching semantics. Every subsequent syntax override retains the money restriction, including egress and the two historical HTTP importers.
- The new block at lines 138–159 covers runtime and package TypeScript source, excluding only `services/egress`. A separate TypeScript import rule avoids overwriting the existing core import rule and its AI gateway/module overrides. The existing AI, jsonb and module rules retain their prior scope; this does not claim to repair any pre-existing limitations of those rules.
- Bare globals and aliases of `WebSocket` use the standard global-reference rule; literal property access and destructuring on `globalThis`, `global`, `window` and `self` use the standard restricted-property rule. Installed ESLint 10.6.0 statically confirms property extraction uses `getStaticPropertyName` and handles variable/assignment object patterns. Local `WebSocket` bindings remain legal.
- The TypeScript import rule rejects named aliases, namespace/default undici imports and value reexports, including in HTTP exception files. Installed typescript-eslint 8.63.0 delegates the value namespace/reexport checks to ESLint and recognizes type-only declarations. The existing core undici wall still governs ordinary HTTP aliases elsewhere. Existing inline `type` specifier behavior under that older syntax wall is unchanged.
- Named HTTP imports remain legal in `packages/shared/src/http-client.ts` and `packages/fansly/src/adapter.ts`; their current real imports use this form. Dynamic undici imports are deliberately no longer exempt there because they expose the full transport namespace. Literal `ws` and its subpath dynamic imports are separately covered. Egress retains its transport exemption without losing its money or core import restrictions.
- `tests/websocket-egress-boundary.test.ts` asserts the actual responsible rule ID, preventing unrelated unused-variable diagnostics from passing a rejection case. It covers four source contexts, thirteen prohibited forms per context, accepted type/local symbols, the real egress constructor, callers, the two HTTP exceptions, money/AI restrictions, the gateway exception, deep/sibling modules and the earlier undici wall. Inputs are local source strings, with no network, timers or external database dependency. The dashboard remains outside this existing server lint policy.

## Limits and separate publication work

The policy does not trace arbitrary runtime string construction, reflective access, global-object alias dataflow or malicious lint suppression. No claim of complete socket isolation follows from these syntactic checks. Full `pnpm check` and relevant existing integration validation remain the owner's publication gate. The W0 decision currently numbered 321 must be reconciled with main's performance decision; parent reserved W0 number 325 after 322–324. That separate documentation mutation was not made during this read-only review.

## Reviewed file fingerprints

| File | SHA-256 |
| --- | --- |
| `eslint.config.mjs` | `bdbf7669f551fa84ab1d2fb17d052937db96ee0a1dc7904b335e5396de99d09a` |
| `tests/websocket-egress-boundary.test.ts` | `59128b58c4ca37247748eb6d7f6adb530c2044ec5d7aae2583d1b02d84fb5989` |
| `apps/runtime/src/services/egress/fansly-probe-socket.ts` | `46a17c9c049c6ffb64b84b5a5aa67729195aeba54425c876f1a3c452ae08d021` |
