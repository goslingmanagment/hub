import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import type { TestSpecification, Vitest } from "vitest/node";

import { mirrorEarlierGate } from "../scripts/ci-mirror-gate.mjs";
import { DEFAULT_SHARD_TOTAL, planShards } from "../scripts/ci-shards.mjs";
import vitestConfig from "../vitest.config.ts";
import { syncCriticalDbFiles } from "./helpers/sync-critical-files.ts";
import { WeightedShardSequencer, shardKey } from "./helpers/weighted-shard-sequencer.ts";

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

  // Every check in the static job runs whenever the job runs. Only the
  // runner-specific pnpm setup (see "CI self-hosted setup" below), the
  // background starts of the unit tests and the lint, their joins and the
  // cleanup have conditions of their own; see "CI static job" below for how
  // those behave.
  it("runs every static check, the image build and all three smoke tests whenever static runs", () => {
    const steps = job("static").steps;
    const conditional = steps.filter(item => item.if !== undefined);
    expect(conditional.map(item => [item.name, item.if])).toEqual([
      ["Setup pnpm", "runner.environment != 'self-hosted'"],
      ["Setup pnpm (corepack)", "runner.environment == 'self-hosted'"],
      ["Start reliable unit tests in the background", "runner.environment == 'self-hosted'"],
      ["Start lint in the background", "runner.environment == 'self-hosted'"],
      ["Lint (family standard + architecture walls)", "!cancelled() && (success() || steps.lint.outputs.started == 'true')"],
      ["Reliable unit tests", "!cancelled() && (success() || steps.unit-tests.outputs.started == 'true')"],
      ["Stop background unit tests", "always()"],
      ["Stop background lint", "always()"],
      ["Remove this run's image", "always()"],
    ]);
    expect(steps.at(-1)?.name).toBe("Remove this run's image");
    for (const name of [
      "Typecheck",
      "Contracts are regenerated (routes.ts ↔ committed artifacts)",
      "Exact checkout image metadata",
      "Production Docker image build",
      "Chromium Headless Shell runtime smoke",
      "Native image library smoke",
      "Startup capability manifest smoke",
    ]) {
      expect(step("static", name).if, name).toBeUndefined();
    }
    // Hosted, or self-hosted with nothing failed so far: the lint's and the
    // unit tests' steps run exactly as unconditional steps would.
    for (const runnerEnvironment of ["github-hosted", "self-hosted"] as const) {
      const started = runnerEnvironment === "self-hosted" ? "true" : "";
      const context = { ...eventContext({ runnerEnvironment }), "steps.unit-tests.outputs.started": started, "steps.lint.outputs.started": started };
      for (const name of ["Lint (family standard + architecture walls)", "Reliable unit tests"]) {
        expect(stepRuns(step("static", name), context, PASSING), `${runnerEnvironment}: ${name}`).toBe(true);
      }
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
  // The PC's runner classes (see the ci-runners README): heavy jobs ask for
  // ci-pc, the two gate jobs for ci-pc-control.
  const heavy = ["self-hosted", "ci-pc"];
  const control = ["self-hosted", "ci-pc-control"];

  // Every job of both workflows follows CI_POOL, the gate's own fingerprint
  // and Quality Gate included: with CI_POOL=pc nothing runs on a billed runner
  // on a first attempt.
  it.each([
    // CI_POOL, run attempt, fingerprint + Quality Gate, static, integration, nightly jobs
    ["pc", "1", control, heavy, heavy, heavy],
    // Re-runs always go hosted: the PC may have died mid-run.
    ["pc", "2", "ubuntu-slim", "ubuntu-24.04", "ubuntu-24.04-arm", "ubuntu-24.04"],
    ["pc", "3", "ubuntu-slim", "ubuntu-24.04", "ubuntu-24.04-arm", "ubuntu-24.04"],
    ["", "1", "ubuntu-slim", "ubuntu-24.04", "ubuntu-24.04-arm", "ubuntu-24.04"],
    ["hosted", "1", "ubuntu-slim", "ubuntu-24.04", "ubuntu-24.04-arm", "ubuntu-24.04"],
  ] as const)("CI_POOL=%s attempt %s routes the gate jobs to %j, static to %j, integration to %j and nightly to %j",
    (pool, attempt, gateRunner, staticRunner, integrationRunner, nightlyRunner) => {
      const context = eventContext({ pool, attempt });
      expect(runner(job("fingerprint")["runs-on"], context)).toEqual(gateRunner);
      expect(runner(job("quality")["runs-on"], context)).toEqual(gateRunner);
      expect(runner(job("static")["runs-on"], context)).toEqual(staticRunner);
      expect(runner(job("integration")["runs-on"], context)).toEqual(integrationRunner);
      expect(Object.keys(nightly.jobs).sort()).toEqual(["api-remainder", "full-suite"]);
      for (const [name, config] of Object.entries(nightly.jobs)) {
        expect(runner(config["runs-on"], context), name).toEqual(nightlyRunner);
      }
    },
  );

  it("keeps the canonical pool expression and pins every hosted image", () => {
    const pool = (pcLabel: string, fallback: string) =>
      `\${{ vars.CI_POOL == 'pc' && github.run_attempt == '1' && fromJSON('["self-hosted","${pcLabel}"]') || '${fallback}' }}`;
    expect(job("static")["runs-on"]).toBe(pool("ci-pc", "ubuntu-24.04"));
    expect(job("integration")["runs-on"]).toBe(pool("ci-pc", "ubuntu-24.04-arm"));
    // Seconds-long jobs without Docker fall back to the cheapest runner.
    expect(job("fingerprint")["runs-on"]).toBe(pool("ci-pc-control", "ubuntu-slim"));
    expect(job("quality")["runs-on"]).toBe(pool("ci-pc-control", "ubuntu-slim"));
    expect(job("fingerprint")).toHaveProperty("timeout-minutes", 5);
    expect(job("quality")).toHaveProperty("timeout-minutes", 5);
    // ubuntu-latest moves to a new release on GitHub's schedule, not ours.
    expect(workflowText).not.toContain("ubuntu-latest");
    for (const [name, config] of Object.entries(nightly.jobs)) {
      expect(config["runs-on"], name).toBe(pool("ci-pc", "ubuntu-24.04"));
    }
  });

  // Hub's heavy runners carry ci-pc and ci-pc-control, its light gate runners
  // only ci-pc-control, and a runner takes a job only when it carries every
  // label the job asks for. So the heavy runners take every
  // job (the gates fall back to them while the light ones are busy or down),
  // and nothing but the two gates ever lands on a light runner.
  it("lets only the two gate jobs onto the light runners and every job onto the heavy ones", () => {
    const heavyRunner = ["self-hosted", "Linux", "X64", "ci-pc", "ci-pc-control"];
    const lightRunner = ["self-hosted", "Linux", "X64", "ci-pc-control"];
    const takes = (runnerLabels: string[], labels: Value) =>
      Array.isArray(labels) && labels.every(label => typeof label === "string" && runnerLabels.includes(label));
    const context = eventContext({ pool: "pc", attempt: "1" });
    const jobs: [string, Job][] = [
      ...Object.entries(workflow.jobs).map(([name, config]): [string, Job] => [`ci ${name}`, config]),
      ...Object.entries(nightly.jobs).map(([name, config]): [string, Job] => [`nightly ${name}`, config]),
    ];
    const gates = ["ci fingerprint", "ci quality"];
    const onLight: string[] = [];
    for (const [name, config] of jobs) {
      const labels = runner(config["runs-on"], context);
      expect(takes(heavyRunner, labels), name).toBe(true);
      if (takes(lightRunner, labels)) onLight.push(name);
      else expect(labels, name).toEqual(heavy);
      // No other job names the control class in any branch of its runs-on.
      expect(JSON.stringify(config["runs-on"]).includes("ci-pc-control"), name).toBe(gates.includes(name));
    }
    expect(onLight).toEqual(gates);
  });

  // The PC image has no Node.js on PATH and no GitHub CLI (its WSL distro
  // `ci`, checked 2026-09-29). A step on a self-hosted runner may run node,
  // pnpm or corepack only after a setup-node step ran in that job, whichever
  // path the job takes; and no step anywhere calls the GitHub CLI — the gate
  // scripts read the API through Node's fetch (tests/ci-github-api.test.ts).
  it("sets Node up before any PC step runs it, and calls no GitHub CLI", () => {
    const runsNode = /(?:^|[\s;&|(])(?:node|pnpm|corepack)\s/m;
    const jobs: [string, Job][] = [
      ...Object.entries(workflow.jobs).map(([name, config]): [string, Job] => [`ci ${name}`, config]),
      ...Object.entries(nightly.jobs).map(([name, config]): [string, Job] => [`nightly ${name}`, config]),
    ];
    let checked = 0;
    for (const [name, config] of jobs) {
      for (const metadataOnly of ["true", "false"]) {
        const context = {
          ...eventContext({ runnerEnvironment: "self-hosted" }),
          "env.METADATA_ONLY": metadataOnly,
          "steps.unit-tests.outputs.started": "true",
          "steps.lint.outputs.started": "true",
          "needs.integration.result": "success",
        };
        let nodeReady = false;
        for (const item of config.steps) {
          if (!stepRuns(item, context, PASSING)) continue;
          if (item.uses?.startsWith("actions/setup-node@")) nodeReady = true;
          if (item.run && runsNode.test(item.run)) {
            expect(nodeReady, `${name} (metadata-only ${metadataOnly}): ${item.name}`).toBe(true);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
    // A command position: a line start, or after ;, &, | or $( — not advice
    // inside a message, such as the economy hint's "run: gh pr edit".
    const ghCommand = /(?:^|[;&|]|\$\()\s*gh\s/m;
    expect(ghCommand.test("run: gh pr edit 7")).toBe(false);
    expect(ghCommand.test("x=$(gh api repos)")).toBe(true);
    for (const [name, config] of jobs) {
      for (const item of config.steps) expect(item.run ?? "", `${name}: ${item.name}`).not.toMatch(ghCommand);
    }
  });

  // The gate jobs need Node only for their scripts: the fingerprint job always,
  // the Quality Gate only on the metadata-only path (the mirror). Hosted
  // ubuntu-slim ships Node, so only the PC sets it up — from the runner's tool
  // cache, without a pnpm install or a dependency cache.
  it.each([
    // job, METADATA_ONLY, runner, steps that run up to and including the first Node script
    ["fingerprint", "false", "github-hosted", ["Checkout", "Plan integration shards"]],
    ["fingerprint", "false", "self-hosted", ["Checkout", "Setup Node.js", "Plan integration shards"]],
    ["quality", "true", "github-hosted", ["Checkout", "An earlier run already passed this head"]],
    ["quality", "true", "self-hosted", ["Checkout", "Setup Node.js", "An earlier run already passed this head"]],
  ] as const)("%s (metadata-only %s) on %s runs %j", (name, metadataOnly, runnerEnvironment, expected) => {
    const context = { ...eventContext({ runnerEnvironment }), "env.METADATA_ONLY": metadataOnly, "needs.integration.result": "success" };
    const ran = job(name).steps.filter(item => stepRuns(item, context, PASSING)).map(item => item.name);
    expect(ran.slice(0, expected.length)).toEqual(expected);
    const setup = step(name, "Setup Node.js");
    expect(setup.uses).toBe("actions/setup-node@v6");
    expect(setup.with).toEqual({ "node-version": 22 });
    expect(setup.if).toBe(name === "fingerprint"
      ? "runner.environment == 'self-hosted'"
      : "env.METADATA_ONLY == 'true' && runner.environment == 'self-hosted'");
  });

  it("the Quality Gate's aggregating path runs no Node and sets none up", () => {
    for (const runnerEnvironment of ["github-hosted", "self-hosted"] as const) {
      const context = { ...eventContext({ runnerEnvironment }), "env.METADATA_ONLY": "false", "needs.integration.result": "success" };
      expect(job("quality").steps.filter(item => stepRuns(item, context, PASSING)).map(item => item.name), runnerEnvironment).toEqual([
        "Every gate job succeeded",
        "Record this fingerprint as proven",
        "Publish the proof for later identical trees",
        "Publish fresh integration proof",
      ]);
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

    // Hosted runners only: pnpm/action-setup wipes its dest, so each job
    // installs pnpm under its own runner.temp; only hosted runners restore the
    // store from the Actions cache.
    for (const name of ["static", "integration"]) {
      const pnpm = job(name).steps.find(item => item.uses?.startsWith("pnpm/action-setup@"));
      expect(pnpm?.with, name).toEqual({ dest: "${{ runner.temp }}/setup-pnpm" });
      expect(pnpm?.if, name).toBe("runner.environment != 'self-hosted'");
      const node = job(name).steps.find(item => item.uses?.startsWith("actions/setup-node@"));
      expect(node?.with?.["node-version"], name).toBe(22);
      for (const [environment, cache] of [["github-hosted", "pnpm"], ["self-hosted", ""]] as const) {
        expect(field(String(node?.with?.cache), eventContext({ runnerEnvironment: environment })), `${name} ${environment}`).toBe(cache);
      }
    }
  });

  // docker/build-push-action's post step exports the build record from the
  // daemon's history, uploads it as an artifact and writes a job summary.
  // The PC skips both; hosted runners get an empty value, which the action
  // reads as unset, so they keep its defaults — and no job-wide value
  // overrides that.
  it("skips the build summary and the build record upload only on self-hosted runners", () => {
    const pcOnly = "${{ runner.environment == 'self-hosted' && 'false' || '' }}";
    expect(step("static", "Production Docker image build").env).toEqual({ DOCKER_BUILD_SUMMARY: pcOnly, DOCKER_BUILD_RECORD_UPLOAD: pcOnly });
    for (const [environment, value] of [["github-hosted", ""], ["self-hosted", "false"]] as const) {
      expect(field(pcOnly, eventContext({ runnerEnvironment: environment })), environment).toBe(value);
    }
    expect(Object.keys(job("static").env ?? {})).toEqual(["NODE_OPTIONS", "IMAGE"]);
  });

  // The PC shares one explicitly named store in $HOME (safe for concurrent
  // installs); hosted runners keep pnpm's default store, the one setup-node
  // caches.
  it.each(["static", "integration"])("%s installs from the shared store only on self-hosted runners", name => {
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

describe("CI self-hosted setup: pnpm from Node's corepack", () => {
  const setupSteps = (config: Job) => config.steps.slice(0, config.steps.findIndex(item => item.name === "Install dependencies") + 1);
  // Every job that installs the workspace, in either workflow.
  const installing: [string, Job][] = [
    ["static", job("static")],
    ["integration", job("integration")],
    ...Object.entries(nightly.jobs).map(([name, config]): [string, Job] => [`nightly ${name}`, config]),
  ];

  it("gives every installing job the same checkout, pnpm setup and install", () => {
    expect(setupSteps(job("static")).map(item => item.name)).toEqual([
      "Checkout",
      "Setup pnpm",
      "Setup Node.js",
      "Setup pnpm (corepack)",
      "Install dependencies",
    ]);
    expect(installing.map(([name]) => name)).toEqual(["static", "integration", "nightly api-remainder", "nightly full-suite"]);
    for (const [name, config] of installing) expect(setupSteps(config), name).toEqual(setupSteps(job("static")));
  });

  // Hosted runners keep exactly the previous setup; the PC swaps
  // pnpm/action-setup for corepack.
  it.each([
    ["github-hosted", [
      ["Checkout", "actions/checkout@v6", {}],
      ["Setup pnpm", "pnpm/action-setup@v6", { dest: "/runner/_temp/setup-pnpm" }],
      ["Setup Node.js", "actions/setup-node@v6", { "node-version": "22", cache: "pnpm" }],
      ["Install dependencies", "run", {}],
    ]],
    ["self-hosted", [
      ["Checkout", "actions/checkout@v6", {}],
      ["Setup Node.js", "actions/setup-node@v6", { "node-version": "22", cache: "" }],
      ["Setup pnpm (corepack)", "run", {}],
      ["Install dependencies", "run", {}],
    ]],
  ] as const)("on %s runs exactly one pnpm setup", (runnerEnvironment, expected) => {
    const context = eventContext({ runnerEnvironment });
    for (const [name, config] of installing) {
      const ran = setupSteps(config).filter(item => stepRuns(item, context, PASSING)).map(item => [
        item.name,
        item.uses ?? "run",
        Object.fromEntries(Object.entries(item.with ?? {}).map(([key, value]) => [key, field(String(value), context)])),
      ]);
      expect(ran, name).toEqual(expected);
    }
  });

  const corepackStep = step("static", "Setup pnpm (corepack)");
  const pinned = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { packageManager: string }).packageManager;

  function runCorepackStep(pnpmVersion: string, cwd = fileURLToPath(new URL("../", import.meta.url))) {
    const dir = mkdtempSync(path.join(tmpdir(), "hub-ci-corepack-"));
    try {
      const stubs = path.join(dir, "stubs");
      const runnerTemp = path.join(dir, "temp");
      mkdirSync(stubs);
      mkdirSync(runnerTemp);
      const calls = path.join(dir, "calls");
      // `corepack enable pnpm --install-directory DIR` writes a pnpm shim into
      // DIR; that shim stands in for the pnpm corepack would run.
      writeFileSync(path.join(stubs, "corepack"), [
        "#!/usr/bin/env bash",
        `echo "corepack $*" >> ${JSON.stringify(calls)}`,
        '[ "$1" = --version ] && { echo 0.36.0; exit 0; }',
        '[ "$1 $2 $3" = "enable pnpm --install-directory" ] && [ -d "$4" ] || exit 9',
        `printf '%s\\n' '#!/usr/bin/env bash' 'echo "pnpm $* COREPACK_DEFAULT_TO_LATEST=$COREPACK_DEFAULT_TO_LATEST" >> ${JSON.stringify(calls)}' 'echo ${pnpmVersion}' > "$4/pnpm"`,
        'chmod +x "$4/pnpm"',
        "",
      ].join("\n"));
      chmodSync(path.join(stubs, "corepack"), 0o755);
      const githubPath = path.join(dir, "github-path");
      writeFileSync(githubPath, "");
      const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", shell(corepackStep)], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, ...corepackStep.env, PATH: `${stubs}:${process.env.PATH ?? ""}`, RUNNER_TEMP: runnerTemp, GITHUB_PATH: githubPath },
      });
      return {
        status: result.status,
        output: result.stdout + result.stderr,
        githubPath: readFileSync(githubPath, "utf8").replaceAll(runnerTemp, "$RUNNER_TEMP"),
        calls: readFileSync(calls, "utf8").replaceAll(runnerTemp, "$RUNNER_TEMP").split("\n").filter(Boolean),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("puts corepack's pnpm first on PATH only when it is the version package.json pins", () => {
    expect(corepackStep.if).toBe("runner.environment == 'self-hosted'");
    expect(corepackStep.env).toEqual({ COREPACK_DEFAULT_TO_LATEST: "0" });
    // corepack itself may append "+sha512.<hash>" to the pin when it updates pnpm.
    expect(pinned).toMatch(/^pnpm@\d+\.\d+\.\d+(\+sha\d+\.[0-9a-f]+)?$/);
    const version = pinned.replace(/^pnpm@/, "").replace(/\+.*/, "");

    const ok = runCorepackStep(version);
    expect(ok.status, ok.output).toBe(0);
    expect(ok.githubPath).toBe("$RUNNER_TEMP/corepack-bin\n");
    expect(ok.calls).toEqual([
      "corepack enable pnpm --install-directory $RUNNER_TEMP/corepack-bin",
      // The call that may download pnpm leaves the shared lastKnownGood.json alone.
      "pnpm --version COREPACK_DEFAULT_TO_LATEST=0",
      "corepack --version",
    ]);
    expect(ok.output).toContain(`corepack 0.36.0 runs pnpm ${version}; package.json pins ${pinned}`);

    const drifted = runCorepackStep("11.0.0");
    expect(drifted.status).toBe(1);
    expect(drifted.output).toContain(`::error::corepack runs pnpm 11.0.0 but package.json pins ${pinned}`);
    expect(drifted.githubPath).toBe("");
  });

  it("accepts a packageManager pin that carries a hash", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hub-ci-corepack-pin-"));
    try {
      writeFileSync(path.join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@10.33.1+sha512.0123abcd" }));
      const run = runCorepackStep("10.33.1", dir);
      expect(run.status, run.output).toBe(0);
      expect(run.githubPath).toBe("$RUNNER_TEMP/corepack-bin\n");
      expect(runCorepackStep("10.33.2", dir).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Nightly on the runner pool", () => {
  function nightlyJob(name: string): Job {
    const found = nightly.jobs[name];
    if (!found) throw new Error(`Missing nightly job: ${name}`);
    return found;
  }
  const afterInstall = (config: Job) => config.steps.slice(config.steps.findIndex(item => item.name === "Install dependencies") + 1);
  const suite = "Full test suite (unit + integration + rebuild proofs + ratchets)";

  // The daily/weekly split is unchanged by the pool: the api remainder six
  // days a week, the whole suite on Mondays and on manual dispatch.
  it("keeps the schedule split, timeouts and the daily command", () => {
    expect(nightlyJob("api-remainder").if).toBe("github.event_name == 'schedule' && github.event.schedule == '20 2 * * 0,2-6'");
    expect(nightlyJob("full-suite").if).toBe("github.event_name != 'schedule' || github.event.schedule == '20 2 * * 1'");
    expect(nightlyJob("api-remainder")).toHaveProperty("timeout-minutes", 20);
    expect(nightlyJob("full-suite")).toHaveProperty("timeout-minutes", 90);
    const daily = afterInstall(nightlyJob("api-remainder"));
    expect(daily.map(item => [item.name, item.run, item.if, item.env])).toEqual([
      ["Whole api.integration file (the part PRs do not run)", "pnpm test:api:full", undefined, undefined],
    ]);
    expect(afterInstall(nightlyJob("full-suite")).map(item => item.name)).toEqual([suite]);
  });

  // Vitest's default is CPUs - 1 workers: one on a 2-vCPU hosted runner, 23 on
  // the PC's 24 threads, all against the run's ONE Postgres cluster and inside
  // the 20 GB cap daytime CI shares. The PC runs four; hosted keeps the
  // default and the exact previous command.
  it.each([
    ["github-hosted", "", "test"],
    ["self-hosted", "4", "test --maxWorkers=4"],
  ] as const)("the full suite on %s runs `pnpm %s`", (runnerEnvironment, workers, argv) => {
    const run = afterInstall(nightlyJob("full-suite"))[0];
    if (!run) throw new Error("Missing full-suite step");
    expect(run.if).toBeUndefined();
    expect(run.env).toEqual({ PC_MAX_WORKERS: "${{ runner.environment == 'self-hosted' && '4' || '' }}" });
    const env = field(run.env?.PC_MAX_WORKERS ?? "", eventContext({ runnerEnvironment }));
    expect(env).toBe(workers);
    const script = `pnpm() { printf '%s|' "$@"; printf '\\n'; }\n${shell(run)}`;
    const { PC_MAX_WORKERS: _inherited, ...inherited } = process.env;
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], { encoding: "utf8", env: { ...inherited, PC_MAX_WORKERS: env } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${argv.split(" ").join("|")}|\n`);
    // `pnpm test` is one vitest command, so the flag reaches `vitest run`.
    const scripts = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts.test).toBe("NODE_OPTIONS=--max-old-space-size=8192 vitest run");
  });
});

describe("CI static job: unit tests and lint beside the image checks", () => {
  const start = "Start reliable unit tests in the background";
  const unit = "Reliable unit tests";
  const stop = "Stop background unit tests";
  const lintStart = "Start lint in the background";
  const lint = "Lint (family standard + architecture walls)";
  const lintStop = "Stop background lint";
  const contracts = "Contracts are regenerated (routes.ts ↔ committed artifacts)";
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));

  // Self-hosted: the unit tests start as soon as the tree is final and run in
  // a process group of their own beside typecheck → smokes; a later step
  // joins them. The contracts generator rewrites tracked sources the unit
  // tests import, so it runs before they start. The lint runs the same way
  // beside typecheck, and its own step joins it before the image build.
  // Hosted runners (2 vCPUs) keep linting in that step and running the unit
  // tests in the joining step, after the smokes.
  it("starts the unit tests and the lint after the contracts check, joins the lint before the image build and the unit tests after the smokes", () => {
    expect(job("static").steps.map(item => item.name)).toEqual([
      "Checkout",
      "Setup pnpm",
      "Setup Node.js",
      "Setup pnpm (corepack)",
      "Install dependencies",
      contracts,
      start,
      lintStart,
      "Typecheck",
      lint,
      "Exact checkout image metadata",
      "Set up Docker Buildx",
      "Production Docker image build",
      "Chromium Headless Shell runtime smoke",
      "Native image library smoke",
      "Startup capability manifest smoke",
      unit,
      stop,
      lintStop,
      "Remove this run's image",
    ]);
    expect(step("static", start).id).toBe("unit-tests");
    expect(shell(step("static", start))).toBe([
      "bash scripts/ci-background.sh start unit-tests pnpm test:unit --maxWorkers=5",
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
    // The lint: the same three steps, and the same command in both places.
    expect(step("static", lintStart).id).toBe("lint");
    expect(shell(step("static", lintStart))).toBe([
      "bash scripts/ci-background.sh start lint pnpm lint",
      'echo "started=true" >> "$GITHUB_OUTPUT"',
      "",
    ].join("\n"));
    expect(step("static", lint).env).toEqual({ IN_BACKGROUND: "${{ steps.lint.outputs.started }}" });
    expect(shell(step("static", lint))).toBe([
      'if [ "$IN_BACKGROUND" = "true" ]; then',
      "  bash scripts/ci-background.sh join lint",
      "else",
      "  pnpm lint",
      "fi",
      "",
    ].join("\n"));
    expect(shell(step("static", lintStop))).toBe("bash scripts/ci-background.sh stop lint");
  });

  type Scenario = {
    environment: "github-hosted" | "self-hosted";
    /** A check other than the background runs' own steps that fails. */
    failAt?: string;
    /** A check during which the job is cancelled. */
    cancelAt?: string;
    /** When the cancel lands: once the background runs logged something (default), or after they finished. */
    cancelWhen?: "logged" | "finished";
    /** The unit tests' exit status, or "killed": they die without recording one. */
    unitExit: number | "killed";
    /** How long the unit tests keep running, in seconds. */
    unitSeconds?: number;
    /** The lint's exit status (default 0), or "killed". */
    lintExit?: number | "killed";
    /** How long the lint keeps running, in seconds. */
    lintSeconds?: number;
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
  // outputs. The unit tests' and the lint's three steps each run their real
  // shells against a stub pnpm; every other step only passes, fails or is
  // cancelled as told.
  function simulateStatic(scenario: Scenario) {
    const dir = mkdtempSync(path.join(tmpdir(), "hub-ci-static-"));
    const pnpm = path.join(dir, "pnpm");
    writeFileSync(pnpm, [
      "#!/usr/bin/env bash",
      'echo "pnpm $*"',
      'case "$1" in',
      '  test:unit) seconds="$UNIT_SECONDS" code="$UNIT_EXIT" message="unit tests finished" ;;',
      '  lint) seconds="$LINT_SECONDS" code="$LINT_EXIT" message="lint finished" ;;',
      "  *) exit 0 ;;",
      "esac",
      // A child of its own, so the whole process group has to be reaped.
      'sleep "$seconds" & wait "$!"',
      'if [ "$code" = killed ]; then kill -KILL "$PPID"; exit 0; fi',
      'echo "$message"',
      'exit "$code"',
      "",
    ].join("\n"));
    chmodSync(pnpm, 0o755);
    const runnerTemp = path.join(dir, "temp");
    const pidFile = (name: string) => path.join(runnerTemp, "ci-background", `${name}.pid`);
    // Step outputs by step id, as `steps.<id>.outputs.<name>` reads them.
    const outputs: Record<string, Record<string, string>> = {};
    const context = (): Context => ({
      ...eventContext({ runnerEnvironment: scenario.environment }),
      "steps.unit-tests.outputs.started": outputs["unit-tests"]?.started ?? "",
      "steps.lint.outputs.started": outputs.lint?.started ?? "",
    });
    const status: JobStatus = { ...PASSING };
    const outcomes: Record<string, Outcome> = {};
    const logs: Record<string, string> = {};
    let group: number | null = null;
    let lintGroup: number | null = null;
    try {
      for (const item of job("static").steps) {
        if (!stepRuns(item, context(), status)) {
          outcomes[item.name] = "skipped";
          continue;
        }
        if (item.name === scenario.cancelAt) {
          // Cancelled once every background run has logged something, as a
          // real cancel lands well after they started — or after they finished.
          const finished = scenario.cancelWhen === "finished";
          for (const name of ["unit-tests", "lint"]) {
            if (!existsSync(pidFile(name))) continue;
            const marker = path.join(runnerTemp, "ci-background", `${name}.${finished ? "status" : "log"}`);
            const waited = spawnSync("bash", ["-c", 'for _ in $(seq 200); do [ -s "$1" ] && exit 0; sleep 0.05; done; exit 1', "wait", marker]);
            expect(waited.status, `${name} never ${finished ? "finished" : "logged"}`).toBe(0);
          }
          outcomes[item.name] = "cancelled";
          status.success = false;
          status.cancelled = true;
          continue;
        }
        let passed = item.name !== scenario.failAt;
        if ([start, unit, stop, lintStart, lint, lintStop].includes(item.name)) {
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
              LINT_EXIT: String(scenario.lintExit ?? 0), LINT_SECONDS: String(scenario.lintSeconds ?? 0.1),
            },
          });
          logs[item.name] = result.stdout + result.stderr;
          for (const line of readFileSync(githubOutput, "utf8").split("\n").filter(Boolean)) {
            const [key = "", ...value] = line.split("=");
            if (item.id) (outputs[item.id] ??= {})[key] = value.join("=");
          }
          passed = result.status === 0;
        }
        outcomes[item.name] = passed ? "success" : "failure";
        if (!passed) {
          status.success = false;
          status.failure = true;
        }
      }
      group = readGroup(pidFile("unit-tests"));
      lintGroup = readGroup(pidFile("lint"));
      const conclusion: Outcome = status.cancelled ? "cancelled" : status.failure ? "failure" : "success";
      const leftovers = [group, lintGroup].some(id => id !== null && groupAlive(id));
      return { conclusion, outcomes, logs, group, lintGroup, leftovers };
    } finally {
      group ??= readGroup(pidFile("unit-tests"));
      lintGroup ??= readGroup(pidFile("lint"));
      for (const id of [group, lintGroup]) if (id !== null && groupAlive(id)) process.kill(-id, "SIGKILL");
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

  // The lint is not here: it fails by its own exit status (below).
  const checks = [
    "Typecheck",
    "Production Docker image build",
    "Startup capability manifest smoke",
  ];

  it("passes on the PC only when every branch passes, and reaps both process groups", () => {
    const run = simulateStatic({ environment: "self-hosted", unitExit: 0 });
    expect(run.conclusion).toBe("success");
    expect(run.outcomes).toMatchObject({ [start]: "success", [lintStart]: "success", Typecheck: "success", [lint]: "success",
      [unit]: "success", [stop]: "success", [lintStop]: "success" });
    expect(run.logs[unit]).toContain("pnpm test:unit --maxWorkers=5\nunit tests finished\n");
    // The lint step joined the background lint and printed its whole log.
    expect(run.logs[lint]).toMatch(/^lint ran in the background for \d+s; this step waited \d+s for it\. Its log:\npnpm lint\nlint finished\n$/);
    expect(run.logs[lintStop]).toBe("");
    expect(run.group).not.toBeNull();
    expect(run.lintGroup).not.toBeNull();
    expect(run.leftovers).toBe(false);
  });

  it.each(checks)("on the PC, a failed %s fails the job and the lint and the unit tests still report", failAt => {
    for (const unitExit of [0, 1]) {
      const run = simulateStatic({ environment: "self-hosted", failAt, unitExit });
      expect(run.conclusion, `${failAt} unit=${unitExit}`).toBe("failure");
      expect(run.outcomes[failAt]).toBe("failure");
      expect(run.outcomes[lint]).toBe("success");
      expect(run.logs[lint]).toContain("Its log:\npnpm lint\nlint finished\n");
      expect(run.outcomes[unit]).toBe(unitExit === 0 ? "success" : "failure");
      expect(run.logs[unit]).toContain("pnpm test:unit --maxWorkers=5\nunit tests finished\n");
      expect(run.outcomes[stop]).toBe("success");
      expect(run.outcomes[lintStop]).toBe("success");
      expect(run.outcomes["Remove this run's image"]).toBe("success");
      expect(run.leftovers).toBe(false);
    }
  });

  // ESLint exits 1 on lint errors and 2 when it cannot run (config, crash).
  it.each([1, 2])("on the PC, a lint exiting %s fails its step with the lint's log before the image build; the unit tests still report", lintExit => {
    for (const unitExit of [0, 1]) {
      const run = simulateStatic({ environment: "self-hosted", lintExit, unitExit });
      expect(run.conclusion, `lint=${lintExit} unit=${unitExit}`).toBe("failure");
      expect(run.outcomes).toMatchObject({ Typecheck: "success", [lint]: "failure", "Exact checkout image metadata": "skipped",
        "Production Docker image build": "skipped", [unit]: unitExit === 0 ? "success" : "failure", [stop]: "success",
        [lintStop]: "success", "Remove this run's image": "success" });
      expect(run.logs[lint]).toContain("Its log:\npnpm lint\nlint finished\n");
      expect(run.logs[unit]).toContain("pnpm test:unit --maxWorkers=5\nunit tests finished\n");
      expect(run.leftovers).toBe(false);
    }
  });

  // One push reports both: a failed typecheck still joins the lint.
  it("on the PC, a failed typecheck still reports a failed lint", () => {
    const run = simulateStatic({ environment: "self-hosted", failAt: "Typecheck", lintExit: 1, unitExit: 0 });
    expect(run.conclusion).toBe("failure");
    expect(run.outcomes).toMatchObject({ Typecheck: "failure", [lint]: "failure", "Production Docker image build": "skipped", [unit]: "success" });
    expect(run.logs[lint]).toContain("Its log:\npnpm lint\nlint finished\n");
    expect(run.leftovers).toBe(false);
  });

  it("on the PC, a lint that dies without an exit status fails its step", () => {
    const run = simulateStatic({ environment: "self-hosted", lintExit: "killed", unitExit: 0 });
    expect(run.conclusion).toBe("failure");
    expect(run.outcomes).toMatchObject({ [lint]: "failure", "Production Docker image build": "skipped", [unit]: "success" });
    expect(run.logs[lint]).toContain("::error::lint ended without recording an exit status");
    expect(run.leftovers).toBe(false);
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

  it("a stale contract fails the job before the unit tests and the lint start", () => {
    const run = simulateStatic({ environment: "self-hosted", failAt: contracts, unitExit: 0 });
    expect(run.conclusion).toBe("failure");
    expect(run.outcomes).toMatchObject({ [start]: "skipped", [lintStart]: "skipped", Typecheck: "skipped", [lint]: "skipped",
      [unit]: "skipped", [stop]: "success", [lintStop]: "success" });
    expect(run.group).toBeNull();
    expect(run.lintGroup).toBeNull();
  });

  it("a cancelled job skips the join, prints what the unit tests logged and kills their process group", () => {
    const run = simulateStatic({ environment: "self-hosted", cancelAt: "Production Docker image build", unitExit: 0, unitSeconds: 60 });
    expect(run.conclusion).toBe("cancelled");
    expect(run.outcomes).toMatchObject({ "Chromium Headless Shell runtime smoke": "skipped", [unit]: "skipped", [stop]: "success",
      "Remove this run's image": "success" });
    expect(run.logs[stop]).toContain("unit-tests was still running; its log so far:\npnpm test:unit --maxWorkers=5\n");
    // The lint was joined before the build: nothing is left to print or kill.
    expect(run.outcomes).toMatchObject({ [lint]: "success", [lintStop]: "success" });
    expect(run.logs[lintStop]).toBe("");
    expect(run.group).not.toBeNull();
    expect(run.leftovers).toBe(false);
  });

  it("a job cancelled during typecheck skips the lint's join, prints what the lint logged and kills its process group", () => {
    const run = simulateStatic({ environment: "self-hosted", cancelAt: "Typecheck", unitExit: 0, unitSeconds: 60, lintSeconds: 60 });
    expect(run.conclusion).toBe("cancelled");
    expect(run.outcomes).toMatchObject({ [lint]: "skipped", "Production Docker image build": "skipped", [unit]: "skipped",
      [stop]: "success", [lintStop]: "success", "Remove this run's image": "success" });
    expect(run.logs[lintStop]).toContain("lint was still running; its log so far:\npnpm lint\n");
    expect(run.logs[lintStop]).toContain(`Stopped lint (process group ${String(run.lintGroup)}).`);
    expect(run.logs[stop]).toContain("unit-tests was still running; its log so far:\npnpm test:unit --maxWorkers=5\n");
    expect(run.lintGroup).not.toBeNull();
    expect(run.leftovers).toBe(false);
  });

  it.each([0, 1])("a job cancelled during typecheck after the lint finished with %s still prints its log and status", lintExit => {
    const run = simulateStatic({ environment: "self-hosted", cancelAt: "Typecheck", cancelWhen: "finished", unitExit: 0, lintExit });
    expect(run.conclusion).toBe("cancelled");
    expect(run.outcomes).toMatchObject({ [lint]: "skipped", [lintStop]: "success" });
    expect(run.logs[lintStop]).toBe(`lint finished with exit status ${lintExit} but was never joined; its log:\npnpm lint\nlint finished\n`);
    expect(run.leftovers).toBe(false);
  });

  // The unit tests may well finish before a cancel lands on a later check:
  // the join is skipped all the same, so the stop step prints their log and
  // their exit status.
  it.each([0, 3])("a job cancelled after the unit tests finished with %s still prints their log and status", unitExit => {
    const run = simulateStatic({ environment: "self-hosted", cancelAt: "Startup capability manifest smoke", cancelWhen: "finished", unitExit });
    expect(run.conclusion).toBe("cancelled");
    expect(run.outcomes).toMatchObject({ [unit]: "skipped", [stop]: "success" });
    expect(run.logs[stop]).toBe(
      `unit-tests finished with exit status ${unitExit} but was never joined; its log:\npnpm test:unit --maxWorkers=5\nunit tests finished\n`,
    );
    expect(run.leftovers).toBe(false);
  });

  it.each([
    // failAt, lint's exit, unit tests' exit, conclusion, lint's step, unit tests' step
    [undefined, 0, 0, "success", "success", "success"],
    [undefined, 0, 1, "failure", "success", "failure"],
    // Hosted keeps the old order: a failed check skips the checks after it.
    [undefined, 1, 0, "failure", "failure", "skipped"],
    ["Typecheck", 0, 0, "failure", "skipped", "skipped"],
    ["Startup capability manifest smoke", 0, 0, "failure", "success", "skipped"],
  ] as const)("hosted: failed check %s, lint exits %s, unit tests exit %s → %s, lint %s, unit tests %s",
    (failAt, lintExit, unitExit, conclusion, lintOutcome, unitOutcome) => {
      const run = simulateStatic({ environment: "github-hosted", ...(failAt ? { failAt } : {}), lintExit, unitExit });
      expect(run.conclusion).toBe(conclusion);
      expect(run.outcomes[start]).toBe("skipped");
      expect(run.outcomes[lintStart]).toBe("skipped");
      // Nothing in the background: the lint step runs the previous command.
      expect(run.outcomes[lint]).toBe(lintOutcome);
      if (lintOutcome !== "skipped") expect(run.logs[lint]).toBe("pnpm lint\nlint finished\n");
      expect(run.outcomes[unit]).toBe(unitOutcome);
      if (unitOutcome !== "skipped") expect(run.logs[unit]).toBe("pnpm test:unit --maxWorkers=2\nunit tests finished\n");
      expect(run.outcomes).toMatchObject({ [stop]: "success", [lintStop]: "success" });
      expect(run.logs[lintStop]).toBe("");
      expect(run.group).toBeNull();
      expect(run.lintGroup).toBeNull();
    },
  );
});

describe("CI integration shards", () => {
  const shardTotal = "${{ needs.fingerprint.outputs.shard_total || 3 }}";
  const dbStepName = `Sync-critical DB/schema/network tests (shard \${{ matrix.shard }}/${shardTotal})`;
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const syncCritical = syncCriticalDbFiles();

  /** The files `vitest --shard=<leg>/<total>` runs for the sync-critical DB suite. */
  async function shardFiles(leg: number, total: number): Promise<string[]> {
    const ctx = { config: { root: repoRoot, shard: { index: leg, count: total } }, logger: { log: () => undefined } };
    const specs = syncCritical.map(file => ({ moduleId: path.join(repoRoot, file) }) as unknown as TestSpecification);
    const chosen = await new WeightedShardSequencer(ctx as unknown as Vitest).shard(specs);
    return chosen.map(spec => shardKey(repoRoot, spec.moduleId));
  }

  /** The legs together run every sync-critical DB file exactly once. */
  async function expectEveryFileOnce(legs: readonly number[], total: number) {
    const placed = (await Promise.all(legs.map(leg => shardFiles(leg, total)))).flat();
    expect(placed).toHaveLength(new Set(placed).size);
    expect([...placed].sort()).toEqual(syncCritical);
  }

  // Vitest alone splits --shard by file COUNT; the root config's sequencer
  // packs by measured duration instead (tests/ci/shard-weights.json). The
  // sharded script must keep using that config and its sequencer.
  it("splits the sync-critical DB suite by measured duration through the root Vitest config", () => {
    expect(vitestConfig.test?.sequence?.sequencer).toBe(WeightedShardSequencer);
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    const tokens = (manifest.scripts["test:sync-critical:db"] ?? "").split(/\s+/);
    // No flag may override the config; the PC switch expands only to file-parallelism flags (pinned below).
    expect(new Set(tokens.filter(token => token.startsWith("-")))).toEqual(new Set(["--exclude"]));
    expect(tokens.filter(token => token.startsWith("${"))).toEqual(["${SYNC_CRITICAL_DB_PARALLELISM:---no-file-parallelism}"]);
    expect(syncCritical.length).toBeGreaterThan(8);
  });

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
    expect(api.env).toEqual({ HUB_TEST_PG_TMPFS: "${{ runner.environment == 'self-hosted' && '1' || '' }}" });
    expect(shell(api)).toBe("pnpm test:sync-critical:api");
  });

  // Hosted runners run a shard's DB files one at a time, exactly as before;
  // the PC runs two at a time. The switch is one step env var that the package
  // script expands, so the hosted vitest command stays byte-identical.
  const hostedDbCommand = "NODE_OPTIONS=--max-old-space-size=8192 vitest run --no-file-parallelism tests/*.integration.test.ts tests/schema-guard.test.ts tests/http-client.test.ts tests/network.test.ts --exclude tests/api.integration.test.ts";
  const packageScripts = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> }).scripts;

  /** The argv the package script hands vitest, as pnpm runs it: `sh -c` with the extra args appended. */
  function vitestArgv(script: string, env: Record<string, string>): string[] {
    const { SYNC_CRITICAL_DB_PARALLELISM: _inherited, ...inherited } = process.env;
    const result = spawnSync("sh", ["-c", `vitest() { printf '%s\\n' "NODE_OPTIONS=$NODE_OPTIONS" "$@"; }\n${script} --shard=2/6`], {
      encoding: "utf8",
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...inherited, ...env },
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trimEnd().split("\n");
  }

  it.each([
    ["github-hosted", "", ["--no-file-parallelism"]],
    ["self-hosted", "--fileParallelism --maxWorkers=2", ["--fileParallelism", "--maxWorkers=2"]],
  ] as const)("runs the DB files on %s with %j", (environment, value, flags) => {
    const db = step("integration", dbStepName);
    expect(db.if).toBeUndefined();
    expect(db.env).toEqual({
      SYNC_CRITICAL_DB_PARALLELISM: "${{ runner.environment == 'self-hosted' && '--fileParallelism --maxWorkers=2' || '' }}",
      HUB_TEST_PG_TMPFS: "${{ runner.environment == 'self-hosted' && '1' || '' }}",
    });
    expect(packageScripts["test:sync-critical:db"]).toBe(hostedDbCommand.replace("--no-file-parallelism", "${SYNC_CRITICAL_DB_PARALLELISM:---no-file-parallelism}"));
    const env = field(db.env?.SYNC_CRITICAL_DB_PARALLELISM ?? "", eventContext({ runnerEnvironment: environment }));
    expect(env).toBe(value);

    const baseline = vitestArgv(hostedDbCommand, {});
    expect(baseline.slice(0, 3)).toEqual(["NODE_OPTIONS=--max-old-space-size=8192", "run", "--no-file-parallelism"]);
    expect(baseline.filter(arg => arg.endsWith(".integration.test.ts")).length).toBeGreaterThan(100);
    expect(baseline).not.toContain("tests/*.integration.test.ts");
    expect(baseline.at(-1)).toBe("--shard=2/6");
    expect(vitestArgv(packageScripts["test:sync-critical:db"] ?? "", { SYNC_CRITICAL_DB_PARALLELISM: env }))
      .toEqual([...baseline.slice(0, 2), ...flags, ...baseline.slice(3)]);
  });

  // The PC's shard clusters keep PGDATA in a tmpfs; hosted runners keep it on
  // disk, so the hosted run is unchanged. The flag is in the tracked workflow,
  // so the gate fingerprint covers it.
  it.each([
    ["github-hosted", ""],
    ["self-hosted", "1"],
  ] as const)("keeps the shard's test Postgres on %s with HUB_TEST_PG_TMPFS=%j", (environment, value) => {
    for (const name of [dbStepName, "Sync-critical API tests"]) {
      const expression = step("integration", name).env?.HUB_TEST_PG_TMPFS ?? "";
      expect(expression).toBe("${{ runner.environment == 'self-hosted' && '1' || '' }}");
      expect(field(expression, eventContext({ runnerEnvironment: environment }))).toBe(value);
    }
    const setup = readFileSync(new URL("./helpers/global-setup.ts", import.meta.url), "utf8");
    expect(setup).toContain('if (process.env.HUB_TEST_PG_TMPFS === "1") {');
    expect(setup).toContain('postgres.withTmpFs({ "/var/lib/postgresql/data": "rw,size=1024m" });');
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
  ] as const)("CI_POOL=%s attempt %s CI_PC_SHARDS=%j runs %i shards that cover every file once", async (pool, attempt, pcShards, total) => {
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
    await expectEveryFileOnce(legs.map(Number), total);
  });

  // The integration job needs a successful fingerprint job, which always sets
  // both outputs; the fallback only keeps fromJSON off an empty string.
  it("falls back to the default three shards consistently when the plan outputs are empty", async () => {
    const empty = eventContext({ shards: "", shardTotal: "" });
    const matrix = String(job("integration").strategy?.matrix?.shard);
    expect(runner(matrix, empty)).toEqual(planShards({}).shards);
    expect(planShards({}).total).toBe(DEFAULT_SHARD_TOTAL);
    for (const shard of [1, 2, 3]) {
      const context = eventContext({ shards: "", shardTotal: "", shard });
      expect(field(job("integration").name ?? "", context)).toBe(`Integration ${shard}/${DEFAULT_SHARD_TOTAL}`);
      expect(field(shell(step("integration", dbStepName)), context)).toBe(`pnpm test:sync-critical:db --shard=${shard}/${DEFAULT_SHARD_TOTAL}`);
    }
    await expectEveryFileOnce(planShards({}).shards, DEFAULT_SHARD_TOTAL);
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
  it("mirrors only an earlier successful Quality Gate for the same head SHA", async () => {
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
    expect(await mirrorEarlierGate(mirrorEnv, () => ({ check_runs: [earlier] }))).toEqual({
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
      await expect(mirrorEarlierGate(mirrorEnv, () => ({ check_runs: [checkRun] })), JSON.stringify(checkRun)).rejects.toThrow("No earlier successful");
    }
    await expect(mirrorEarlierGate(mirrorEnv, () => ({ check_runs: [] }))).rejects.toThrow("No earlier successful");
    await expect(mirrorEarlierGate(mirrorEnv, () => { throw new Error("API unavailable"); })).rejects.toThrow("API unavailable");
    await expect(mirrorEarlierGate(mirrorEnv, () => Promise.reject(new Error("API unavailable")))).rejects.toThrow("API unavailable");
    // The head must be a real SHA, and a draft fails exactly like the gate does.
    await expect(mirrorEarlierGate({ ...mirrorEnv, HEAD_SHA: "" }, () => ({ check_runs: [earlier] }))).rejects.toThrow("head SHA");
    const draftApi = vi.fn(() => ({ check_runs: [earlier] }));
    await expect(mirrorEarlierGate({ ...mirrorEnv, IS_DRAFT: "true" }, draftApi)).rejects.toThrow("Draft PR");
    expect(draftApi).not.toHaveBeenCalled();
    // The query asks GitHub for this head's check runs by the required name.
    const endpoints: string[] = [];
    await expect(mirrorEarlierGate(mirrorEnv, endpoint => { endpoints.push(endpoint); return { check_runs: [] }; })).rejects.toThrow();
    expect(endpoints).toEqual([`repos/owner/repo/commits/${headSha}/check-runs?check_name=Quality%20Gate&filter=all&per_page=100&page=1`]);
    // A full page is not the end of the list.
    const pages: string[] = [];
    const other = { ...earlier, conclusion: "failure" };
    const paged = await mirrorEarlierGate(mirrorEnv, endpoint => {
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
    // The typecheck the image build skips must run earlier in the same job,
    // in the foreground: only the unit tests and the lint start in the background.
    const names = job("static").steps.map(item => item.name);
    expect(names.indexOf("Typecheck")).toBeGreaterThan(-1);
    expect(names.indexOf("Typecheck")).toBeLessThan(names.indexOf("Production Docker image build"));
    expect(shell(step("static", "Typecheck"))).toBe("pnpm typecheck");
    expect(job("static").steps.filter(item => item.run?.includes("ci-background.sh start")).map(item => item.name))
      .toEqual(["Start reliable unit tests in the background", "Start lint in the background"]);
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
