import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

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
  needs?: string[];
  if?: string;
  permissions?: Permissions;
  outputs?: Record<string, string>;
  steps: Step[];
};
type Workflow = { permissions: Permissions; jobs: Record<string, Job> };

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
  // This gate deliberately uses only conjunctions of equality checks. Reject
  // unrecognised syntax instead of accidentally treating a new OR as safe.
  const condition = job("publish").if;
  if (!condition) throw new Error("Publishing has no explicit condition");
  return condition.split("&&").every(clause => {
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

  it.each([
    ["success", "success", true],
    ["failure", "success", false],
    ["success", "failure", false],
    ["cancelled", "success", false],
    ["success", "skipped", false],
  ] as const)("Quality Gate accepts static=%s integration=%s only when both pass", (staticResult, integrationResult, allowed) => {
    expect(job("quality").needs).toEqual(expect.arrayContaining(["static", "integration"]));
    expect(job("quality").if).toBe("always()");
    const script = shell(step("quality", "Every gate job succeeded"))
      .replaceAll("${{ needs.static.result }}", staticResult)
      .replaceAll("${{ needs.integration.result }}", integrationResult);
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], { encoding: "utf8" });
    expect(result.status === 0, result.stderr).toBe(allowed);
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
