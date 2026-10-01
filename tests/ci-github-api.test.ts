import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { API_TIMEOUT_MS, githubApi } from "../scripts/ci-github-api.mjs";

// The gate scripts run on GitHub-hosted runners AND on the owner's PC, whose
// image has no GitHub CLI: they read the API through Node's fetch only.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const token = "ghs_test-token-never-printed";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("CI GitHub API reads", () => {
  it("reads one endpoint with the job token and returns its JSON", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({ ok: 1 }));
    const env = { GH_TOKEN: token, GITHUB_API_URL: "https://ghe.example.invalid/api/v3/" };
    expect(await githubApi("repos/owner/repo/actions/runs/1", { env, fetchImpl })).toEqual({ ok: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://ghe.example.invalid/api/v3/repos/owner/repo/actions/runs/1");
    expect(init?.headers).toEqual({
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "agency-hub-ci",
      "x-github-api-version": "2022-11-28",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    // A stalled request must end well inside the fingerprint job's 5-minute budget.
    expect(API_TIMEOUT_MS).toBe(20_000);
  });

  it("defaults to api.github.com when the runner sets no API URL", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({}));
    await githubApi("repos/owner/repo", { env: { GH_TOKEN: token }, fetchImpl });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/owner/repo");
  });

  it("refuses to call without a token", async () => {
    const fetchImpl = vi.fn();
    await expect(githubApi("repos/owner/repo", { env: { GH_TOKEN: "" }, fetchImpl })).rejects.toThrow("GH_TOKEN is not set");
    await expect(githubApi("repos/owner/repo", { env: {}, fetchImpl })).rejects.toThrow("GH_TOKEN is not set");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails on a non-2xx answer naming the status and endpoint, never the token or body", async () => {
    const fetchImpl = async () => jsonResponse({ message: `Bad credentials ${token}` }, 401);
    const failure = await githubApi("repos/owner/repo/actions/runs/1", { env: { GH_TOKEN: token }, fetchImpl }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("GitHub API answered 401 for repos/owner/repo/actions/runs/1");
  });

  it("gives up when the API does not answer in time", async () => {
    const fetchImpl = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
    await expect(githubApi("repos/owner/repo", { env: { GH_TOKEN: token }, fetchImpl, timeoutMs: 20 })).rejects.toThrow();
  });

  it("no gate script shells out to a CLI", () => {
    for (const script of ["ci-find-proof.mjs", "ci-mirror-gate.mjs", "ci-github-api.mjs", "ci-shards.mjs"]) {
      const source = readFileSync(path.join(repoRoot, "scripts", script), "utf8");
      expect(source, script).not.toContain("node:child_process");
    }
  });
});

// The entry points exactly as the workflow runs them (`node scripts/<name>`),
// against a local stand-in for the REST API and with no `gh` anywhere on PATH.
describe("CI gate scripts against a stand-in GitHub API", () => {
  type Seen = { url: string; headers: IncomingHttpHeaders };

  async function withApi<T>(answer: (url: string) => { status: number; body: unknown }, use: (base: string, seen: Seen[]) => Promise<T>): Promise<T> {
    const seen: Seen[] = [];
    const server = createServer((request, response) => {
      seen.push({ url: request.url ?? "", headers: request.headers });
      const { status, body } = answer(request.url ?? "");
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      return await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }

  function runScript(script: string, env: Record<string, string>) {
    return new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
      execFile(process.execPath, [path.join("scripts", script)], {
        cwd: repoRoot,
        // PATH has no gh: an accidental CLI call would fail these cases.
        env: { PATH: path.join(tmpdir(), "no-such-bin"), GH_TOKEN: token, ...env },
        encoding: "utf8",
        timeout: 30_000,
      }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }));
    });
  }

  it("ci-find-proof records the proving run it found", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hub-ci-find-proof-"));
    try {
      const outputs = path.join(dir, "outputs");
      const summary = path.join(dir, "summary");
      writeFileSync(outputs, "");
      writeFileSync(summary, "");
      const gate = "a".repeat(64);
      const result = await withApi(url => {
        if (url.startsWith(`/repos/owner/repo/actions/artifacts?name=quality-gate-${gate}`)) {
          return { status: 200, body: { artifacts: [{ name: `quality-gate-${gate}`, expired: false, workflow_run: { id: 123, head_repository_id: 42 } }] } };
        }
        if (url === "/repos/owner/repo/actions/runs/123") {
          return { status: 200, body: { path: ".github/workflows/ci.yml", status: "completed", conclusion: "success", head_repository: { id: 42 } } };
        }
        return { status: 404, body: { message: "Not Found" } };
      }, async (base, seen) => {
        const run = await runScript("ci-find-proof.mjs", {
          GITHUB_API_URL: base, GITHUB_REPOSITORY: "owner/repo", GITHUB_REPOSITORY_ID: "42",
          GATE_FINGERPRINT: gate, INTEGRATION_FINGERPRINT: "b".repeat(64), FORCE_FULL: "false", IS_DRAFT: "false",
          PR_TITLE: "ci: a title", GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: summary,
        });
        return { run, seen };
      });
      expect(result.run.code, result.run.stderr).toBe(0);
      expect(readFileSync(outputs, "utf8")).toBe("proven_by=123\nintegration_proven_by=\n");
      expect(readFileSync(summary, "utf8")).toBe("Gate proof: 123; integration proof: miss.\n");
      expect(result.seen.map(item => item.headers.authorization)).toEqual([`Bearer ${token}`, `Bearer ${token}`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ci-find-proof turns an unavailable API into a miss, not a failed job", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hub-ci-find-proof-"));
    try {
      const outputs = path.join(dir, "outputs");
      writeFileSync(outputs, "");
      const run = await withApi(() => ({ status: 503, body: {} }), base => runScript("ci-find-proof.mjs", {
        GITHUB_API_URL: base, GITHUB_REPOSITORY: "owner/repo", GITHUB_REPOSITORY_ID: "42",
        GATE_FINGERPRINT: "a".repeat(64), INTEGRATION_FINGERPRINT: "b".repeat(64), FORCE_FULL: "false", IS_DRAFT: "false",
        PR_TITLE: "", GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: path.join(dir, "summary"),
      }));
      expect(run.code, run.stderr).toBe(0);
      expect(readFileSync(outputs, "utf8")).toBe("proven_by=\nintegration_proven_by=\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const headSha = "c".repeat(40);
  const mirrorEnv = { GITHUB_REPOSITORY: "owner/repo", GITHUB_RUN_ID: "200", HEAD_SHA: headSha, IS_DRAFT: "false" };

  const runsUrl = `/repos/owner/repo/actions/runs?head_sha=${headSha}&per_page=100&page=1`;
  const checkRunsUrl = `/repos/owner/repo/commits/${headSha}/check-runs?filter=all&per_page=100&page=1`;

  it("ci-mirror-gate mirrors the newest passing Quality Gate", async () => {
    const earlier = { id: 9, name: "Quality Gate", app: { slug: "github-actions" }, status: "completed", conclusion: "success",
      html_url: "https://github.com/owner/repo/actions/runs/150/job/9" };
    const { run, seen } = await withApi(url => ({
      status: 200,
      body: url.startsWith("/repos/owner/repo/actions/runs?")
        ? { workflow_runs: [{ id: 150, path: ".github/workflows/ci.yml", status: "completed" }] }
        : { check_runs: [earlier] },
    }), async (base, requests) => ({
      run: await runScript("ci-mirror-gate.mjs", { ...mirrorEnv, GITHUB_API_URL: base }),
      seen: requests,
    }));
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe(`Quality Gate mirrors run 150 (${earlier.html_url}) — the newest gate on head ${headSha} passed.\n`);
    expect(seen.map(item => item.url)).toEqual([runsUrl, checkRunsUrl]);
  });

  it("ci-mirror-gate stays red when the API fails, without printing the token", async () => {
    const run = await withApi(() => ({ status: 500, body: { message: token } }), base =>
      runScript("ci-mirror-gate.mjs", { ...mirrorEnv, GITHUB_API_URL: base }));
    expect(run.code).toBe(1);
    expect(run.stderr).toBe(`GitHub API answered 500 for ${runsUrl.slice(1)}\n`);
    expect(run.stdout + run.stderr).not.toContain(token);
  });
});
