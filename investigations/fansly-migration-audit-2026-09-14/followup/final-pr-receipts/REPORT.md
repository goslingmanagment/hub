# Final merged PR and CI receipts

All 12 PRs are merged into `4e18d130ea6ca4b834141789265cce8442f8fcae`. Its actual tree is exactly
the independently reviewed `372b84f04df46c3cb607d5d5eef9c8a7c401bb62`.
Final PR 189 merged at **2026-09-14T02:14:22Z**; the Git commit timestamp is
`2026-09-14T05:14:21+03:00`. Evidence was collected at
`2026-09-14T02:16:07.651322+00:00` and completed at `2026-09-14T02:17:27.639260+00:00`.

Every final PR head has successful Static checks, Integration 1/3, Integration
2/3, Integration 3/3 and Quality Gate: **60 successful required check results**.
Workflow run metadata independently matches each PR head, records the
`pull_request` event and a successful completed run. Required checks finished
before merge, and every merge commit is an ancestor of the final main.

| PR | Final head | Merged UTC | Required checks | CI run |
| --- | --- | --- | --- | --- |
| [183](https://github.com/goslingmanagment/core/pull/183) | `01b4da17cf5a` | 2026-09-14T00:03:47Z | 5/5 success | [34790913188](https://github.com/goslingmanagment/core/actions/runs/34790913188) |
| [166](https://github.com/goslingmanagment/core/pull/166) | `37033f41d665` | 2026-09-14T00:29:23Z | 5/5 success | [34791202547](https://github.com/goslingmanagment/core/actions/runs/34791202547) |
| [184](https://github.com/goslingmanagment/core/pull/184) | `24870afc8969` | 2026-09-14T00:32:19Z | 5/5 success | [34792105475](https://github.com/goslingmanagment/core/actions/runs/34792105475) |
| [185](https://github.com/goslingmanagment/core/pull/185) | `e86a103f1a4e` | 2026-09-14T01:14:53Z | 5/5 success | [34794579193](https://github.com/goslingmanagment/core/actions/runs/34794579193) |
| [186](https://github.com/goslingmanagment/core/pull/186) | `07ac5312e1e2` | 2026-09-14T00:57:26Z | 5/5 success | [34793496015](https://github.com/goslingmanagment/core/actions/runs/34793496015) |
| [187](https://github.com/goslingmanagment/core/pull/187) | `8ef70afac9a8` | 2026-09-14T01:20:18Z | 5/5 success | [34794929318](https://github.com/goslingmanagment/core/actions/runs/34794929318) |
| [188](https://github.com/goslingmanagment/core/pull/188) | `ef8d56709227` | 2026-09-14T01:39:36Z | 5/5 success | [34795884817](https://github.com/goslingmanagment/core/actions/runs/34795884817) |
| [191](https://github.com/goslingmanagment/core/pull/191) | `d5cda4dd6481` | 2026-09-14T01:41:38Z | 5/5 success | [34796034057](https://github.com/goslingmanagment/core/actions/runs/34796034057) |
| [167](https://github.com/goslingmanagment/core/pull/167) | `82fb96381118` | 2026-09-14T01:59:29Z | 5/5 success | [34796987511](https://github.com/goslingmanagment/core/actions/runs/34796987511) |
| [190](https://github.com/goslingmanagment/core/pull/190) | `e87eab760f60` | 2026-09-14T01:55:46Z | 5/5 success | [34796911574](https://github.com/goslingmanagment/core/actions/runs/34796911574) |
| [189](https://github.com/goslingmanagment/core/pull/189) | `812834bc8299` | 2026-09-14T02:14:22Z | 5/5 success | [34797753642](https://github.com/goslingmanagment/core/actions/runs/34797753642) |
| [192](https://github.com/goslingmanagment/core/pull/192) | `b6349638d2f5` | 2026-09-14T02:01:25Z | 5/5 success | [34797149642](https://github.com/goslingmanagment/core/actions/runs/34797149642) |

All 12 `Publish checked production image` jobs were **skipped in the PR CI**.
These receipts do not establish publication of a main-branch image or any
deployment. Main push workflows, runtime health and production rollout are
separate evidence. No tests or production calls were performed here.

`main.json` retains the fetched commit/tree comparison; `pr-*.json` retains
the GitHub PR check rollups; `run-*.json` pins their head/event/status.
`summary.json` records per-check outcomes and verified main ancestry.
`SHA256.json` hashes every retained file except the manifest itself.
The local checkout head and branch were unchanged; only the explicitly
requested `git fetch origin main` updated remote-tracking Git state.
