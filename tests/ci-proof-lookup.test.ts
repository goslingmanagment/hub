import { describe, expect, it, vi } from "vitest";

import { assertPublishableTitle, findProof, lookupProofs } from "../scripts/ci-find-proof.mjs";

const name = `quality-gate-${"a".repeat(64)}`;
const artifact = { name, expired: false, workflow_run: { id: 123, head_repository_id: 42 } };
const run = { path: ".github/workflows/ci.yml", status: "completed", conclusion: "success", head_repository: { id: 42 } };
const env = { GITHUB_REPOSITORY: "owner/repo", GITHUB_REPOSITORY_ID: "42",
  GATE_FINGERPRINT: "a".repeat(64), INTEGRATION_FINGERPRINT: "b".repeat(64),
  FORCE_FULL: "false", IS_DRAFT: "false", PR_TITLE: "ci: reduce repeated checks" };

describe("CI proof lookup", () => {
  it("accepts only a completed successful run of this repository's CI", () => {
    const api = vi.fn((endpoint: string) => endpoint.includes("/artifacts?") ? { artifacts: [artifact] } : run);
    expect(findProof({ repo: "owner/repo", repoId: "42", name, api })).toBe("123");
    expect(api).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...artifact, expired: true },
    { ...artifact, name: "different" },
    { ...artifact, workflow_run: { id: 123, head_repository_id: 99 } },
    { ...artifact, workflow_run: { id: "bad", head_repository_id: 42 } },
  ])("ignores invalid artifact %j", value => {
    const api = vi.fn(() => ({ artifacts: [value] }));
    expect(findProof({ repo: "owner/repo", repoId: "42", name, api })).toBe("");
    expect(api).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...run, conclusion: "failure" }, { ...run, conclusion: "cancelled" },
    { ...run, status: "in_progress" }, { ...run, path: ".github/workflows/nightly.yml" },
    { ...run, head_repository: { id: 99 } },
  ])("rejects non-proving producer %j", value => {
    const api = (endpoint: string) => endpoint.includes("/artifacts?") ? { artifacts: [artifact] } : value;
    expect(findProof({ repo: "owner/repo", repoId: "42", name, api })).toBe("");
  });

  it("turns API errors and missing records into a cache miss", () => {
    for (const api of [() => { throw new Error("API unavailable"); }, () => ({ artifacts: [] }), () => ({})]) {
      expect(findProof({ repo: "owner/repo", repoId: "42", name, api })).toBe("");
    }
  });

  it.each(["FORCE_FULL", "IS_DRAFT"])("%s bypasses BOTH proof lookups", key => {
    const api = vi.fn(() => { throw new Error("must not be called"); });
    expect(lookupProofs({ ...env, [key]: "true" }, api)).toEqual({ proven_by: "", integration_proven_by: "" });
    expect(api).not.toHaveBeenCalled();
  });

  it("can reuse integration while the full tree is new", () => {
    const api = vi.fn((endpoint: string) => {
      if (endpoint.includes("name=quality-gate-")) return { artifacts: [] };
      if (endpoint.includes("/artifacts?")) return { artifacts: [{ ...artifact, name: `integration-gate-${env.INTEGRATION_FINGERPRINT}` }] };
      return run;
    });
    expect(lookupProofs(env, api)).toEqual({ proven_by: "", integration_proven_by: "123" });
  });

  it("full proof avoids a redundant DB API lookup", () => {
    const api = vi.fn((endpoint: string) => endpoint.includes("/artifacts?") ? { artifacts: [artifact] } : run);
    expect(lookupProofs(env, api)).toEqual({ proven_by: "123", integration_proven_by: "" });
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid fingerprint inputs", () => {
    expect(() => lookupProofs({ ...env, GATE_FINGERPRINT: "" }, vi.fn())).toThrow("fingerprints");
  });

  it.each(["[skip ci]", "[ci skip]", "[no ci]", "[skip actions]", "[actions skip]", "skip-checks: true"])(
    "refuses a PR title that would suppress the main push: %s", marker => {
      expect(() => assertPublishableTitle(`ci: describe ${marker} in prose`)).toThrow("PR title");
      expect(() => lookupProofs({ ...env, PR_TITLE: marker, IS_DRAFT: "true" }, vi.fn())).toThrow("PR title");
    },
  );
});
