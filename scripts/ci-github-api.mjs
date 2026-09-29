// One GitHub REST read for the CI gate scripts (ci-find-proof, ci-mirror-gate),
// over Node's own fetch. The gate jobs also run on the owner's self-hosted
// runners, whose image has no GitHub CLI, so nothing here shells out to `gh`.
// It reads GH_TOKEN (the job's github.token) and GITHUB_API_URL, both set in
// the job. A failure names the status and the endpoint only — never the token
// or the response body.
export const DEFAULT_API_URL = "https://api.github.com";
export const API_TIMEOUT_MS = 20_000;

export async function githubApi(endpoint, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = API_TIMEOUT_MS } = {}) {
  const token = env.GH_TOKEN ?? "";
  if (token === "") throw new Error("GH_TOKEN is not set");
  const base = (env.GITHUB_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
  const response = await fetchImpl(`${base}/${endpoint}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "agency-hub-ci",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`GitHub API answered ${response.status} for ${endpoint}`);
  return await response.json();
}
