Fast Reply currently prescribes a reaction followed by a question, which encourages a repetitive conversational cadence. This candidate replaces that structure with contextual choices and six voice examples, including the owner-approved gentle tease and curiosity examples. The preferred emoji palette is optional, ordinary encouragement and small everyday fiction remain allowed, and unknown business terms must stay unknown.

The Fast Reply template change is global, including existing/custom personas. A separate `builtin:lora-soft` / **Lora Soft** v1 carries the revised persona voice. Original Lora content, version, default selection, and Sonnet 5 low remain unchanged. Existing create-only seeding can publish the new key; deploying source alone neither seeds it nor changes client/page mappings. No API, migration, startup seed, or owner-admin bypass is added.

This is a **draft quality candidate**, not a demonstrated fix for repetitive validation/elaboration. In 72 actual Sonnet 5 low generations, the combined candidate was preferred to the baseline in 5 fresh comparisons, lost 3, and tied 4. The unwanted pattern was present in 3/12 combined-candidate fresh replies versus 0/12 baseline replies; only 1/4 combined-candidate training replies was judged sendable. One control invented an unknown pricing rule. The approved examples are training references, not independent holdouts. No production deployment, persona seed, mapping, or fan message has been performed.

Validation:

- `pnpm check`: 334 unit files, 3,843 passed / 9 existing skips; lint and dashboard build passed. Typecheck ratchet passed with 1,897 known errors inside its existing budget.
- Complete `ai-feature-service.integration.test.ts`: 65 passed, including preservation of the existing stored persona, catalog publication and explicit selection of Lora Soft, plus unchanged fallback/model/effort.
- `pnpm build:production` and built startup capability smoke passed.
- Exact template/constant and manifest hashes, unchanged original Lora bytes, and all 72 evaluated system/user prompt texts verified. Current production DB persona bytes could not be read by the read-only role; baseline persona matches the retained source capture.
- Independent read-only review found no correctness issue. Private transcripts, provider captures and evaluation results are not committed.

Checks ran locally on Node 26.7.0 against base `6e07620ab5b98c20367c46483c07ff2b0ca47a00`. The branch was then rebased onto `78aa7d48a1071939cdd24c1037c5f5f98f8ecc91`, whose unrelated W0 change occupied Decision 340; this decision is renumbered to 341. Source/test patch parity is verified after the rebase; full suites were not repeated for the unrelated upstream change. Node 22 CI and a production Docker build are separate from these local results.
