# CI cost investigation — 2026-09-16

Why GitHub Actions was the whole metered bill, where each minute went, and
what was cut. Outcome: Decision 359 (#222, gate reuse by tree fingerprint,
typecheck once) and Decision 360 (#223, publish fix, nightly re-cut, PR
fail-fast, WIP pushes skip CI). The numbers quoted there come from here.

## What is in this folder

- `analysis.json` — the attribution: runs, jobs, minutes and cost estimates by
  job, event, conclusion, day; per-period medians; slowest steps; runs by cost.
- `analyze.py` — reproduces `analysis.json` from the raw REST responses.
- `evidence/` — what was looked at:
  - `billing-*-dom.txt` — accessibility-tree snapshots of the account's billing
    pages (overview, SKUs, per-repo, budgets, daily) on 2026-09-16 11:23 UTC.
  - `docs-only-head-commits.json`, `docs-only-between-runs.json` — the runs
    whose head commit, or whose delta since the previous run of the same PR,
    touched only prose.
  - `startup-failure-*` — the budget-block failure as GitHub showed it.
  - `main-protection.json`, `runners.json`, `cache-usage.json`,
    `metadata.json` — the repo's protection/runner/cache state at the time.
  - `ci.yml`, `nightly.yml`, `Dockerfile`, `package.json`, `vitest.config.ts`,
    `global-setup.ts` — the configuration as it was before the changes.

## What is NOT in this folder, and how to get it back

The raw REST dumps (`runs.json`, `runs-pages.json`, `jobs/*.json`,
`jobs-flat.json`, `artifacts.json`) and the two job logs were ~17 MB and are
left out. `analyze.py` needs them; regenerate with:

```
gh api "repos/goslingmanagment/core/actions/runs?created=>=2026-09-01&per_page=100" --paginate > evidence/runs-pages.json
# runs.json = the concatenated .workflow_runs[] of the pages;
# evidence/jobs/<run id>.json = gh api repos/goslingmanagment/core/actions/runs/<id>/jobs?per_page=100
python3 analyze.py
```

Job timestamps estimate occupied runner minutes; the invoice is the billing
page. Rate used: $0.006 per Linux minute (2026).
