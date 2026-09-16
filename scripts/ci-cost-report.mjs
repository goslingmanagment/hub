// Read-only: reports completed runs without creating another billed workflow.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function summarizeRun(run, jobs) {
  const completed = jobs.filter(job => job.status === "completed");
  const minutes = job => {
    if (job.conclusion === "skipped" || !job.started_at || !job.completed_at) return 0;
    const duration = Date.parse(job.completed_at) - Date.parse(job.started_at);
    if (!Number.isFinite(duration)) throw new Error("Invalid job timestamps");
    return Math.ceil(Math.max(0, duration) / 60_000);
  };
  const used = completed.filter(job => job.conclusion !== "skipped");
  const staticJob = completed.find(job => job.name === "Static checks");
  const integrationRan = used.some(job => job.name.startsWith("Integration "));
  let mode = run.name === "Nightly" ? "nightly" : "other";
  if (run.name === "CI") {
    if (completed.some(job => job.name === "PR description edit (no gate)")) mode = "metadata-only";
    else if (integrationRan) mode = "full";
    else if (staticJob?.conclusion === "skipped" && run.conclusion === "success"
      && completed.some(job => job.name === "Quality Gate" && job.conclusion === "success")) mode = "gate-reused";
    else if (staticJob?.conclusion === "success") {
      mode = staticJob.steps?.some(step => step.name === "Typecheck" && step.conclusion === "skipped")
        ? "gate-reused-image" : "integration-reused";
    } else mode = "no-completed-heavy-checks";
  }
  return {
    id: run.id, url: run.html_url, event: run.event, conclusion: run.conclusion, mode,
    // Caller supplies latest-attempt jobs for mode and each attempt separately
    // for accounting; reruns must not silently disappear from the total.
    attempt: run.run_attempt ?? 1,
    runner_minutes: used.reduce((sum, job) => sum + minutes(job), 0),
    cancelled_minutes: used.filter(job => job.conclusion === "cancelled").reduce((sum, job) => sum + minutes(job), 0),
    by_job: used.map(job => ({ name: job.name, minutes: minutes(job), conclusion: job.conclusion })),
  };
}

export function summarizeAttempts(run, attemptJobs) {
  const seen = new Set();
  const attempts = attemptJobs.map((jobs, index) => {
    // Rerun-failed-jobs copies successful jobs into the next attempt with NEW
    // IDs but unchanged execution timestamps. They did not consume runners twice.
    const executed = jobs.filter(job => {
      const key = JSON.stringify([job.name, job.started_at, job.completed_at]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return summarizeRun({ ...run, run_attempt: index + 1 }, executed);
  });
  const latest = summarizeRun(run, attemptJobs.at(-1) ?? []);
  return { ...latest,
    runner_minutes: attempts.reduce((sum, item) => sum + item.runner_minutes, 0),
    cancelled_minutes: attempts.reduce((sum, item) => sum + item.cancelled_minutes, 0),
    attempts,
  };
}

function api(endpoint) {
  return JSON.parse(execFileSync("gh", ["api", endpoint], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }));
}

function listPages(endpoint, key) {
  const all = [];
  for (let page = 1; ; page++) {
    const result = api(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`)[key];
    all.push(...result);
    if (result.length < 100) return all;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let days = 7;
  let limit = 100;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") json = true;
    else if (args[i] === "--days") days = Number(args[++i]);
    else if (args[i] === "--limit") limit = Number(args[++i]);
    else throw new Error("Usage: pnpm ci:cost [--days 7] [--limit 100] [--json]");
  }
  if (!Number.isInteger(days) || days < 1 || days > 90 || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("days must be 1..90; limit must be 1..1000");
  }
  const repo = execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { encoding: "utf8" }).trim();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const candidates = [];
  let total = 0;
  for (let page = 1; candidates.length < limit; page++) {
    const data = api(`repos/${repo}/actions/runs?status=completed&created=${encodeURIComponent(`>=${since}`)}&per_page=100&page=${page}`);
    total = data.total_count;
    candidates.push(...data.workflow_runs);
    if (data.workflow_runs.length < 100) break;
  }
  const runs = [];
  for (const run of candidates.slice(0, limit)) {
    const attemptJobs = [];
    for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
      attemptJobs.push(listPages(`repos/${repo}/actions/runs/${run.id}/attempts/${attempt}/jobs`, "jobs"));
    }
    runs.push(summarizeAttempts(run, attemptJobs));
  }
  const report = { repo, since, sampled_runs: runs.length, matching_runs: total, truncated: total > runs.length,
    runner_minutes: runs.reduce((sum, run) => sum + run.runner_minutes, 0), runs };
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`# CI runner usage: ${repo}\n\nSince ${since}; ${runs.length}/${total} completed runs${report.truncated ? " (TRUNCATED: increase --limit)" : ""}.`);
    console.log("Estimate: each job rounded up to a minute; includes rerun attempts. Not a billing statement.\n");
    console.log("| Run | Event | Mode | Result | Attempts | Runner minutes | Cancelled minutes |\n|---|---|---|---|---:|---:|---:|");
    for (const run of runs) console.log(`| [${run.id}](${run.url}) | ${run.event} | ${run.mode} | ${run.conclusion} | ${run.attempt} | ${run.runner_minutes} | ${run.cancelled_minutes} |`);
    console.log(`\nTotal in sample: ${report.runner_minutes} runner-minutes.\n`);
  }
}
