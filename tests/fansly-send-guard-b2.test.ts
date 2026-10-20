import { describe, expect, it, vi } from "vitest";

import {
  buildFanslySendHolderIdentity,
  createPortableFanslySendOsProbe,
  createProcFanslySendOsProbe,
  FanslySendProbeUnknownError,
  judgeFanslySendHolderTermination,
  parseProcStatStartToken,
  type FanslySendOsProbe,
} from "../apps/runtime/src/services/fansly-send-guard/index.ts";

// The send guard's robustness points and helpers added in its second step
// (PR B2).

function errno(code: string) {
  return Object.assign(new Error(`${code}: fixture`), { code });
}

// A /proc/<pid>/stat line: "1234 (node worker) S 1 …", field 22 = start time.
const STAT = "1234 (node (worker)) S 1 1234 1234 0 -1 4194560 100 0 0 0 5 1 0 0 20 0 11 0 987654 123456 789";

describe("the /proc probe tells 'gone' from 'cannot tell' (plan §2.5: only a proof opens a page)", () => {
  it("reads the start token, and a zombie or dead task as gone", () => {
    expect(parseProcStatStartToken(STAT)).toBe("987654");
    expect(parseProcStatStartToken(STAT.replace(") S ", ") Z "))).toBeNull();
    expect(parseProcStatStartToken(STAT.replace(") S ", ") X "))).toBeNull();
  });

  it("refuses a stat it cannot parse", () => {
    expect(() => parseProcStatStartToken("garbage")).toThrow(FanslySendProbeUnknownError);
    expect(() => parseProcStatStartToken("1 (x) S 1 2")).toThrow(FanslySendProbeUnknownError);
  });

  it.each(["ENOENT", "ESRCH"])("takes %s as 'no such process'", (code) => {
    const probe = createProcFanslySendOsProbe({ readFile: () => { throw errno(code); } });
    expect(probe.processStartToken(42)).toBeNull();
  });

  it.each(["EACCES", "EPERM", "EIO", "EMFILE", "ENFILE", "ENOMEM", "EINVAL"])(
    "never takes %s as death: it cannot tell", (code) => {
      const probe = createProcFanslySendOsProbe({ readFile: () => { throw errno(code); } });
      expect(() => probe.processStartToken(42)).toThrow(FanslySendProbeUnknownError);
    },
  );

  it("never takes an error without a code, or a non-pid, as death", () => {
    const probe = createProcFanslySendOsProbe({ readFile: () => { throw new Error("odd"); } });
    expect(() => probe.processStartToken(42)).toThrow(FanslySendProbeUnknownError);
    expect(() => createProcFanslySendOsProbe({ readFile: () => STAT }).processStartToken(0))
      .toThrow(FanslySendProbeUnknownError);
  });

  it("reads /proc/<pid>/stat of the asked pid", () => {
    const readFile = vi.fn(() => STAT);
    expect(createProcFanslySendOsProbe({ readFile }).processStartToken(1234)).toBe("987654");
    expect(readFile).toHaveBeenCalledWith("/proc/1234/stat");
  });
});

describe("the portable probe tells 'gone' from 'cannot tell'", () => {
  function psFailure(input: { status?: number | null; stdout?: string; code?: string }) {
    return () => {
      throw Object.assign(new Error("ps failed"), input);
    };
  }

  it("takes ps selecting nothing (exit 1, no output) as gone", () => {
    expect(createPortableFanslySendOsProbe({ ps: psFailure({ status: 1, stdout: "" }) }).processStartToken(42)).toBeNull();
  });

  it.each([
    ["ps missing", { code: "ENOENT" }],
    ["ps killed", { status: null }],
    ["another exit status", { status: 2, stdout: "" }],
    ["exit 1 with output", { status: 1, stdout: "something" }],
  ])("never takes %s as death", (_label, failure) => {
    expect(() => createPortableFanslySendOsProbe({ ps: psFailure(failure) }).processStartToken(42))
      .toThrow(FanslySendProbeUnknownError);
  });

  it("refuses an empty answer", () => {
    expect(() => createPortableFanslySendOsProbe({ ps: () => "  \n" }).processStartToken(42))
      .toThrow(FanslySendProbeUnknownError);
  });
});

describe("the termination judge with a probe that cannot tell", () => {
  const unknownProbe: FanslySendOsProbe = {
    hostname: () => "container-a",
    bootId: () => "boot-1",
    pidNamespace: () => "pid:[1]",
    processStartToken: () => {
      throw new FanslySendProbeUnknownError("cannot read /proc/10/stat (EACCES)");
    },
    containerId: () => null,
  };
  const holder = {
    holderHost: "container-a",
    holderPid: 10,
    holderPidStart: "start-10",
    holderPidNs: "pid:[1]",
    holderBootId: "boot-1",
    holderInstance: "33333333-3333-4333-8333-333333333333",
  };

  it("confirms nothing: an unknown is never a release", () => {
    const identity = buildFanslySendHolderIdentity(unknownProbe, "worker");
    expect(judgeFanslySendHolderTermination(holder, { identity, probe: unknownProbe })).toBeNull();
    // This process's own start token is simply unknown, not a crash.
    expect(identity.pidStart).toBeNull();
  });

  it("still confirms by a changed boot id, which needs no pid probe", () => {
    const identity = buildFanslySendHolderIdentity(unknownProbe, "worker");
    expect(judgeFanslySendHolderTermination({ ...holder, holderBootId: "boot-0" }, { identity, probe: unknownProbe }))
      .toBe("boot_id_changed");
  });
});
