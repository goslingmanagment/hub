import { describe, expect, it } from "vitest";

import { NEVER_PATH, runSelfTest, UNKNOWN_WRITE_PATH, type SelfTestDeps } from "../apps/page-browser/src/selftest/selftest.ts";
import type { ProbeKind, ProbeOutcome } from "../apps/page-browser/src/selftest/probes.ts";

// The self-test with the exit closed (Project Browser plan §4.1, step 5):
// each mechanism checked on its own, and the verdict says which one stopped
// the request. The rules extension arrives with PR 6: until then its checks
// are "not_installed" — never "passed".

const refusedByClosedExit: ProbeOutcome = { paused: true, errorText: "net::ERR_TUNNEL_CONNECTION_FAILED", blockedReason: null, answered: false };
const blockedByExtension: ProbeOutcome = { paused: false, errorText: "net::ERR_BLOCKED_BY_CLIENT", blockedReason: "other", answered: false };
const kernelOk = { ok: true, results: [{ user: "pb-chrome", what: "the internet", pass: true }] };

function deps(overrides: Partial<SelfTestDeps> & { outcomes?: Partial<Record<ProbeKind, ProbeOutcome>> } = {}): SelfTestDeps & { probed: Array<[ProbeKind, string, string]> } {
  const probed: Array<[ProbeKind, string, string]> = [];
  const outcomes: Record<ProbeKind, ProbeOutcome> = { permitted: refusedByClosedExit, never: blockedByExtension, write: blockedByExtension, ...overrides.outcomes };
  return {
    probed,
    probe: async (kind, method, path) => {
      probed.push([kind, method, path]);
      return outcomes[kind];
    },
    closedExitRefusalsSince: () => 1,
    readKernelResult: () => kernelOk,
    extension: "not_installed",
    maxMs: 2000,
    ...overrides,
  };
}

describe("the self-test", () => {
  it("passes on the closed exit and the kernel check, and reports the extension as not installed", async () => {
    const test = deps();
    const result = await runSelfTest(test);
    expect(result.ok).toBe(true);
    expect(result.failed).toBeNull();
    expect(result.checks.proxy_closed.status).toBe("passed");
    expect(result.checks.os_rules.status).toBe("passed");
    expect(result.checks.dnr_never.status).toBe("not_installed");
    expect(result.checks.dnr_write.status).toBe("not_installed");
    // Not installed means not tried: nothing claims the extension passed.
    expect(test.probed.map(([kind]) => kind)).toEqual(["permitted"]);
    expect(test.probed[0]).toEqual(["permitted", "GET", "/api/v1/pb-selftest"]);
  });

  it("fails proxy_closed when the probe never reached the interception", async () => {
    const result = await runSelfTest(deps({ outcomes: { permitted: { ...refusedByClosedExit, paused: false } } }));
    expect(result).toMatchObject({ ok: false, failed: "proxy_closed" });
    expect(result.checks.proxy_closed.detail).toMatch(/never reached the interception/);
  });

  it("fails proxy_closed when the probe stays queued: none may leave later", async () => {
    const result = await runSelfTest(deps({ outcomes: { permitted: { ...refusedByClosedExit, errorText: null } } }));
    expect(result).toMatchObject({ ok: false, failed: "proxy_closed" });
    expect(result.checks.proxy_closed.detail).toMatch(/still queued/);
  });

  it("fails proxy_closed when the request failed otherwise, was answered, or the proxy's journal has no refusal", async () => {
    expect((await runSelfTest(deps({ outcomes: { permitted: { ...refusedByClosedExit, errorText: "net::ERR_BLOCKED_BY_CLIENT" } } }))).failed).toBe("proxy_closed");
    expect((await runSelfTest(deps({ outcomes: { permitted: { ...refusedByClosedExit, errorText: "", answered: true } } }))).failed).toBe("proxy_closed");
    const noRefusal = await runSelfTest(deps({ closedExitRefusalsSince: () => 0 }));
    expect(noRefusal.failed).toBe("proxy_closed");
    expect(noRefusal.checks.proxy_closed.detail).toMatch(/journal has no closed-exit refusal/);
  });

  it("fails os_rules on a kernel check that failed, has no checks, or is missing", async () => {
    const failed = await runSelfTest(deps({ readKernelResult: () => ({ ok: false, results: [{ user: "pb-chrome", what: "the internet", pass: false }] }) }));
    expect(failed).toMatchObject({ ok: false, failed: "os_rules" });
    expect(failed.checks.os_rules.detail).toContain("pb-chrome: the internet");
    expect((await runSelfTest(deps({ readKernelResult: () => ({ ok: true, results: [] }) }))).failed).toBe("os_rules");
    const missing = await runSelfTest(
      deps({
        readKernelResult: () => {
          throw new Error("ENOENT");
        },
      }),
    );
    expect(missing.failed).toBe("os_rules");
  });

  it("with the extension required, passes when it cancels both probes before the interception", async () => {
    const test = deps({ extension: "required" });
    const result = await runSelfTest(test);
    expect(result.ok).toBe(true);
    expect(result.checks.dnr_never.status).toBe("passed");
    expect(result.checks.dnr_write.status).toBe("passed");
    expect(test.probed.slice(1)).toEqual([
      ["never", "POST", NEVER_PATH],
      ["write", "POST", UNKNOWN_WRITE_PATH],
    ]);
  });

  it("with the extension required, fails when a probe reached the operator — even failed there with the same error", async () => {
    const result = await runSelfTest(deps({ extension: "required", maxMs: 1000, outcomes: { never: { ...blockedByExtension, paused: true } } }));
    expect(result).toMatchObject({ ok: false, failed: "dnr_never" });
    expect(result.checks.dnr_never.detail).toMatch(/the operator stopped it/);
  });

  it("with the extension required and missing, fails instead of reporting it not installed", async () => {
    const missing = { paused: true, errorText: "net::ERR_BLOCKED_BY_CLIENT", blockedReason: null, answered: false };
    const result = await runSelfTest(deps({ extension: "required", maxMs: 1000, outcomes: { never: missing, write: missing } }));
    expect(result.ok).toBe(false);
    expect(result.checks.dnr_never.status).toBe("failed");
    expect(result.checks.dnr_write.status).toBe("failed");
  });

  it("stays within its time", async () => {
    const slow: ProbeOutcome = { ...blockedByExtension, paused: true };
    const started = Date.now();
    await runSelfTest(deps({ extension: "required", maxMs: 1500, outcomes: { never: slow } }));
    expect(Date.now() - started).toBeLessThan(2500);
  });
});
