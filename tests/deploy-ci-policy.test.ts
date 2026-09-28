import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { mirrorEarlierGate } from "../scripts/ci-mirror-gate.mjs";
import { DEFAULT_SHARD_TOTAL, planShards } from "../scripts/ci-shards.mjs";

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
  "runs-on"?: string | string[];
  needs?: string[];
  if?: string;
  env?: Record<string, string>;
  permissions?: Permissions;
  outputs?: Record<string, string>;
  strategy?: { "fail-fast"?: unknown; matrix?: Record<string, unknown> };
  steps: Step[];
};
type Workflow = {
  permissions: Permissions;
  jobs: Record<string, Job>;
  concurrency: { group: string; "cancel-in-progress": string };
  on: { pull_request: { types: string[] } };
};

// Reuse the installed YAML parser through its declaring dependency; do not add
// a production dependency merely to parse the workflow in this policy test.
const testRequire = createRequire(import.meta.url);
const swaggerRequire = createRequire(testRequire.resolve("@fastify/swagger"));
const yaml = swaggerRequire("yaml") as { parse: (text: string) => Workflow };
const workflowText = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const workflow = yaml.parse(workflowText);
// TEMP (measurement runs only): ignore the resource sampler steps.
for (const config of Object.values(workflow.jobs)) config.steps = config.steps.filter(item => !item.name.startsWith("TEMP "));
const nightly = yaml.parse(readFileSync(new URL("../.github/workflows/nightly.yml", import.meta.url), "utf8"));

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

// ---------------------------------------------------------------------------
// A deliberately small evaluator for the checked-in GitHub expressions. Every
// context path an expression reads must be modelled in the context below — an
// unknown one throws — so a new input to a gate condition cannot slip past
// these tables. Operators (!, ==, !=, &&, ||, parentheses) map onto JS with the
// same precedence and value-returning semantics; string literals are copied as
// literals and never scanned for context paths.
// ---------------------------------------------------------------------------
type Value = string | number | boolean | null | Value[] | { [key: string]: Value };
type Context = Record<string, Value>;

function contains(haystack: Value, needle: Value): boolean {
  if (Array.isArray(haystack)) return haystack.some(item => item === needle);
  if (typeof haystack === "string" && typeof needle === "string") return haystack.includes(needle);
  return false;
}

function fromJSON(text: Value): Value {
  if (typeof text !== "string") throw new Error("fromJSON expects a string");
  return JSON.parse(text) as Value;
}

/** What the status functions report for the step being decided. */
type JobStatus = { success: boolean; failure: boolean; cancelled: boolean };
const PASSING: JobStatus = { success: true, failure: false, cancelled: false };

function evaluate(expression: string, context: Context, status: JobStatus = PASSING): Value {
  const translated = expression.split(/('(?:[^']|'')*')/).map((segment, index) => {
    if (index % 2 === 1) return JSON.stringify(segment.slice(1, -1).replaceAll("''", "'"));
    if (/[`;{}[\]]|=>/.test(segment)) throw new Error(`Unsupported expression syntax: ${segment}`);
    return segment.replace(/\b(?:github|needs|vars|env|runner|inputs|matrix|steps)(?:\.(?:[A-Za-z_][\w-]*|\*))+/g, path => {
      if (!(path in context)) throw new Error(`Unmodelled context in expression: ${path}`);
      return `ctx[${JSON.stringify(path)}]`;
    });
  }).join("");
  // Only the checked-in workflow expressions reach this point.
  const run = Function("ctx", "contains", "fromJSON", "always", "success", "failure", "cancelled",
    `"use strict"; return (${translated});`) as (ctx: Context, containsFn: typeof contains, fromJSONFn: typeof fromJSON,
    ...statusFns: (() => boolean)[]) => Value;
  return run(context, contains, fromJSON, () => true, () => status.success, () => status.failure, () => status.cancelled);
}

function text(value: Value): string {
  if (value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Env, `with`, names and groups: GitHub interpolates every expression into a string. */
function field(template: string, context: Context): string {
  return template.replace(/\$\{\{(.*?)\}\}/g, (_match, expression: string) => text(evaluate(expression, context)));
}

/** `runs-on` that is one whole expression keeps its type: a label array or one label. */
function runner(template: string | string[] | undefined, context: Context): Value {
  if (typeof template !== "string") throw new Error("runs-on must be one label or one expression");
  const whole = /^\$\{\{(.*)\}\}$/s.exec(template);
  if (!whole || whole[1]?.includes("}}")) return template;
  return evaluate(whole[1] ?? "", context);
}

function condition(expression: string | undefined, context: Context): boolean {
  if (expression === undefined) throw new Error("Missing condition");
  return Boolean(evaluate(expression, context));
}

/** GitHub runs a step whose `if` names no status function only while the job is passing. */
function stepRuns(item: Step, context: Context, status: JobStatus): boolean {
  if (item.if === undefined) return status.success;
  const explicit = /\b(?:success|failure|cancelled|always)\(\)/.test(item.if);
  return (explicit || status.success) && Boolean(evaluate(item.if, context, status));
}

type EventOptions = {
  event?: "pull_request" | "push" | "workflow_dispatch";
  action?: string | null;
  titleChanged?: boolean;
  baseChanged?: boolean;
  /** The label a `labeled` event adds. */
  label?: string | null;
  /** The labels the PR carries after the event (GitHub's payload includes the added one). */
  labels?: string[];
  draft?: boolean;
  /** vars.CI_POOL; an unset repository variable reads as ''. */
  pool?: string;
  attempt?: string;
  /** vars.CI_PC_SHARDS; an unset repository variable reads as ''. */
  pcShards?: string;
  provenBy?: string;
  integrationProvenBy?: string;
  /** The fingerprint job's shard plan outputs; '' when it did not set them. */
  shards?: string;
  shardTotal?: string;
  /** matrix.shard of one integration leg. */
  shard?: number;
  runnerEnvironment?: "github-hosted" | "self-hosted";
};

function eventContext(options: EventOptions = {}): Context {
  const event = options.event ?? "pull_request";
  const pullRequest = event === "pull_request";
  return {
    "github.event_name": event,
    "github.event.action": pullRequest ? options.action ?? "synchronize" : null,
    "github.event.changes.title": options.titleChanged ? { from: "Old title" } : null,
    "github.event.changes.base": options.baseChanged ? { ref: { from: "old-base" } } : null,
    "github.event.label.name": options.label ?? null,
    "github.event.pull_request.labels.*.name": pullRequest ? options.labels ?? [] : [],
    "github.event.pull_request.draft": pullRequest ? options.draft ?? false : null,
    "github.ref": "ref",
    "github.run_id": "35518904235",
    "github.run_attempt": options.attempt ?? "1",
    "vars.CI_POOL": options.pool ?? "",
    "vars.CI_PC_SHARDS": options.pcShards ?? "",
    "needs.fingerprint.outputs.proven_by": options.provenBy ?? "",
    "needs.fingerprint.outputs.integration_proven_by": options.integrationProvenBy ?? "",
    "needs.fingerprint.outputs.shards": options.shards ?? "[1,2,3]",
    "needs.fingerprint.outputs.shard_total": options.shardTotal ?? "3",
    "matrix.shard": options.shard ?? 1,
    "runner.environment": options.runnerEnvironment ?? "github-hosted",
    "runner.temp": "/runner/_temp",
  };
}

function runGate(env: Record<string, string>) {
  return spawnSync("bash", ["-euo", "pipefail", "-c", shell(step("quality", "Every gate job succeeded"))], {
    encoding: "utf8",
    env: {
      ...process.env,
      PROVEN_BY: "",
      INTEGRATION_PROVEN_BY: "",
      FINGERPRINT_RESULT: "success",
      IS_DRAFT: "false",
      ECONOMY: "false",
      PR_NUMBER: "",
      FINGERPRINT: "f".repeat(64),
      GITHUB_STEP_SUMMARY: "/dev/null",
      ...env,
    },
  });
}

describe("CI no longer publishes production images", () => {
  // Production images build on the server; the owner retired GHCR publishing.
  // Nothing in CI may regain a registry credential or ship an image out.
  it("has no publication job, artifact hand-off or registry write", () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual(["fingerprint", "integration", "quality", "static"]);
    expect(job("static").outputs).toBeUndefined();
    expect(job("static").steps.some(item => item.uses?.startsWith("actions/upload-artifact@"))).toBe(false);
    const allShell = Object.values(workflow.jobs).flatMap(config => config.steps.map(item => item.run ?? "")).join("\n");
    expect(allShell).not.toMatch(/docker (?:push|save|login|tag)\b/);
    expect(workflowText).not.toContain("ghcr.io");
    expect(workflowText).not.toContain("packages:");
    expect(workflowText).not.toContain("REQUIRE_IMAGE");
  });

  it("grants no write permissions anywhere", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const [name, config] of Object.entries(workflow.jobs)) {
      const permissions = config.permissions ?? workflow.permissions;
      expect(typeof permissions, name).toBe("object");
      expect(Object.values(permissions), name).not.toContain("write");
    }
  });
});

describe("CI Quality Gate policy", () => {
  // The gate's shell reads its inputs from step env (never inline expressions),
  // so the policy is exercised by running that shell with the variables the
  // workflow binds. `proven_by` empty = no earlier proof for this tree.
  it("binds the gate shell's inputs from the fingerprint and gate jobs", () => {
    expect(job("quality").needs).toEqual(["fingerprint", "static", "integration"]);
    expect(job("quality").if).toBe("always()");
    expect(step("quality", "Every gate job succeeded").if).toBe("env.METADATA_ONLY != 'true'");
    expect(step("quality", "Every gate job succeeded").env).toEqual({
      PROVEN_BY: "${{ needs.fingerprint.outputs.proven_by }}",
      INTEGRATION_PROVEN_BY: "${{ needs.fingerprint.outputs.integration_proven_by }}",
      FINGERPRINT_RESULT: "${{ needs.fingerprint.result }}",
      IS_DRAFT: "${{ github.event_name == 'pull_request' && github.event.pull_request.draft }}",
      ECONOMY: "${{ github.event_name == 'pull_request' && vars.CI_POOL != 'pc' }}",
      PR_NUMBER: "${{ github.event.pull_request.number }}",
      FINGERPRINT: "${{ needs.fingerprint.outputs.hash }}",
      STATIC: "${{ needs.static.result }}",
      INTEGRATION: "${{ needs.integration.result }}",
    });
  });

  it.each([
    // pool, event, ECONOMY
    ["", "pull_request", "true"],
    ["hosted", "pull_request", "true"],
    ["pc", "pull_request", "false"],
    ["", "push", "false"],
    ["", "workflow_dispatch", "false"],
  ] as const)("economy explanation with CI_POOL=%s on %s is %s", (pool, event, expected) => {
    const economy = step("quality", "Every gate job succeeded").env?.ECONOMY ?? "";
    expect(field(economy, eventContext({ pool, event }))).toBe(expected);
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
    // Proof on record: both jobs are skipped by their own conditions. A static
    // run that passed is not evidence against the proof.
    ["35013876329", "skipped", "skipped", true],
    ["35013876329", "success", "skipped", true],
    ["35013876329", "failure", "skipped", false],
    ["35013876329", "cancelled", "skipped", false],
    // A proof never excuses a test job that ran and did not pass.
    ["35013876329", "success", "failure", false],
    ["35013876329", "skipped", "success", false],
  ] as const)("Quality Gate with proven_by=%s static=%s integration=%s passes: %s", (provenBy, staticResult, integrationResult, allowed) => {
    for (const economy of ["false", "true"]) {
      const result = runGate({ PROVEN_BY: provenBy, STATIC: staticResult, INTEGRATION: integrationResult, ECONOMY: economy, PR_NUMBER: "7" });
      expect(result.status === 0, `${economy}: ${result.stdout}${result.stderr}`).toBe(allowed);
    }
  });

  it.each([
    // draft, fingerprint result, economy, full proof, DB proof, static, DB, allowed
    [true, "success", false, "123", "", "skipped", "skipped", false],
    [false, "failure", false, "123", "", "skipped", "skipped", false],
    [false, "cancelled", false, "123", "", "success", "skipped", false],
    // Main no longer re-runs static on a fully proven tree.
    [false, "success", false, "123", "", "skipped", "skipped", true],
    [false, "success", true, "123", "", "skipped", "skipped", true],
    [false, "success", false, "123", "", "success", "skipped", true],
    // An integration-only proof never excuses static checks.
    [false, "success", false, "", "456", "success", "skipped", true],
    [false, "success", true, "", "456", "success", "skipped", true],
    [false, "success", false, "", "456", "failure", "skipped", false],
    [false, "success", false, "", "456", "cancelled", "skipped", false],
    [false, "success", false, "", "456", "skipped", "skipped", false],
    [false, "success", false, "", "456", "success", "failure", false],
    [false, "success", false, "", "456", "success", "cancelled", false],
    // Integration skipped without any proof — economy mode or not — is red.
    [false, "success", false, "", "", "success", "skipped", false],
    [false, "success", true, "", "", "success", "skipped", false],
    [false, "success", true, "", "", "failure", "skipped", false],
    [false, "success", true, "", "", "success", "success", true],
  ] as const)("gate admission draft=%s fingerprint=%s economy=%s full=%s DBproof=%s static=%s DB=%s allowed=%s",
    (draft, fingerprintResult, economy, proven, integrationProven, staticResult, integrationResult, allowed) => {
      const result = runGate({ IS_DRAFT: String(draft), FINGERPRINT_RESULT: fingerprintResult, ECONOMY: String(economy),
        PR_NUMBER: "7", PROVEN_BY: proven, INTEGRATION_PROVEN_BY: integrationProven, STATIC: staticResult, INTEGRATION: integrationResult });
      expect(result.status === 0, result.stdout + result.stderr).toBe(allowed);
    },
  );

  // Exhaustive: the gate passes exactly when the reference rule says so, the
  // economy flag never changes a verdict, and no pass exists without the
  // integration shards having run green or been proven for this tree.
  it("never passes without integration evidence, whatever economy mode says", () => {
    const results = ["success", "failure", "cancelled", "skipped"] as const;
    const reference = (proven: string, integrationProven: string, staticResult: string, integrationResult: string) => {
      if (proven) return integrationResult === "skipped" && (staticResult === "success" || staticResult === "skipped");
      if (staticResult !== "success") return false;
      return integrationProven ? integrationResult === "skipped" : integrationResult === "success";
    };
    for (const proven of ["", "123"]) {
      for (const integrationProven of ["", "456"]) {
        for (const staticResult of results) {
          for (const integrationResult of results) {
            const expected = reference(proven, integrationProven, staticResult, integrationResult);
            if (expected) expect(integrationResult === "success" || proven !== "" || integrationProven !== "").toBe(true);
            for (const economy of ["false", "true"]) {
              const label = JSON.stringify({ proven, integrationProven, staticResult, integrationResult, economy });
              const result = runGate({ PROVEN_BY: proven, INTEGRATION_PROVEN_BY: integrationProven, STATIC: staticResult,
                INTEGRATION: integrationResult, ECONOMY: economy, PR_NUMBER: "7" });
              expect(result.status === 0, label).toBe(expected);
            }
          }
        }
      }
    }
  });

  it("tells the author how to run integration when economy mode skipped it", () => {
    const hint = "::error title=Integration tests did not run::Economy mode (CI_POOL is not pc) runs only static checks on pushes to a ready PR. When this PR is final, run: gh pr edit 312 --add-label ci:full (or convert it to draft and mark it ready again).\n";
    const economy = runGate({ ECONOMY: "true", PR_NUMBER: "312", STATIC: "success", INTEGRATION: "skipped" });
    expect(economy.status).toBe(1);
    expect(economy.stdout).toBe(hint);
    // The hint also shows beside a static failure, so one push fixes both.
    const withStaticFailure = runGate({ ECONOMY: "true", PR_NUMBER: "312", STATIC: "failure", INTEGRATION: "skipped" });
    expect(withStaticFailure.status).toBe(1);
    expect(withStaticFailure.stdout).toBe(hint);
    // Outside economy mode the same skip is simply red, with no false advice.
    const pcPool = runGate({ ECONOMY: "false", PR_NUMBER: "312", STATIC: "success", INTEGRATION: "skipped" });
    expect(pcPool.status).toBe(1);
    expect(pcPool.stdout).toBe("");
    // A DB proof covers the skip: no hint, and the gate passes.
    const proven = runGate({ ECONOMY: "true", PR_NUMBER: "312", STATIC: "success", INTEGRATION: "skipped", INTEGRATION_PROVEN_BY: "456" });
    expect(proven.status).toBe(0);
    expect(proven.stdout).toBe("");
  });
});

describe("CI job admission", () => {
  it.each([
    // event, action, draft, full proof, DB proof, static runs
    ["pull_request", "synchronize", false, "", "", true],
    ["pull_request", "synchronize", true, "", "", false],
    ["pull_request", "synchronize", false, "123", "", false],
    ["pull_request", "synchronize", false, "", "456", true],
    // Main skips static on a fully proven tree: CI publishes no image.
    ["push", null, false, "123", "", false],
    ["push", null, false, "", "456", true],
    ["push", null, false, "", "", true],
    ["workflow_dispatch", null, false, "", "", true],
  ] as const)("static on %s/%s draft=%s full=%s DBproof=%s runs: %s", (event, action, draft, provenBy, integrationProvenBy, runs) => {
    expect(job("static").needs).toEqual(["fingerprint"]);
    expect(job("static").if).toBe("github.event.pull_request.draft != true && needs.fingerprint.outputs.proven_by == ''");
    for (const pool of ["", "pc"]) {
      const context = eventContext({ event, action, draft, provenBy, integrationProvenBy, pool });
      expect(condition(job("static").if, context), pool).toBe(runs);
    }
  });

  // Every check in the static job runs whenever the job runs. Only the unit
  // tests' background start, their join and the cleanup have conditions of
  // their own; see "CI static job" below for how those behave.
  it("runs every static check, the image build and all three smoke tests whenever static runs", () => {
    const steps = job("static").steps;
    const conditional = steps.filter(item => item.if !== undefined);
    expect(conditional.map(item => [item.name, item.if])).toEqual([
      ["Start reliable unit tests in the background", "runner.environment == 'self-hosted'"],
      ["Reliable unit tests", "!cancelled() && (success() || steps.unit-tests.outputs.started == 'true')"],
      ["Stop background unit tests", "always()"],
      ["Remove this run's image", "always()"],
    ]);
    expect(steps.at(-1)?.name).toBe("Remove this run's image");
    for (const name of [
      "Typecheck",
      "Lint (family standard + architecture walls)",
      "Contracts are regenerated (routes.ts ↔ committed artifacts)",
      "Exact checkout image metadata",
      "Production Docker image build",
      "Chromium Headless Shell runtime smoke",
      "Native image library smoke",
      "Startup capability manifest smoke",
    ]) {
      expect(step("static", name).if, name).toBeUndefined();
    }
    // Hosted, or self-hosted with nothing failed so far: the unit tests' step
    // runs exactly as an unconditional step would.
    for (const runnerEnvironment of ["github-hosted", "self-hosted"] as const) {
      const context = { ...eventContext({ runnerEnvironment }), "steps.unit-tests.outputs.started": runnerEnvironment === "self-hosted" ? "true" : "" };
      expect(stepRuns(step("static", "Reliable unit tests"), context, PASSING), runnerEnvironment).toBe(true);
    }
  });

  it.each([
    // pool, run attempt, event, action, labels, draft, full proof, DB proof, integration runs
    // Economy mode: a plain push to a ready PR runs static only.
    ["", "1", "pull_request", "synchronize", [], false, "", "", false],
    ["hosted", "1", "pull_request", "synchronize", [], false, "", "", false],
    ["", "1", "pull_request", "synchronize", ["needs-review"], false, "", "", false],
    ["", "1", "pull_request", "edited", [], false, "", "", false],
    // ...and runs integration when the PR opens, reopens, turns ready, or is labelled.
    ["", "1", "pull_request", "opened", [], false, "", "", true],
    ["", "1", "pull_request", "reopened", [], false, "", "", true],
    ["", "1", "pull_request", "ready_for_review", [], false, "", "", true],
    ["", "1", "pull_request", "synchronize", ["ci:full"], false, "", "", true],
    ["", "1", "pull_request", "synchronize", ["needs-review", "ci:full"], false, "", "", true],
    ["", "1", "pull_request", "labeled", ["ci:full"], false, "", "", true],
    // Any re-run runs the shards: ci-pool re-runs a stuck PC run on GitHub
    // after switching pools, and it must not turn the gate red for economy.
    ["", "2", "pull_request", "synchronize", [], false, "", "", true],
    ["hosted", "2", "pull_request", "synchronize", [], false, "", "", true],
    ["", "3", "pull_request", "synchronize", ["needs-review"], false, "", "", true],
    ["", "2", "pull_request", "edited", [], false, "", "", true],
    ["pc", "2", "pull_request", "synchronize", [], false, "", "", true],
    // Main and manual runs are never economised.
    ["", "1", "push", null, [], false, "", "", true],
    ["", "1", "workflow_dispatch", null, [], false, "", "", true],
    // PC pool: always, on every event that reaches the job.
    ["pc", "1", "pull_request", "synchronize", [], false, "", "", true],
    ["pc", "1", "pull_request", "edited", [], false, "", "", true],
    ["pc", "1", "pull_request", "opened", [], false, "", "", true],
    ["pc", "1", "push", null, [], false, "", "", true],
    // Drafts and proofs skip it in every mode, re-runs included.
    ["pc", "1", "pull_request", "opened", [], true, "", "", false],
    ["", "1", "pull_request", "ready_for_review", ["ci:full"], true, "", "", false],
    ["pc", "1", "pull_request", "synchronize", [], false, "123", "", false],
    ["", "1", "pull_request", "opened", ["ci:full"], false, "123", "", false],
    ["pc", "1", "pull_request", "synchronize", [], false, "", "456", false],
    ["", "1", "push", null, [], false, "", "456", false],
    ["", "2", "pull_request", "synchronize", [], true, "", "", false],
    ["", "2", "pull_request", "synchronize", [], false, "123", "", false],
    ["", "2", "pull_request", "synchronize", [], false, "", "456", false],
  ] as const)("integration with CI_POOL=%s attempt %s on %s/%s labels=%j draft=%s full=%s DBproof=%s runs: %s",
    (pool, attempt, event, action, labels, draft, provenBy, integrationProvenBy, runs) => {
      const label = action === "labeled" ? "ci:full" : null;
      const context = eventContext({ pool, attempt, event, action, labels: [...labels], label, draft, provenBy, integrationProvenBy });
      expect(condition(job("integration").if, context)).toBe(runs);
    },
  );

  it("pins the integration admission text and the proof recording steps", () => {
    const unproven = "needs.fingerprint.outputs.proven_by == ''";
    expect(job("integration").needs).toEqual(["fingerprint"]);
    expect(job("integration").if).toBe(`github.event.pull_request.draft != true && ${unproven} && needs.fingerprint.outputs.integration_proven_by == '' && (vars.CI_POOL == 'pc' || github.run_attempt != '1' || github.event_name != 'pull_request' || contains(fromJSON('["opened","reopened","ready_for_review"]'), github.event.action) || contains(github.event.pull_request.labels.*.name, 'ci:full'))`);
    // A metadata-only event has no fingerprint at all, so it must not reach
    // the proof steps: an empty hash would publish `quality-gate-` as a proof.
    const freshProof = `env.METADATA_ONLY != 'true' && ${unproven}`;
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
});

describe("CI runner pool", () => {
  const selfHosted = ["self-hosted", "ci-pc"];

  it.each([
    // CI_POOL, run attempt, static, integration
    ["pc", "1", selfHosted, selfHosted],
    // Re-runs always go hosted: the PC may have died mid-run.
    ["pc", "2", "ubuntu-24.04", "ubuntu-24.04-arm"],
    ["pc", "3", "ubuntu-24.04", "ubuntu-24.04-arm"],
    ["", "1", "ubuntu-24.04", "ubuntu-24.04-arm"],
    ["hosted", "1", "ubuntu-24.04", "ubuntu-24.04-arm"],
  ] as const)("CI_POOL=%s attempt %s routes static to %j and integration to %j", (pool, attempt, staticRunner, integrationRunner) => {
    const context = eventContext({ pool, attempt });
    expect(runner(job("static")["runs-on"], context)).toEqual(staticRunner);
    expect(runner(job("integration")["runs-on"], context)).toEqual(integrationRunner);
  });

  it("keeps the canonical pool expression and pins every hosted image", () => {
    const pool = (fallback: string) =>
      `\${{ vars.CI_POOL == 'pc' && github.run_attempt == '1' && fromJSON('["self-hosted","ci-pc"]') || '${fallback}' }}`;
    expect(job("static")["runs-on"]).toBe(pool("ubuntu-24.04"));
    expect(job("integration")["runs-on"]).toBe(pool("ubuntu-24.04-arm"));
    // Seconds-long jobs without Docker take the cheapest runner.
    expect(job("fingerprint")["runs-on"]).toBe("ubuntu-slim");
    expect(job("quality")["runs-on"]).toBe("ubuntu-slim");
    expect(job("fingerprint")).toHaveProperty("timeout-minutes", 5);
    expect(job("quality")).toHaveProperty("timeout-minutes", 5);
    // ubuntu-latest moves to a new release on GitHub's schedule, not ours.
    expect(workflowText).not.toContain("ubuntu-latest");
    for (const [name, config] of Object.entries(nightly.jobs)) {
      expect(config["runs-on"], name).toBe("ubuntu-24.04");
    }
  });

  // Self-hosted runners of this repo share ONE Docker daemon and one $HOME.
  it("keeps concurrent self-hosted static jobs off each other's image, builder and pnpm install", () => {
    const staticJob = job("static");
    expect(staticJob.env?.IMAGE).toBe("agency_hub_core/runtime:ci-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(field(staticJob.env?.IMAGE ?? "", eventContext({ attempt: "2" }))).toBe("agency_hub_core/runtime:ci-35518904235-2");
    const build = step("static", "Production Docker image build");
    expect(build.with?.tags).toBe("${{ env.IMAGE }}");
    expect(build.with?.builder).toBe("${{ steps.buildx.outputs.name }}");
    expect(step("static", "Set up Docker Buildx").id).toBe("buildx");
    const buildx = step("static", "Set up Docker Buildx").with ?? {};
    const buildWith = build.with ?? {};
    for (const [environment, driver, cacheFrom, cacheTo] of [
      ["github-hosted", "docker-container", "type=gha,scope=hub-runtime-amd64", "type=gha,scope=hub-runtime-amd64,mode=max,ignore-error=true"],
      ["self-hosted", "docker", "", ""],
    ] as const) {
      const context = eventContext({ runnerEnvironment: environment });
      expect(field(String(buildx.driver), context), environment).toBe(driver);
      expect(field(String(buildWith["cache-from"]), context), environment).toBe(cacheFrom);
      expect(field(String(buildWith["cache-to"]), context), environment).toBe(cacheTo);
    }

    // Every docker invocation names this run's image, quoted; no fixed tag remains.
    const dockerSteps = staticJob.steps.filter(item => item.run?.includes("docker "));
    expect(dockerSteps.map(item => item.name)).toEqual([
      "Chromium Headless Shell runtime smoke",
      "Native image library smoke",
      "Startup capability manifest smoke",
      "Remove this run's image",
    ]);
    for (const item of dockerSteps) {
      const body = shell(item);
      expect(body, item.name).toContain('"$IMAGE"');
      expect(body.replaceAll('"$IMAGE"', ""), item.name).not.toContain("$IMAGE");
      expect(body, item.name).not.toContain("agency_hub_core/runtime");
    }
    expect(workflowText).not.toMatch(/agency_hub_core\/runtime:ci(?!-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\})/);

    // pnpm/action-setup wipes its dest, so each job installs pnpm under its own
    // runner.temp; only hosted runners restore the store from the Actions cache.
    for (const name of ["static", "integration"]) {
      const pnpm = job(name).steps.find(item => item.uses?.startsWith("pnpm/action-setup@"));
      expect(pnpm?.with, name).toEqual({ dest: "${{ runner.temp }}/setup-pnpm" });
      const node = job(name).steps.find(item => item.uses?.startsWith("actions/setup-node@"));
      expect(node?.with?.["node-version"], name).toBe(22);
      for (const [environment, cache] of [["github-hosted", "pnpm"], ["self-hosted", ""]] as const) {
        expect(field(String(node?.with?.cache), eventContext({ runnerEnvironment: environment })), `${name} ${environment}`).toBe(cache);
      }
    }
  });

  // pnpm keeps its store under PNPM_HOME, inside that per-job dest: without an
  // explicit store every PC job would download every package again. The PC
  // shares one store in $HOME (safe for concurrent installs); hosted runners
  // keep pnpm's default store, the one setup-node caches.
  it.each(["static", "integration"])("%s installs from the shared PC store only on self-hosted runners", name => {
    const install = step(name, "Install dependencies");
    expect(install.if, name).toBeUndefined();
    expect(install.env).toEqual({ PNPM_PC_STORE: "${{ runner.environment == 'self-hosted' && '1' || '' }}" });
    expect(shell(install)).toBe([
      'if [ -n "$PNPM_PC_STORE" ]; then export npm_config_store_dir="$HOME/.local/share/pnpm/store"; fi',
      "pnpm install --frozen-lockfile",
      "",
    ].join("\n"));
    const names = job(name).steps.map(item => item.name);
    expect(names.indexOf("Install dependencies"), name).toBeGreaterThan(names.indexOf("Setup Node.js"));
    for (const [environment, store] of [
      ["github-hosted", "<default>"],
      ["self-hosted", "/home/runner/.local/share/pnpm/store"],
    ] as const) {
      const env = field(install.env?.PNPM_PC_STORE ?? "", eventContext({ runnerEnvironment: environment }));
      const script = `pnpm() { printf '%s|%s\\n' "$*" "\${npm_config_store_dir:-<default>}"; }\n${shell(install)}`;
      const { npm_config_store_dir: _inherited, ...inherited } = process.env;
      const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
        encoding: "utf8",
        env: { ...inherited, HOME: "/home/runner", PNPM_PC_STORE: env },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout, `${name} ${environment}`).toBe(`install --frozen-lockfile|${store}\n`);
    }
  });

  it.each([
    ["docker succeeds", 0],
    ["docker fails", 1],
  ] as const)("cleanup removes this run's image and ignores errors when %s", (_label, dockerStatus) => {
    const cleanup = step("static", "Remove this run's image");
    expect(cleanup.if).toBe("always()");
    const script = `docker() { printf '%s\\n' "$*" >&2; return ${dockerStatus}; }\n${shell(cleanup)}`;
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      encoding: "utf8",
      env: { ...process.env, IMAGE: "agency_hub_core/runtime:ci-1-1" },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("image rm agency_hub_core/runtime:ci-1-1\n");
  });

  it.each([
    "Chromium Headless Shell runtime smoke",
    "Native image library smoke",
  ])("%s runs this run's image", name => {
    const script = `docker() { for arg in "$@"; do [ "$arg" = "$IMAGE" ] && return 0; done; return 9; }\n${shell(step("static", name))}`;
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      encoding: "utf8",
      env: { ...process.env, IMAGE: "agency_hub_core/runtime:ci-1-1" },
    });
    expect(result.status, result.stderr).toBe(0);
  });
});

describe("CI static job: unit tests beside the image checks", () => {
  const start = "Start reliable unit tests in the background";
  const unit = "Reliable unit tests";
  const stop = "Stop background unit tests";
  const contracts = "Contracts are regenerated (routes.ts ↔ committed artifacts)";
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));

  // Self-hosted: the unit tests start as soon as the tree is final and run in
  // a process group of their own beside typecheck → smokes; a later step
  // joins them. The contracts generator rewrites tracked sources the unit
  // tests import, so it runs before they start. Hosted runners (2 vCPUs) keep
  // running the unit tests in the joining step, after the smokes.
  it("starts the unit tests after the contracts check and joins them after the smokes", () => {
    expect(job("static").steps.map(item => item.name)).toEqual([
      "Checkout",
      "Setup pnpm",
      "Setup Node.js",
      "Install dependencies",
      contracts,
      start,
      "Typecheck",
      "Lint (family standard + architecture walls)",
      "Exact checkout image metadata",
      "Set up Docker Buildx",
      "Production Docker image build",
      "Chromium Headless Shell runtime smoke",
      "Native image library smoke",
      "Startup capability manifest smoke",
      unit,
      stop,
      "Remove this run's image",
    ]);
    expect(step("static", start).id).toBe("unit-tests");
    expect(shell(step("static", start))).toBe([
      "bash scripts/ci-background.sh start unit-tests pnpm test:unit --maxWorkers=4",
      'echo "started=true" >> "$GITHUB_OUTPUT"',
      "",
    ].join("\n"));
    expect(step("static", unit).env).toEqual({ IN_BACKGROUND: "${{ steps.unit-tests.outputs.started }}" });
    expect(shell(step("static", unit))).toBe([
      'if [ "$IN_BACKGROUND" = "true" ]; then',
      "  bash scripts/ci-background.sh join unit-tests",
      "else",
      "  pnpm test:unit --maxWorkers=2",
      "fi",
      "",
    ].join("\n"));
    expect(shell(step("static", stop))).toBe("bash scripts/ci-background.sh stop unit-tests");
  });

  type Scenario = {
    environment: "github-hosted" | "self-hosted";
    /** A check other than the unit tests' own steps that fails. */
    failAt?: string;
    /** A check during which the job is cancelled. */
    cancelAt?: string;
    /** The unit tests' exit status, or "killed": they die without recording one. */
    unitExit: number | "killed";
    /** How long the unit tests keep running, in seconds. */
    unitSeconds?: number;
  };
  type Outcome = "success" | "failure" | "cancelled" | "skipped";

  function groupAlive(group: number): boolean {
    try {
      process.kill(-group, 0);
      return true;
    } catch {
      return false;
    }
  }

  // Walks the static job the way the runner does: each step's `if` (with the
  // implicit success() when it names no status function), step env and
  // outputs. The unit tests' three steps run their real shells against a stub
  // pnpm; every other step only passes, fails or is cancelled as told.
  function simulateStatic(scenario: Scenario) {
    const dir = mkdtempSync(path.join(tmpdir(), "hub-ci-static-"));
    const pnpm = path.join(dir, "pnpm");
    writeFileSync(pnpm, [
      "#!/usr/bin/env bash",
      'echo "pnpm $*"',
      '[ "$1" = test:unit ] || exit 0',
      // A child of its own, so the whole process group has to be reaped.
      'sleep "$UNIT_SECONDS" & wait "$!"',
      'if [ "$UNIT_EXIT" = killed ]; then kill -KILL "$PPID"; exit 0; fi',
      'echo "unit tests finished"',
      'exit "$UNIT_EXIT"',
      "",
    ].join("\n"));
    chmodSync(pnpm, 0o755);
    const runnerTemp = path.join(dir, "temp");
    const pidFile = path.join(runnerTemp, "ci-background", "unit-tests.pid");
    const outputs: Record<string, string> = {};
    const context = (): Context => ({
      ...eventContext({ runnerEnvironment: scenario.environment }),
      "steps.unit-tests.outputs.started": outputs.started ?? "",
    });
    const status: JobStatus = { ...PASSING };
    const outcomes: Record<string, Outcome> = {};
    const logs: Record<string, string> = {};
    let group: number | null = null;
    try {
      for (const item of job("static").steps) {
        if (!stepRuns(item, context(), status)) {
          outcomes[item.name] = "skipped";
          continue;
        }
        if (item.name === scenario.cancelAt) {
          // Cancelled once the unit tests have logged something, as a real
          // cancel lands well after they started.
          const log = path.join(runnerTemp, "ci-background", "unit-tests.log");
          const waited = spawnSync("bash", ["-c", 'for _ in $(seq 100); do [ -s "$1" ] && exit 0; sleep 0.05; done; exit 1', "wait", log]);
          expect(waited.status, "the unit tests never logged").toBe(0);
          outcomes[item.name] = "cancelled";
          status.success = false;
          status.cancelled = true;
          continue;
        }
        let passed = item.name !== scenario.failAt;
        if ([start, unit, stop].includes(item.name)) {
          const githubOutput = path.join(dir, "github-output");
          writeFileSync(githubOutput, "");
          const env = Object.fromEntries(Object.entries(item.env ?? {}).map(([key, value]) => [key, field(value, context())]));
          const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", field(shell(item), context())], {
            cwd: repoRoot,
            encoding: "utf8",
            timeout: 20_000,
            env: {
              ...process.env, ...env, PATH: `${dir}:${process.env.PATH ?? ""}`, RUNNER_TEMP: runnerTemp,
              GITHUB_OUTPUT: githubOutput, UNIT_EXIT: String(scenario.unitExit), UNIT_SECONDS: String(scenario.unitSeconds ?? 0.1),
            },
          });
          logs[item.name] = result.stdout + result.stderr;
          for (const line of readFileSync(githubOutput, "utf8").split("\n").filter(Boolean)) {
            const [key = "", ...value] = line.split("=");
            outputs[key] = value.join("=");
          }
          passed = result.status === 0;
        }
        outcomes[item.name] = passed ? "success" : "failure";
        if (!passed) {
          status.success = false;
          status.failure = true;
        }
      }
      group = readGroup(pidFile);
      const conclusion: Outcome = status.cancelled ? "cancelled" : status.failure ? "failure" : "success";
      return { conclusion, outcomes, logs, group, leftovers: group !== null && groupAlive(group) };
    } finally {
      group ??= readGroup(pidFile);
      if (group !== null && groupAlive(group)) process.kill(-group, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function readGroup(pidFile: string): number | null {
    try {
      return Number(readFileSync(pidFile, "utf8").trim());
    } catch {
      return null;
    }
  }

  const checks = [
    "Typecheck",
    "Lint (family standard + architecture walls)",
    "Production Docker image build",
    "Startup capability manifest smoke",
  ];

  it("passes on the PC only when both branches pass, and reaps the unit tests' process group", () => {
    const run = simulateStatic({ environment: "self-hosted", unitExit: 0 });
    expect(run.conclusion).toBe("success");
    expect(run.outcomes).toMatchObject({ [start]: "success", Typecheck: "success", [unit]: "success", [stop]: "success" });
    expect(run.logs[unit]).toContain("pnpm test:unit --maxWorkers=4\nunit tests finished\n");
    expect(run.group).not.toBeNull();
    expect(run.leftovers).toBe(false);
  });

  it.each(checks)("on the PC, a failed %s fails the job and the unit tests still report", failAt => {
    for (const unitExit of [0, 1]) {
      const run = simulateStatic({ environment: "self-hosted", failAt, unitExit });
      expect(run.conclusion, `${failAt} unit=${unitExit}`).toBe("failure");
      expect(run.outcomes[failAt]).toBe("failure");
      expect(run.outcomes[unit]).toBe(unitExit === 0 ? "success" : "failure");
      expect(run.logs[unit]).toContain("pnpm test:unit --maxWorkers=4\nunit tests finished\n");
      expect(run.outcomes[stop]).toBe("success");
      expect(run.outcomes["Remove this run's image"]).toBe("success");
      expect(run.leftovers).toBe(false);
    }
  });

  it("on the PC, failed unit tests fail the job with their log in the joining step", () => {
    const run = simulateStatic({ environment: "self-hosted", unitExit: 3 });
    expect(run.conclusion).toBe("failure");
    expect(run.outcomes).toMatchObject({ Typecheck: "success", "Startup capability manifest smoke": "success", [unit]: "failure" });
    expect(run.logs[unit]).toContain("unit tests finished\n");
    expect(run.leftovers).toBe(false);
  });

  it("on the PC, unit tests that die without an exit status fail the job", () => {
    const run = simulateStatic({ environment: "self-hosted", unitExit: "killed" });
    expect(run.conclusion).toBe("failure");
    expect(run.outcomes[unit]).toBe("failure");
    expect(run.logs[unit]).toContain("::error::unit-tests ended without recording an exit status");
    expect(run.leftovers).toBe(false);
  });

  it("a stale contract fails the job before the unit tests start", () => {
    const run = simulateStatic({ environment: "self-hosted", failAt: contracts, unitExit: 0 });
    expect(run.conclusion).toBe("failure");
    expect(run.outcomes).toMatchObject({ [start]: "skipped", Typecheck: "skipped", [unit]: "skipped", [stop]: "success" });
    expect(run.group).toBeNull();
  });

  it("a cancelled job skips the join, prints what the unit tests logged and kills their process group", () => {
    const run = simulateStatic({ environment: "self-hosted", cancelAt: "Production Docker image build", unitExit: 0, unitSeconds: 60 });
    expect(run.conclusion).toBe("cancelled");
    expect(run.outcomes).toMatchObject({ "Chromium Headless Shell runtime smoke": "skipped", [unit]: "skipped", [stop]: "success",
      "Remove this run's image": "success" });
    expect(run.logs[stop]).toContain("unit-tests was still running; its log so far:\npnpm test:unit --maxWorkers=4\n");
    expect(run.group).not.toBeNull();
    expect(run.leftovers).toBe(false);
  });

  it.each([
    // failAt, unit tests' exit, conclusion, unit tests' step
    [undefined, 0, "success", "success"],
    [undefined, 1, "failure", "failure"],
    // Hosted keeps the old order: a failed check skips the unit tests.
    ["Typecheck", 0, "failure", "skipped"],
    ["Startup capability manifest smoke", 0, "failure", "skipped"],
  ] as const)("hosted: failed check %s, unit tests exit %s → %s, unit tests %s", (failAt, unitExit, conclusion, unitOutcome) => {
    const run = simulateStatic({ environment: "github-hosted", ...(failAt ? { failAt } : {}), unitExit });
    expect(run.conclusion).toBe(conclusion);
    expect(run.outcomes[start]).toBe("skipped");
    expect(run.outcomes[unit]).toBe(unitOutcome);
    if (unitOutcome !== "skipped") expect(run.logs[unit]).toBe("pnpm test:unit --maxWorkers=2\nunit tests finished\n");
    expect(run.outcomes[stop]).toBe("success");
    expect(run.group).toBeNull();
  });
});

describe("CI integration shards", () => {
  const shardTotal = "${{ needs.fingerprint.outputs.shard_total || 3 }}";
  const dbStepName = `Sync-critical DB/schema/network tests (shard \${{ matrix.shard }}/${shardTotal})`;

  // The fingerprint job runs first on every gate run, so it plans the matrix.
  it("plans the matrix in the fingerprint job from the pool, the attempt and CI_PC_SHARDS", () => {
    const fingerprint = job("fingerprint");
    expect(fingerprint.outputs).toEqual({
      hash: "${{ steps.fingerprint.outputs.hash }}",
      proven_by: "${{ steps.lookup.outputs.proven_by }}",
      integration_hash: "${{ steps.fingerprint.outputs.integration_hash }}",
      integration_proven_by: "${{ steps.lookup.outputs.integration_proven_by }}",
      shards: "${{ steps.shards.outputs.shards }}",
      shard_total: "${{ steps.shards.outputs.shard_total }}",
    });
    const plan = step("fingerprint", "Plan integration shards");
    expect(plan.id).toBe("shards");
    expect(plan.if).toBeUndefined();
    expect(shell(plan)).toBe("node scripts/ci-shards.mjs");
    expect(plan.env).toEqual({
      CI_POOL: "${{ vars.CI_POOL }}",
      RUN_ATTEMPT: "${{ github.run_attempt }}",
      CI_PC_SHARDS: "${{ vars.CI_PC_SHARDS }}",
    });
    const names = fingerprint.steps.map(item => item.name);
    expect(names.indexOf("Plan integration shards")).toBeGreaterThan(names.indexOf("Checkout"));
  });

  it("keeps the matrix, names and shard command on the planned total", () => {
    const integration = job("integration");
    expect(integration.needs).toEqual(["fingerprint"]);
    expect(integration.name).toBe(`Integration \${{ matrix.shard }}/${shardTotal}`);
    expect(integration.strategy?.matrix).toEqual({ shard: "${{ fromJSON(needs.fingerprint.outputs.shards || '[1,2,3]') }}" });
    expect(integration.strategy?.["fail-fast"]).toBe("${{ github.event_name == 'pull_request' }}");
    expect(shell(step("integration", dbStepName))).toBe(`pnpm test:sync-critical:db --shard=\${{ matrix.shard }}/${shardTotal}`);
    // The API suite is one file: it runs on the first shard only.
    const api = step("integration", "Sync-critical API tests");
    expect(api.if).toBe("matrix.shard == 1");
    expect(shell(api)).toBe("pnpm test:sync-critical:api");
  });

  it.each([
    // fail-fast on a PR only: main keeps the record of every shard.
    ["pull_request", "true"],
    ["push", "false"],
    ["workflow_dispatch", "false"],
  ] as const)("fail-fast on %s is %s", (event, failFast) => {
    expect(field(String(job("integration").strategy?.["fail-fast"]), eventContext({ event }))).toBe(failFast);
  });

  it.each([
    // CI_POOL, run attempt, CI_PC_SHARDS, planned total
    ["pc", "1", "6", 6],
    ["pc", "1", "1", 1],
    ["pc", "1", "8", 8],
    ["pc", "1", "", 3],
    ["pc", "1", "9", 3],
    ["pc", "1", "lots", 3],
    ["pc", "2", "6", 3],
    ["", "1", "6", 3],
    ["hosted", "1", "", 3],
  ] as const)("CI_POOL=%s attempt %s CI_PC_SHARDS=%j runs %i shards that cover every file once", (pool, attempt, pcShards, total) => {
    const context = eventContext({ pool, attempt, pcShards });
    const plan = step("fingerprint", "Plan integration shards");
    const env = Object.fromEntries(Object.entries(plan.env ?? {}).map(([key, value]) => [key, field(value, context)]));
    const planned = planShards(env);
    expect(planned.total).toBe(total);
    const outputs = { shards: JSON.stringify(planned.shards), shardTotal: String(planned.total) };
    const matrix = job("integration").strategy?.matrix?.shard;
    if (typeof matrix !== "string") throw new Error("integration matrix must be one expression");
    const legs = runner(matrix, eventContext({ pool, attempt, ...outputs }));
    expect(legs).toEqual(Array.from({ length: total }, (_, index) => index + 1));
    if (!Array.isArray(legs)) throw new Error("integration matrix must be a list");
    const commands = legs.map(shard => field(shell(step("integration", dbStepName)), eventContext({ ...outputs, shard: Number(shard) })));
    expect(commands).toEqual(legs.map(shard => `pnpm test:sync-critical:db --shard=${String(shard)}/${total}`));
    const names = legs.map(shard => field(job("integration").name ?? "", eventContext({ ...outputs, shard: Number(shard) })));
    expect(names).toEqual(legs.map(shard => `Integration ${String(shard)}/${total}`));
    expect(legs.filter(shard => condition(step("integration", "Sync-critical API tests").if, eventContext({ ...outputs, shard: Number(shard) })))).toEqual([1]);
  });

  // The integration job needs a successful fingerprint job, which always sets
  // both outputs; the fallback only keeps fromJSON off an empty string.
  it("falls back to the default three shards consistently when the plan outputs are empty", () => {
    const empty = eventContext({ shards: "", shardTotal: "" });
    const matrix = String(job("integration").strategy?.matrix?.shard);
    expect(runner(matrix, empty)).toEqual(planShards({}).shards);
    expect(planShards({}).total).toBe(DEFAULT_SHARD_TOTAL);
    for (const shard of [1, 2, 3]) {
      const context = eventContext({ shards: "", shardTotal: "", shard });
      expect(field(job("integration").name ?? "", context)).toBe(`Integration ${shard}/${DEFAULT_SHARD_TOTAL}`);
      expect(field(shell(step("integration", dbStepName)), context)).toBe(`pnpm test:sync-critical:db --shard=${shard}/${DEFAULT_SHARD_TOTAL}`);
    }
  });
});

describe("Decision 377: every event keeps the required check reported", () => {
  // A required check is resolved against the NEWEST check suite for the head
  // SHA. A description edit or a label starts a run on that same SHA, so a run
  // that renames or skips this job strips "Quality Gate" off the head and the
  // PR becomes unmergeable with every check green (Decision 377). The name is a
  // literal and the job runs in every event; only the path inside it differs.
  it("listens to exactly the events these tables cover", () => {
    expect(workflow.on.pull_request.types).toEqual(["opened", "synchronize", "reopened", "ready_for_review", "converted_to_draft", "edited", "labeled"]);
  });

  it.each([
    // action, changes.title, changes.base, added label, concurrency group, gate jobs run
    ["edited", false, false, null, "ci-ref-metadata", false],
    ["edited", true, false, null, "ci-ref", true],
    ["edited", false, true, null, "ci-ref", true],
    ["edited", true, true, null, "ci-ref", true],
    ["synchronize", false, false, null, "ci-ref", true],
    ["opened", false, false, null, "ci-ref", true],
    ["reopened", false, false, null, "ci-ref", true],
    ["ready_for_review", false, false, null, "ci-ref", true],
    ["converted_to_draft", false, false, null, "ci-ref", true],
    // ci:full asks for the full gate: a real run that may cancel the static-only one.
    ["labeled", false, false, "ci:full", "ci-ref", true],
    // Any other label is metadata: mirror the head's verdict, cancel nothing.
    ["labeled", false, false, "needs-review", "ci-ref-metadata", false],
    ["labeled", false, false, "ci:fuller", "ci-ref-metadata", false],
  ] as const)("%s title=%s base=%s label=%s keeps the required check reported", (action, title, base, label, expectedGroup, gateJobsRun) => {
    const labels = label ? [label] : [];
    const context = eventContext({ action, titleChanged: title, baseChanged: base, label, labels });
    // No expression may reach the check's name: GitHub reported the raw text.
    expect(job("quality").name).toBe("Quality Gate");
    expect(field(job("quality").name ?? "", context)).toBe("Quality Gate");
    expect(condition(job("quality").if, context)).toBe(true);
    expect(field(workflow.concurrency.group, context)).toBe(expectedGroup);
    expect(condition(job("fingerprint").if, context)).toBe(gateJobsRun);
    // Exactly one path inside the job runs: aggregate this run's gate jobs, or
    // mirror an earlier run's verdict for the same head.
    const metadataOnly = field(job("quality").env?.METADATA_ONLY ?? "", context);
    expect(metadataOnly).toBe(String(!gateJobsRun));
    const stepContext = { ...context, "env.METADATA_ONLY": metadataOnly };
    expect(condition(step("quality", "Every gate job succeeded").if, stepContext)).toBe(gateJobsRun);
    for (const name of ["Checkout", "An earlier run already passed this head"]) {
      expect(condition(step("quality", name).if, stepContext), name).toBe(!gateJobsRun);
    }
  });

  it.each(["push", "workflow_dispatch"] as const)("a %s run is never metadata-only", event => {
    const context = eventContext({ event });
    expect(field(workflow.concurrency.group, context)).toBe("ci-35518904235");
    expect(condition(job("fingerprint").if, context)).toBe(true);
    expect(field(job("quality").env?.METADATA_ONLY ?? "", context)).toBe("false");
  });

  // GitHub keeps ONE pending run per concurrency group and cancels the older
  // pending one when another arrives, whatever cancel-in-progress says. A
  // shared ref group therefore let a burst of main pushes evict the queued
  // ones before they ran. Every push and manual run gets a group of its own;
  // runs of one PR still share theirs, and only there does a newer run cancel.
  it("gives every push and manual run its own group and cancels superseded PR runs only", () => {
    expect(workflow.concurrency.group.startsWith("ci-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}")).toBe(true);
    const group = (options: EventOptions, runId: string) =>
      field(workflow.concurrency.group, { ...eventContext(options), "github.run_id": runId });
    for (const event of ["push", "workflow_dispatch"] as const) {
      expect(group({ event }, "101"), event).toBe("ci-101");
      expect(group({ event }, "102"), event).not.toBe(group({ event }, "101"));
    }
    expect(group({ event: "push" }, "101")).not.toBe(group({ event: "workflow_dispatch" }, "102"));
    // Two pushes to one PR share its group, so the newer run cancels the older;
    // a metadata-only event keeps its own group and cancels nothing.
    for (const action of ["synchronize", "opened", "ready_for_review"]) {
      expect(group({ action }, "101"), action).toBe("ci-ref");
      expect(group({ action }, "102"), action).toBe("ci-ref");
    }
    expect(group({ action: "edited" }, "102")).toBe("ci-ref-metadata");
    for (const [event, cancel] of [["pull_request", "true"], ["push", "false"], ["workflow_dispatch", "false"]] as const) {
      expect(field(workflow.concurrency["cancel-in-progress"], eventContext({ event })), event).toBe(cancel);
    }
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
});

describe("CI production image checks", () => {
  it("builds only once, loads the image for the smoke tests and records its revision", () => {
    expect(job("static").steps.some(item => item.run?.includes("pnpm build:artifacts"))).toBe(false);
    const build = step("static", "Production Docker image build");
    expect(build.with).toMatchObject({ context: ".", load: true, pull: true, platforms: "linux/amd64", target: "runtime" });
    expect(build.with?.["build-args"]).toBe([
      "APP_SOURCE_REVISION=${{ steps.metadata.outputs.source_revision }}",
      "APP_DEPENDENCY_CHECKSUM=${{ steps.metadata.outputs.dependency_checksum }}",
      "CI_TYPECHECK_ALREADY_PASSED=true",
      "",
    ].join("\n"));
    expect(step("static", "Exact checkout image metadata").id).toBe("metadata");
    expect(shell(step("static", "Exact checkout image metadata"))).toContain("bash scripts/deploy-metadata.sh");
    // The typecheck the image build skips must run earlier in the same job.
    const names = job("static").steps.map(item => item.name);
    expect(names.indexOf("Typecheck")).toBeGreaterThan(-1);
    expect(names.indexOf("Typecheck")).toBeLessThan(names.indexOf("Production Docker image build"));
    for (const smoke of ["Chromium Headless Shell runtime smoke", "Native image library smoke", "Startup capability manifest smoke"]) {
      expect(names.indexOf(smoke), smoke).toBeGreaterThan(names.indexOf("Production Docker image build"));
    }
  });

  it.each([
    ["[]", true],
    ['["desktop-lifecycle-v2"]', true],
    ['["future-capability-v3"]', true],
    ['["capability",42]', false],
    ['{"capabilities":[]}', false],
    ["not JSON", false],
  ] as const)("capability smoke validates manifest %s without freezing its vocabulary", (manifest, allowed) => {
    const script = `docker() { [ "$5" = "$IMAGE" ] || return 9; printf '%s\\n' "$TEST_CAPABILITIES"; }\n${shell(step("static", "Startup capability manifest smoke"))}`;
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      encoding: "utf8",
      env: { ...process.env, TEST_CAPABILITIES: manifest, IMAGE: "agency_hub_core/runtime:ci-1-1" },
    });
    expect(result.status === 0, result.stderr).toBe(allowed);
    if (allowed) expect(result.stdout).toBe(`${manifest}\n`);
  });
});
