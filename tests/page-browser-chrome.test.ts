import { describe, expect, it, vi } from "vitest";
const answer = vi.hoisted(() => ({ stdout: "" }));
vi.mock("node:child_process", () => ({ execFile: (_file: string, _args: string[], _options: unknown, done: (error: Error | null, stdout: string) => void) => done(null, answer.stdout) }));
import { S6Chrome } from "../apps/page-browser/src/operator/chrome.ts";

describe("positive proof of Chrome's process state", () => {
  it.each([["true\n", true], ["false\n", false]] as const)("reads s6's %j as %s", async (stdout, up) => {
    answer.stdout = stdout;
    await expect(new S6Chrome().isUp()).resolves.toBe(up);
  });
  it("never treats an empty or unknown status as a process that exited", async () => {
    for (const stdout of ["", "unknown", "permission denied"]) {
      answer.stdout = stdout;
      await expect(new S6Chrome().isUp()).rejects.toThrow("s6 did not report");
    }
  });
});
