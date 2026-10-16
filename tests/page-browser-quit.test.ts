import { describe, expect, it } from "vitest";
import type { Cdp } from "../apps/page-browser/src/cdp/client.ts";
import type { ChromeControl } from "../apps/page-browser/src/operator/chrome.ts";
import { quitChromeAfterFailure } from "../apps/page-browser/src/operator/quit.ts";

function rig() {
  let up = true; let kills = 0;
  const lines: Array<Record<string, unknown>> = [];
  const chrome: ChromeControl = { start: async () => undefined, stop: async () => undefined, kill: async () => { kills++; up = false; }, isUp: async () => up, networkServicePid: () => null };
  const cdp = { cdpUp: true as boolean, send: async <T>() => { up = false; return {} as T; } } satisfies Pick<Cdp, "cdpUp" | "send">;
  const log = (e: string, fields?: Record<string, unknown>) => lines.push({ e, ...fields });
  return { chrome, cdp, log, lines, kills: () => kills, down: () => { up = false; } };
}

describe("a bounded profile-writing quit after egress closed", () => {
  it("waits for actual process exit after Browser.close, without a forced kill", async () => {
    const r = rig();
    await quitChromeAfterFailure(r.cdp, r.chrome, 100, r.log);
    expect(r.kills()).toBe(0);
    expect(r.lines).toContainEqual(expect.objectContaining({ outcome: "exited_after_close", answered: true }));
  });
  it("forces the process down when CDP is gone", async () => {
    const r = rig(); let called = false;
    r.cdp.cdpUp = false;
    r.cdp.send = async <T>() => { called = true; return {} as T; };
    await quitChromeAfterFailure(r.cdp, r.chrome, 30, r.log);
    expect(called).toBe(false); expect(r.kills()).toBe(1);
    expect(r.lines).toContainEqual(expect.objectContaining({ outcome: "killed", why: "cdp_unavailable" }));
  });
  it("uses one total deadline when CDP never answers, then kills", async () => {
    const r = rig();
    r.cdp.send = <T>() => new Promise<T>(() => undefined);
    await quitChromeAfterFailure(r.cdp, r.chrome, 20, r.log);
    expect(r.kills()).toBe(1);
    expect(r.lines).toContainEqual(expect.objectContaining({ outcome: "killed", deadlineMs: 20, answered: false }));
  });
  it("also bounds an unanswered process-status read", async () => {
    const r = rig();
    r.chrome.isUp = () => new Promise<boolean>(() => undefined);
    await quitChromeAfterFailure(r.cdp, r.chrome, 20, r.log);
    expect(r.kills()).toBe(1);
  });
  it("a disappearing CDP reply still permits a positive process-down proof", async () => {
    const r = rig();
    r.cdp.send = async () => { r.down(); throw new Error("CDP closed with Chrome"); };
    await quitChromeAfterFailure(r.cdp, r.chrome, 100, r.log);
    expect(r.kills()).toBe(0);
    expect(r.lines).toContainEqual(expect.objectContaining({ outcome: "exited_after_close", answered: false }));
  });
  it("does not claim the process down when the kill failed", async () => {
    const r = rig(); r.cdp.cdpUp = false;
    r.chrome.kill = async () => { throw new Error("s6 did not stop Chrome"); };
    await expect(quitChromeAfterFailure(r.cdp, r.chrome, 20, r.log)).rejects.toThrow("s6 did not stop Chrome");
    expect(r.lines).toEqual([]);
  });
});
