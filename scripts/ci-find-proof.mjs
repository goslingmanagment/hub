import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { githubApi } from "./ci-github-api.mjs";

export function assertPublishableTitle(title) {
  if (/\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]|skip-checks:\s*true/i.test(title)) {
    throw new Error("Remove the CI-skip instruction from the PR title before merging.");
  }
}

// A failed/partial API response is a cache miss, never permission to skip.
// Artifacts from unfinished, failed or unrelated workflows are not proofs.
export async function findProof({ repo, repoId, name, api }) {
  try {
    const result = await api(`repos/${repo}/actions/artifacts?name=${name}&per_page=100`);
    for (const artifact of result.artifacts ?? []) {
      if (artifact.name !== name || artifact.expired !== false
        || String(artifact.workflow_run?.head_repository_id) !== String(repoId)) continue;
      const id = artifact.workflow_run?.id;
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      const run = await api(`repos/${repo}/actions/runs/${id}`);
      if (run.path === ".github/workflows/ci.yml" && run.status === "completed"
        && run.conclusion === "success" && String(run.head_repository?.id) === String(repoId)) {
        return String(id);
      }
    }
  } catch {
    // Availability affects cost only. Never expose raw API errors or tokens.
  }
  return "";
}

export async function lookupProofs(env, api) {
  assertPublishableTitle(env.PR_TITLE ?? "");
  const hashes = [env.GATE_FINGERPRINT, env.INTEGRATION_FINGERPRINT];
  if (!hashes.every(hash => /^[a-f0-9]{64}$/.test(hash ?? ""))) {
    throw new Error("Missing or invalid CI fingerprints");
  }
  if (env.FORCE_FULL === "true" || env.IS_DRAFT === "true") {
    return { proven_by: "", integration_proven_by: "" };
  }
  const options = { repo: env.GITHUB_REPOSITORY, repoId: env.GITHUB_REPOSITORY_ID, api };
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo ?? "") || !/^\d+$/.test(options.repoId ?? "")) {
    throw new Error("Missing repository identity");
  }
  const proven = await findProof({ ...options, name: `quality-gate-${hashes[0]}` });
  return {
    proven_by: proven,
    integration_proven_by: proven ? "" : await findProof({ ...options, name: `integration-gate-${hashes[1]}` }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const proofs = await lookupProofs(process.env, endpoint => githubApi(endpoint));
  const output = Object.entries(proofs).map(([key, value]) => `${key}=${value}\n`).join("");
  appendFileSync(process.env.GITHUB_OUTPUT, output);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Gate proof: ${proofs.proven_by || "miss"}; integration proof: ${proofs.integration_proven_by || "miss"}.\n`);
}
