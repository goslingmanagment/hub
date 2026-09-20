import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

import { mirrorEarlierGate } from "../scripts/ci-mirror-gate.mjs";

type Step = {
  name: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Permissions = Record<string, string> | string;
type Job = {
  name?: string;
  needs?: string[];
  if?: string;
  env?: Record<string, string>;
  permissions?: Permissions;
  outputs?: Record<string, string>;
  steps: Step[];
};
type Workflow = { permissions: Permissions; jobs: Record<string, Job>; concurrency: { group: string }; on: { pull_request: { types: string[] } } };

// Reuse the installed YAML parser through its declaring dependency; do not add
// a production dependency merely to parse the workflow in this policy test.
const testRequire = createRequire(import.meta.url);
const swaggerRequire = createRequire(testRequire.resolve("@fastify/swagger"));
const yaml = swaggerRequire("yaml") as { parse: (text: string) => Workflow };
const workflow = yaml.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));

function job(name: string): Job {
  const found = workflow.jobs[name];
  if (!found) throw new Error(`Missing CI job: ${name}`);
  return found;
}

function step(jobName: string, stepName: string): Step {
  const found = job(jobName).steps.find(item => item.name === stepName);
  if (!found) throw new Error(`Missing CI step: ${stepName}`);
  return found;
}

function shell(stepToRun: Step): string {
  if (!stepToRun.run) throw new Error(`Missing shell body: ${stepToRun.name}`);
  return stepToRun.run;
}

function publicationAllowed(event: string, ref: string, quality: string): boolean {
  const context: Record<string, string> = {
    "github.event_name": event,
    "github.ref": ref,
    "needs.quality.result": quality,
  };
  // This gate deliberately uses only conjunctions of equality checks plus the
  // one status function that overrides GitHub's skip propagation (a skipped
  // job in the needs chain skips every dependant that has no status function,
  // even when its direct dependencies succeeded). Reject unrecognised syntax
  // instead of accidentally treating a new OR as safe.
  const condition = job("publish").if;
  if (!condition) throw new Error("Publishing has no explicit condition");
  return condition.split("&&").every(clause => {
    if (clause.trim() === "!cancelled()") return true;
    const match = clause.trim().match(/^(github\.event_name|github\.ref|needs\.quality\.result) == '([^']+)'$/);
    if (!match?.[1] || !match[2]) throw new Error(`Unsupported publication condition: ${clause}`);
    return context[match[1]] === match[2];
  });
}

describe("CI production image publication policy", () => {
  it.each([
    ["pull_request", "refs/pull/1/merge", "success", false],
    ["pull_request", "refs/heads/main", "success", false],
    ["workflow_dispatch", "refs/heads/main", "success", false],
    ["push", "refs/heads/feature", "success", false],
    ["push", "refs/heads/main", "failure", false],
    ["push", "refs/heads/main", "cancelled", false],
    ["push", "refs/heads/main", "skipped", false],
    ["push", "refs/heads/main", "success", true],
  ] as const)("publication for %s %s with gate %s is %s", (event, ref, quality, allowed) => {
    expect(publicationAllowed(event, ref, quality)).toBe(allowed);
    expect(job("publish").needs).toEqual(expect.arrayContaining(["static", "quality"]));
  });

  // The gate's shell reads its inputs from step env (never inline expressions),
  // so the policy is exercised by running that shell with the four variables
  // the workflow binds. `proven_by` empty = no earlier proof for this tree.
  it("binds the gate shell's inputs from the fingerprint and gate jobs", () => {
    expect(job("quality").needs).toEqual(expect.arrayContaining(["fingerprint", "static", "integration"]));
    expect(job("quality").if).toBe("always()");
    expect(step("quality", "Every gate job succeeded").if).toBe("env.BODY_EDIT != 'true'");
    expect(step("quality", "Every gate job succeeded").env).toEqual({
      PROVEN_BY: "${{ needs.fingerprint.outputs.proven_by }}",
      INTEGRATION_PROVEN_BY: "${{ needs.fingerprint.outputs.integration_proven_by }}",
      FINGERPRINT_RESULT: "${{ needs.fingerprint.result }}",
      IS_DRAFT: "${{ github.event_name == 'pull_request' && github.event.pull_request.draft }}",
      REQUIRE_IMAGE: "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}",
      FINGERPRINT: "${{ needs.fingerprint.outputs.hash }}",
      STATIC: "${{ needs.static.result }}",
      INTEGRATION: "${{ needs.integration.result }}",
    });
  });

  it.each([
    // No proof on record: both gate jobs must have run and passed.
    ["", "success", "success", true],
    ["", "failure", "success", false],
    ["", "success", "failure", false],
    ["", "cancelled", "success", false],
    ["", "success", "skipped", false],
    // A failed fingerprint job skips the tests WITHOUT a proof: fail closed.
    ["", "skipped", "skipped", false],
    // Proof on record: tests skipped by design; static is skipped on a PR and
    // must have succeeded on main (it still builds the image there).
    ["35013876329", "skipped", "skipped", true],
    ["35013876329", "success", "skipped", true],
    ["35013876329", "failure", "skipped", false],
    ["35013876329", "cancelled", "skipped", false],
    // A proof never excuses a test job that ran and did not pass.
    ["35013876329", "success", "failure", false],
    ["35013876329", "skipped", "success", false],
  ] as const)("Quality Gate with proven_by=%s static=%s integration=%s passes: %s", (provenBy, staticResult, integrationResult, allowed) => {
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", shell(step("quality", "Every gate job succeeded"))], {
      encoding: "utf8",
      env: {
        ...process.env,
        PROVEN_BY: provenBy,
        INTEGRATION_PROVEN_BY: "",
        FINGERPRINT_RESULT: "success",
        IS_DRAFT: "false",
        REQUIRE_IMAGE: "false",
        FINGERPRINT: "f".repeat(64),
        STATIC: staticResult,
        INTEGRATION: integrationResult,
        GITHUB_STEP_SUMMARY: "/dev/null",
      },
    });
    expect(result.status === 0, result.stderr).toBe(allowed);
  });

  // The integration matrix is skipped on a proven tree, and GitHub carries a
  // skipped dependency's status down the whole `needs` chain: a dependant
  // whose `if` has no status function is skipped too, whatever its direct
  // dependencies did. Publishing sits behind that matrix through the gate, so
  // it must override the propagation — `always()` would also publish after a
  // cancellation, which is why it is `!cancelled()` and nothing weaker.
  it("publishing overrides skip propagation from the proven-tree matrix", () => {
    expect(job("publish").if?.startsWith("!cancelled() && ")).toBe(true);
    expect(job("quality").if).toBe("always()");
  });

  it("reuses a proof only where the workflow says it does, and records one only when fresh", () => {
    const unproven = "needs.fingerprint.outputs.proven_by == ''";
    expect(job("integration").needs).toEqual(["fingerprint"]);
    expect(job("integration").if).toBe(`github.event.pull_request.draft != true && ${unproven} && needs.fingerprint.outputs.integration_proven_by == ''`);
    expect(job("static").needs).toEqual(["fingerprint"]);
    // Main must always enter the static job: the deploy pulls the image it builds.
    expect(job("static").if).toBe(`github.event.pull_request.draft != true && (${unproven} || (github.event_name == 'push' && github.ref == 'refs/heads/main'))`);
    for (const name of ["Typecheck", "Lint (family standard + architecture walls)", "Contracts are regenerated (routes.ts ↔ committed artifacts)", "Reliable unit tests"]) {
      expect(step("static", name).if, name).toBe(unproven);
    }
    for (const name of ["Production Docker image build", "Chromium Headless Shell runtime smoke", "Startup capability manifest smoke"]) {
      expect(step("static", name).if, name).toBeUndefined();
    }
    // A description-only edit has no fingerprint at all, so it must not reach
    // the proof steps: an empty hash would publish `quality-gate-` as a proof.
    const freshProof = `env.BODY_EDIT != 'true' && ${unproven}`;
    expect(step("quality", "Record this fingerprint as proven").if).toBe(freshProof);
    const upload = step("quality", "Publish the proof for later identical trees");
    expect(upload.if).toBe(freshProof);
    expect(upload.with?.name).toBe("quality-gate-${{ needs.fingerprint.outputs.hash }}");
    expect(upload.with?.overwrite).toBe(true);
    expect(step("quality", "Publish fresh integration proof").with?.overwrite).toBe(true);
    // The lookup reads artifacts with the smallest token that can; nothing else in the job writes.
    expect(job("fingerprint").permissions).toEqual({ actions: "read", contents: "read" });
    expect(shell(step("fingerprint", "Look up earlier passing checks"))).toBe("node scripts/ci-find-proof.mjs");
    expect(step("quality", "Publish fresh integration proof").if).toBe("needs.integration.result == 'success'");
  });

  it.each([
    // draft, fingerprint result, main, full proof, DB proof, static, DB, allowed
    [true, "success", false, "123", "", "skipped", "skipped", false],
    [false, "failure", false, "123", "", "skipped", "skipped", false],
    [false, "cancelled", false, "123", "", "success", "skipped", false],
    [false, "success", true, "123", "", "skipped", "skipped", false],
    [false, "success", true, "123", "", "success", "skipped", true],
    [false, "success", false, "", "456", "success", "skipped", true],
    [false, "success", true, "", "456", "success", "skipped", true],
    [false, "success", false, "", "456", "failure", "skipped", false],
    [false, "success", false, "", "456", "cancelled", "skipped", false],
    [false, "success", false, "", "456", "skipped", "skipped", false],
    [false, "success", false, "", "456", "success", "failure", false],
    [false, "success", false, "", "456", "success", "cancelled", false],
    [false, "success", false, "", "", "success", "skipped", false],
  ] as const)("gate admission draft=%s fingerprint=%s main=%s full=%s DBproof=%s static=%s DB=%s allowed=%s",
    (draft, fingerprintResult, main, proven, integrationProven, staticResult, integrationResult, allowed) => {
      const result = spawnSync("bash", ["-euo", "pipefail", "-c", shell(step("quality", "Every gate job succeeded"))], {
        encoding: "utf8",
        env: { ...process.env, IS_DRAFT: String(draft), FINGERPRINT_RESULT: fingerprintResult,
          REQUIRE_IMAGE: String(main), PROVEN_BY: proven, INTEGRATION_PROVEN_BY: integrationProven,
          FINGERPRINT: "f".repeat(64), STATIC: staticResult, INTEGRATION: integrationResult,
          GITHUB_STEP_SUMMARY: "/dev/null" },
      });
      expect(result.status === 0, result.stderr).toBe(allowed);
    },
  );

  // A required check is resolved against the NEWEST check suite for the head
  // SHA. A description-only edit starts a run on that same SHA, so a run that
  // renames or skips this job strips "Quality Gate" off the head and the PR
  // becomes unmergeable with every check green (Decision 377). The name is a
  // literal and the job runs in every event; only the path inside it differs.
  it.each([
    // action, changes.title, changes.base, concurrency group, gate jobs run
    ["edited", false, false, "ci-ref-metadata", false],
    ["edited", true, false, "ci-ref", true],
    ["edited", false, true, "ci-ref", true],
    ["synchronize", false, false, "ci-ref", true],
    ["opened", false, false, "ci-ref", true],
    ["", false, false, "ci-ref", true],
    ["edited", true, true, "ci-ref", true],
    ["ready_for_review", false, false, "ci-ref", true],
    ["converted_to_draft", false, false, "ci-ref", true],
  ] as const)("edit %s title=%s base=%s keeps the required check reported", (action, title, base, expectedGroup, gateJobsRun) => {
    const render = (value: string) => value.replace(/\$\{\{(.*?)\}\}/g, (_match, expression: string) => {
      const resolved = expression.replaceAll("github.event.action", JSON.stringify(action))
        .replaceAll("github.event.changes.title", String(title)).replaceAll("github.event.changes.base", String(base))
        .replaceAll("github.ref", JSON.stringify("ref")).replaceAll("always()", "true");
      // Only the checked-in boolean/string expression above is evaluated.
      return String(Function(`"use strict"; return (${resolved})`)());
    });
    // No expression may reach the check's name: GitHub reported the raw text.
    expect(job("quality").name).toBe("Quality Gate");
    expect(render(job("quality").name ?? "")).toBe("Quality Gate");
    expect(render("${{ " + job("quality").if + " }}")).toBe("true");
    expect(render(workflow.concurrency.group)).toBe(expectedGroup);
    expect(render("${{ " + job("fingerprint").if + " }}")).toBe(String(gateJobsRun));
    // Exactly one path inside the job runs: aggregate this run's gate jobs, or
    // mirror an earlier run's verdict for the same head.
    const bodyEdit = render(job("quality").env?.BODY_EDIT ?? "");
    expect(bodyEdit).toBe(String(!gateJobsRun));
    const runsStep = (condition: string) =>
      render("${{ " + condition.replaceAll("env.BODY_EDIT", JSON.stringify(bodyEdit)) + " }}");
    expect(runsStep(step("quality", "Every gate job succeeded").if ?? "")).toBe(String(gateJobsRun));
    for (const name of ["Checkout", "An earlier run already passed this head"]) {
      expect(runsStep(step("quality", name).if ?? ""), name).toBe(String(!gateJobsRun));
    }
    expect(workflow.on.pull_request.types).toEqual(expect.arrayContaining(["ready_for_review", "converted_to_draft", "edited"]));
  });

  // The mirror confirms an earlier verdict for this exact head; it can never
  // manufacture one, so a red, pending, foreign or missing gate stays red.
  it("mirrors only an earlier successful Quality Gate for the same head SHA", () => {
    const mirror = step("quality", "An earlier run already passed this head");
    expect(shell(mirror)).toBe("node scripts/ci-mirror-gate.mjs");
    expect(mirror.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      IS_DRAFT: "${{ github.event_name == 'pull_request' && github.event.pull_request.draft }}",
      HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
    });
    // Reading check runs on a private repository needs checks:read, and that
    // job-level block must not widen anything else.
    expect(job("quality").permissions).toEqual({ checks: "read", contents: "read" });
    expect(workflow.permissions).toEqual({ contents: "read" });

    const headSha = "a".repeat(40);
    const mirrorEnv = { GITHUB_REPOSITORY: "owner/repo", GITHUB_RUN_ID: "35518904235", HEAD_SHA: headSha, IS_DRAFT: "false" };
    const earlier = { name: "Quality Gate", app: { slug: "github-actions" }, status: "completed", conclusion: "success",
      html_url: "https://github.com/owner/repo/actions/runs/35518903414/job/99" };
    expect(mirrorEarlierGate(mirrorEnv, () => ({ check_runs: [earlier] }))).toEqual({
      runId: "35518903414", url: earlier.html_url,
    });
    // Everything that is not an EARLIER success from this workflow's app fails.
    const rejected = [
      { ...earlier, conclusion: "failure" },
      { ...earlier, conclusion: null, status: "in_progress" },
      { ...earlier, app: { slug: "some-other-app" } },
      { ...earlier, name: "Static checks" },
      { ...earlier, html_url: "https://github.com/owner/repo/actions/runs/35518904235/job/1" },
      { ...earlier, html_url: "https://example.invalid/not-a-run" },
    ];
    for (const checkRun of rejected) {
      expect(() => mirrorEarlierGate(mirrorEnv, () => ({ check_runs: [checkRun] })), JSON.stringify(checkRun)).toThrow("No earlier successful");
    }
    expect(() => mirrorEarlierGate(mirrorEnv, () => ({ check_runs: [] }))).toThrow("No earlier successful");
    expect(() => mirrorEarlierGate(mirrorEnv, () => { throw new Error("API unavailable"); })).toThrow("API unavailable");
    // The head must be a real SHA, and a draft fails exactly like the gate does.
    expect(() => mirrorEarlierGate({ ...mirrorEnv, HEAD_SHA: "" }, () => ({ check_runs: [earlier] }))).toThrow("head SHA");
    const draftApi = vi.fn(() => ({ check_runs: [earlier] }));
    expect(() => mirrorEarlierGate({ ...mirrorEnv, IS_DRAFT: "true" }, draftApi)).toThrow("Draft PR");
    expect(draftApi).not.toHaveBeenCalled();
    // The query asks GitHub for this head's check runs by the required name.
    const endpoints: string[] = [];
    expect(() => mirrorEarlierGate(mirrorEnv, endpoint => { endpoints.push(endpoint); return { check_runs: [] }; })).toThrow();
    expect(endpoints).toEqual([`repos/owner/repo/commits/${headSha}/check-runs?check_name=Quality%20Gate&filter=all&per_page=100&page=1`]);
    // A full page is not the end of the list.
    const pages: string[] = [];
    const other = { ...earlier, conclusion: "failure" };
    const paged = mirrorEarlierGate(mirrorEnv, endpoint => {
      pages.push(endpoint);
      return { check_runs: pages.length === 1 ? Array.from({ length: 100 }, () => other) : [earlier] };
    });
    expect(paged.runId).toBe("35518903414");
    expect(pages).toHaveLength(2);
  });

  it("builds only once, loads the cached image and keeps both smoke tests", () => {
    expect(job("static").steps.some(item => item.run?.includes("pnpm build:artifacts"))).toBe(false);
    const build = step("static", "Production Docker image build");
    expect(build.with).toMatchObject({ context: ".", load: true, pull: true, platforms: "linux/amd64", target: "runtime" });
    expect(build.with?.["build-args"]).toContain("CI_TYPECHECK_ALREADY_PASSED=true");
    expect(build.with?.["cache-from"]).toBe("type=gha,scope=hub-runtime-amd64");
    expect(build.with?.["cache-to"]).toContain("ignore-error=true");
    expect(step("static", "Record checked image identity").id).toBe("build-image");
  });

  it("grants no write permissions to builds, tests, or the root workflow", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const [name, config] of Object.entries(workflow.jobs)) {
      if (name === "publish") continue;
      const permissions = config.permissions ?? workflow.permissions;
      expect(typeof permissions, name).toBe("object");
      expect(Object.values(permissions), name).not.toContain("write");
    }
    expect(job("publish").permissions).toEqual({ packages: "write" });
  });

  it("passes this run's original checked image to publishing without rebuilding", () => {
    expect(job("static").outputs?.image_id).toBe("${{ steps.build-image.outputs.image_id }}");
    expect(job("static").outputs?.artifact_id).toBe("${{ steps.upload-image.outputs.artifact-id }}");
    const download = step("publish", "Download this run's checked image");
    expect(download.with?.["artifact-ids"]).toBe("${{ needs.static.outputs.artifact_id }}");
    expect(download.with?.["digest-mismatch"]).toBe("error");
    expect(download.with?.["run-id"]).toBeUndefined();
    expect(download.with?.repository).toBeUndefined();

    const verify = step("publish", "Verify checked image identity and labels");
    expect(verify.env).toEqual({
      EXPECTED_IMAGE_ID: "${{ needs.static.outputs.image_id }}",
      EXPECTED_SOURCE_REVISION: "${{ needs.static.outputs.source_revision }}",
      EXPECTED_DEPENDENCY_CHECKSUM: "${{ needs.static.outputs.dependency_checksum }}",
    });
    expect(job("publish").steps.map(item => item.run ?? "").join("\n")).not.toMatch(/docker (?:build|buildx)|pnpm |npm /);
    expect(job("publish").steps.some(item => item.uses?.startsWith("actions/checkout@"))).toBe(false);
    expect(shell(step("static", "Exact checkout image metadata"))).toContain("bash scripts/deploy-metadata.sh");
  });

  it.each([
    ["[]", true],
    ['["desktop-lifecycle-v2"]', true],
    ['["future-capability-v3"]', true],
    ['["capability",42]', false],
    ['{"capabilities":[]}', false],
    ["not JSON", false],
  ] as const)("capability smoke validates manifest %s without freezing its vocabulary", (manifest, allowed) => {
    const script = `docker() { printf '%s\\n' "$TEST_CAPABILITIES"; }\n${shell(step("static", "Startup capability manifest smoke"))}`;
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      encoding: "utf8",
      env: { ...process.env, TEST_CAPABILITIES: manifest },
    });
    expect(result.status === 0, result.stderr).toBe(allowed);
    if (allowed) expect(result.stdout).toBe(`${manifest}\n`);
  });
});
