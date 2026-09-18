# Sonnet 5 / 4.6 × low / high: protocol

Recorded before inspecting generated replies or receiving judgments, 2026-09-14.

## Fixed generation conditions

- Four cells: `anthropic:claude-sonnet-5` low/high and `anthropic:claude-sonnet-4-6` low/high.
- Variant B only: unchanged `candidate-v6-bounded.md`, SHA-256 `ed464a6e5f65eaa51598ee802c2820e47ad1ec750625dd4366348b011c25346b`.
- Same 22 cases per cell, two independent generations per case: 44 replies per cell, 176 total. All replies are retained, without best-of selection or automatic retries.
- Corpus: original 14 cases plus eight new holdouts authored by an independent agent that did not read the candidate prompts. The original Tomas capture and each case's persona remain intact; the raw Tomas persona differs from the synthetic persona only in the Fansly/OnlyFans platform word, normalized during assembly.
- Merged corpus: `private/sonnet-matrix-cases.json`, SHA-256 `64cccbb073ce37319d44eb89e0c38a74d8259c89a36aac5df750161f69fb5850`.
- Max output/thinking budget: 4096 tokens in every cell. Existing gateway maps effort to Anthropic adaptive thinking and `output_config.effort`. No manually added sampling parameter or persona rewrite.
- Four separate local gateway/Postgres runs, launched concurrently; direct Mac provider egress. Every request retains gateway capture and charged micro-USD evidence. No production configuration changes or fan messages.
- Complete `end_turn` output and exact provider-reported model are required for inclusion. Any stopped/incomplete run must be disclosed rather than silently dropping its difficult cases.

## Quality assessment

The owner's corrected criteria in `QUALITY-CRITERIA.md` override older fixture wording. Primary objective: plausible, engaging personal texting without repetitive manufactured enthusiasm, recap-plus-verdict, obligatory questions, forced slang, or a joke on every occasion. A good callback, ordinary invented personal detail, teasing, or a longer sincere answer can be excellent. Brevity and literal factuality are not automatic wins.

Primary style subset: `tomas`, `known-answer`, `ordinary-story`, `personal-message`, `conversation-rest`, `playful`, plus all eight `fresh-*` cases: 14 cases × 2 samples = 28 four-way panels. The remaining eight cases (16 panels) are functional controls. Report those separately so language/price/PPV compliance does not dominate the style ranking.

Two independent agent judges receive anonymous P/Q/R/S replies with a different random configuration mapping in every panel. They see the common persona, actual conversation, relevant auxiliary context, and the corrected rubric, but no model names, efforts, cost, latency, prompt candidates, or keys. Each ranks all four replies into ordered tiers, allowing any ties, and records usable replies and concrete material errors separately. These are agent judgments, not human preference measurements.

Aggregate ranks with pairwise credit: for every reply, one point per lower-ranked rival, half a point per tied rival, zero per higher-ranked rival. Divide by three rivals and the number of judgments to report relative preference percent. A four-way tie scores 50% for every cell. Also retain direct pairwise win/tie/loss, per-judge results, and fresh-holdout results; do not claim statistical significance or population superiority from 22 cases or treat repeated samples and judges as independent fans.

Each judge also sees the four output batches under a second anonymous mapping, consistent across cases but unrelated to panel labels. They identify repeated constructions across conversations, weak canned fallbacks, and excessive cleverness or dryness. Batch observations are a qualitative cross-check, not an extra numerical vote. Quote exact examples and their frequency only when verified in the saved results.

During judging, the owner challenged the parent's criticism of `you should go next week`. The parent withdrew that example as inherently defective and told both judges the same clarification: ordinary fitting encouragement is valid; identical answers to the same input are not by themselves slop, and every reply need not be novel. This is recorded as criterion 7 in `QUALITY-CRITERIA.md`. No model identities or comparative results were disclosed to either judge, and no generations were repeated.

## Operational measures and limitations

Report actual per-cell median latency, gateway-priced spend, completion/model verification, and any functional failures. Concurrent requests, cache sharing and provider variability mean this is not a controlled speed benchmark; spend is the measured cached run, not a production unit-cost forecast. Streaming thinking counters measure observed events/UTF-16 code units, not hidden reasoning or thinking tokens. A requested high effort does not itself prove the model performed more reasoning.

The result compares four configurations with v6 and this persona/context mix. It does not establish the best model on every prompt, prove that v6 beats production, evaluate full interactive conversations, or cover explicit content. Preserve disagreement and inspect concrete replies before recommending a next change.
