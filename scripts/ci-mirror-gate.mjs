import { appendFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { githubApi } from "./ci-github-api.mjs";

// GitHub resolves a required check against the NEWEST check suite for the head
// SHA. A metadata-only event (a description edit, or a label other than
// ci:full) starts a run on that same SHA, so the run must report a check named
// exactly this or the PR loses its gate (Decision 377).
export const GATE_CHECK_NAME = "Quality Gate";

// A real run executes the fingerprint job; a metadata-only run skips it (its
// `if:` is the inverse of METADATA_ONLY). That is how a mirror tells another
// mirror's gate, a copy or a failed lookup, from a verdict.
export const FINGERPRINT_CHECK_NAME = "Gate fingerprint";
export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";

// filter=all keeps older suites in the answer; the default (latest) can hide
// the earlier runs behind this run's own in-progress check.
export const CHECK_RUNS_QUERY = "filter=all&per_page=100";

// The last 100 PR runs took at most 17 min (01.10.2026). The job's
// timeout-minutes covers this wait plus checkout and a last poll.
export const MIRROR_WAIT_MS = 35 * 60_000;
export const MIRROR_POLL_MS = 30_000;

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/** The workflow run that produced a check run, read from the URLs GitHub returns. */
export function runIdOf(checkRun) {
  const url = checkRun?.html_url ?? checkRun?.details_url ?? "";
  return /\/actions\/runs\/(\d+)(?:[/?#]|$)/.exec(url)?.[1] ?? "";
}

// A list cut short could hide the newest gate, so a head too busy to read in
// full is an error, not a partial answer.
async function readAll(api, endpoint, key, what) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = (await api(`${endpoint}&page=${page}`))?.[key] ?? [];
    items.push(...batch);
    if (batch.length < PAGE_SIZE) return items;
  }
  throw new Error(`This head has more than ${MAX_PAGES * PAGE_SIZE} ${what}; the mirror cannot read them all.`);
}

// One look at the head: the real runs of this workflow still working on it,
// and the newest gate a real run finished. This run and other metadata-only
// runs are left out.
//
// The gate job's check run is created only when the jobs it needs finish, so
// a run still in its static or integration jobs has no gate yet: the workflow
// run list, not the gate list, says whether a verdict is still coming.
//
// "Newest" is the highest check-run id. GitHub assigns ids in creation order,
// and a gate's check run is created when its run reaches the verdict, so the
// id orders verdicts and covers re-run attempts (same run id, new check run).
// started_at is when a runner picked the job up: a gate queued behind a busy
// runner can start after a newer run's gate, and it ties at one-second steps.
export async function readHead({ repo, headSha, currentRunId, api }) {
  const current = String(currentRunId);
  const runs = await readAll(api, `repos/${repo}/actions/runs?head_sha=${headSha}&per_page=${PAGE_SIZE}`, "workflow_runs", "workflow runs");
  const checkRuns = (await readAll(api, `repos/${repo}/commits/${headSha}/check-runs?${CHECK_RUNS_QUERY}`, "check_runs", "check runs"))
    .filter(checkRun => checkRun?.app?.slug === "github-actions" && runIdOf(checkRun) !== "" && runIdOf(checkRun) !== current);
  const fingerprints = checkRuns.filter(checkRun => checkRun.name === FINGERPRINT_CHECK_NAME);
  const mirrors = new Set(fingerprints.map(runIdOf).filter(runId =>
    fingerprints.every(checkRun => runIdOf(checkRun) !== runId || checkRun.conclusion === "skipped")));
  const gates = checkRuns.filter(checkRun => checkRun.name === GATE_CHECK_NAME && !mirrors.has(runIdOf(checkRun)));
  const working = new Set([
    ...runs.filter(run => run?.path === CI_WORKFLOW_PATH && run?.status !== "completed").map(run => String(run.id)),
    ...gates.filter(checkRun => checkRun.status !== "completed").map(runIdOf),
  ]);
  working.delete(current);
  for (const runId of mirrors) working.delete(runId);
  let newest = null;
  for (const checkRun of gates) {
    if (!Number.isSafeInteger(checkRun.id)) throw new Error(`Unreadable "${GATE_CHECK_NAME}" check run on ${headSha}.`);
    if (checkRun.status === "completed" && (newest === null || checkRun.id > newest.id)) newest = checkRun;
  }
  return { working: [...working], newest };
}

// Mirrors an EARLIER verdict; it never produces one. A run of this workflow
// may only repeat the newest verdict another real run recorded for the same
// head: a newer red gate beats an older green one, a run still working on the
// head is waited for (up to waitMs), and a missing gate stays red.
//
// Every failure path throws: a lookup that cannot prove the newest gate on
// this head passed, including an unavailable API or a wait that runs out,
// must leave the gate red.
export async function mirrorEarlierGate(env, api, {
  now = Date.now, sleep = delay, waitMs = MIRROR_WAIT_MS, pollMs = MIRROR_POLL_MS, log = () => {},
} = {}) {
  if (env.IS_DRAFT === "true") throw new Error("Draft PR: mark ready for review to run checks.");
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? "")) throw new Error("Missing repository identity");
  if (!/^[0-9a-f]{40}$/.test(env.HEAD_SHA ?? "")) throw new Error("Missing pull request head SHA");
  const deadline = now() + waitMs;
  for (;;) {
    const { working, newest } = await readHead({
      repo: env.GITHUB_REPOSITORY, headSha: env.HEAD_SHA, currentRunId: env.GITHUB_RUN_ID, api,
    });
    if (working.length === 0) {
      if (!newest) throw new Error(`No earlier "${GATE_CHECK_NAME}" for ${env.HEAD_SHA}: re-run the gate on this head.`);
      const found = { runId: runIdOf(newest), url: newest.html_url ?? newest.details_url ?? "" };
      if (newest.conclusion !== "success") {
        throw new Error(`The newest "${GATE_CHECK_NAME}" for ${env.HEAD_SHA} (run ${found.runId}) concluded ${newest.conclusion}: ${found.url}`);
      }
      return found;
    }
    const runs = working.length === 1 ? `Run ${working[0]} is` : `Runs ${working.join(", ")} are`;
    if (now() + pollMs > deadline) {
      throw new Error(`${runs} still working on ${env.HEAD_SHA} after ${waitMs / 60_000} min: re-run this job once ${working.length === 1 ? "it finishes" : "they finish"}.`);
    }
    log(`${runs} still working on this head; checking again in ${pollMs / 1000} s.`);
    await sleep(pollMs);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const found = await mirrorEarlierGate(process.env, endpoint => githubApi(endpoint), { log: line => console.log(line) });
    const line = `Quality Gate mirrors run ${found.runId} (${found.url}) — the newest gate on head ${process.env.HEAD_SHA} passed.`;
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
