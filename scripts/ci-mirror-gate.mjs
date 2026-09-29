import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// GitHub resolves a required check against the NEWEST check suite for the head
// SHA. A metadata-only event (a description edit, or a label other than
// ci:full) starts a run on that same SHA, so the run must report a check named
// exactly this or the PR loses its gate (Decision 377).
export const GATE_CHECK_NAME = "Quality Gate";

// filter=all keeps older suites in the answer; the default (latest) can hide
// the passing run behind this run's own in-progress check.
export const CHECK_RUNS_QUERY = `check_name=${encodeURIComponent(GATE_CHECK_NAME)}&filter=all&per_page=100`;

/** The workflow run that produced a check run, read from the URLs GitHub returns. */
export function runIdOf(checkRun) {
  const url = checkRun?.html_url ?? checkRun?.details_url ?? "";
  return /\/actions\/runs\/(\d+)(?:[/?#]|$)/.exec(url)?.[1] ?? "";
}

// Mirrors an EARLIER verdict; it never produces one. A run of this workflow
// may only confirm what another run already recorded for the same head, so a
// red, pending, foreign or absent gate stays red here.
export function findEarlierGate({ repo, headSha, currentRunId, api }) {
  for (let page = 1; page <= 10; page += 1) {
    const checkRuns = api(`repos/${repo}/commits/${headSha}/check-runs?${CHECK_RUNS_QUERY}&page=${page}`)?.check_runs ?? [];
    for (const checkRun of checkRuns) {
      const runId = runIdOf(checkRun);
      if (checkRun?.name !== GATE_CHECK_NAME || checkRun?.app?.slug !== "github-actions") continue;
      if (checkRun?.status !== "completed" || checkRun?.conclusion !== "success") continue;
      if (runId === "" || runId === String(currentRunId)) continue;
      return { runId, url: checkRun.html_url ?? checkRun.details_url ?? "" };
    }
    if (checkRuns.length < 100) break;
  }
  return null;
}

// Every failure path throws: a lookup that cannot prove an earlier success —
// including an unavailable API — must leave the gate red.
export function mirrorEarlierGate(env, api) {
  if (env.IS_DRAFT === "true") throw new Error("Draft PR: mark ready for review to run checks.");
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? "")) throw new Error("Missing repository identity");
  if (!/^[0-9a-f]{40}$/.test(env.HEAD_SHA ?? "")) throw new Error("Missing pull request head SHA");
  const found = findEarlierGate({
    repo: env.GITHUB_REPOSITORY, headSha: env.HEAD_SHA, currentRunId: env.GITHUB_RUN_ID, api,
  });
  if (!found) {
    throw new Error(`No earlier successful "${GATE_CHECK_NAME}" for ${env.HEAD_SHA}: re-run the gate on this head.`);
  }
  return found;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const found = mirrorEarlierGate(process.env, endpoint => JSON.parse(execFileSync("gh", ["api", endpoint], {
      encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"],
    })));
    const line = `Quality Gate mirrors run ${found.runId} (${found.url}) — the same head ${process.env.HEAD_SHA} already passed.`;
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
