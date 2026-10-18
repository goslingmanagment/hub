import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TRANSITION_NOTE_MAX } from "../apps/page-browser/src/rpc/protocol.ts";
import { forgetSecrets, registerSecret } from "../apps/page-browser/src/shared/secrets.ts";
import { maskIps } from "../apps/page-browser/src/egress/ip-mask.ts";
import { readCrashDumps, transitionNote } from "../apps/page-browser/src/state/telemetry.ts";
import { tempDir } from "./helpers/page-browser-fakes.ts";

// What the operator tells Hub of itself for audits (protocol minor 5): a
// transition's note with its IPs masked, and Chrome's crash dumps as root
// counted them — never a dump.

describe("a transition's note for Hub", () => {
  it("masks every IP address, v4 and v6, with or without a port — never a time or a version", () => {
    expect(maskIps("the exit IP changed: 198.51.100.9 is not the pinned 203.0.113.7")).toBe("the exit IP changed: <ip> is not the pinned <ip>");
    expect(maskIps("SOCKS5 152.53.191.242:1080 refused; [2001:db8::1]:443 too, and ::1")).toBe("SOCKS5 <ip>:1080 refused; [<ip>]:443 too, and <ip>");
    expect(maskIps("at 12:30:45, Chrome 155.0.8059.84, 999.1.1.1")).toBe("at 12:30:45, Chrome 155.0.8059.84, 999.1.1.1");
  });

  it("is scrubbed as a journal line and cut to its limit", () => {
    registerSecret("socks-password-123");
    try {
      expect(transitionNote("auth failed for socks-password-123 at 203.0.113.7")).toBe("auth failed for [secret] at <ip>");
    } finally {
      forgetSecrets();
    }
    const long = transitionNote("x".repeat(5000));
    expect(long).toHaveLength(TRANSITION_NOTE_MAX);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("Chrome's crash dumps, counted", () => {
  it("reads the count root wrote, and nothing it does not trust", () => {
    const temp = tempDir();
    try {
      const path = join(temp.dir, "crash-dumps.json");
      expect(readCrashDumps(path)).toBeNull();
      const count = { countedAtWall: 1_700_000_000_000, completed: { count: 25, newestAtWall: 1_699_999_000_000 }, pending: { count: 0, newestAtWall: null } };
      writeFileSync(path, JSON.stringify(count));
      expect(readCrashDumps(path)).toEqual(count);
      for (const bad of ["not json", "{}", JSON.stringify({ ...count, completed: { count: -1, newestAtWall: null } }), JSON.stringify({ ...count, countedAtWall: "now" })]) {
        writeFileSync(path, bad);
        expect(readCrashDumps(path), bad).toBeNull();
      }
    } finally {
      temp.remove();
    }
  });

  // The image's script (GNU find and date: Linux, as in the image).
  const gnu = (() => {
    try {
      return execFileSync("find", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).includes("GNU");
    } catch {
      return false;
    }
  })();
  it.runIf(gnu)("s6/scripts/crash-dumps counts the dumps of completed and pending and their newest time — names and times only", () => {
    const temp = tempDir();
    try {
      const reports = join(temp.dir, "Crash Reports");
      mkdirSync(join(reports, "completed"), { recursive: true });
      mkdirSync(join(reports, "pending"), { recursive: true });
      for (const [name, seconds] of [["a.dmp", 1_700_000_000], ["b.dmp", 1_700_000_500], ["b.meta", 1_700_000_900]] as const) {
        const file = join(reports, "completed", name);
        writeFileSync(file, "secret memory");
        utimesSync(file, seconds, seconds);
      }
      const out = join(temp.dir, "crash-dumps.json");
      const script = readFileSync("apps/page-browser/s6/scripts/crash-dumps", "utf8")
        .replace('DIR="/data/profile/Crash Reports"', `DIR="${reports}"`)
        .replace("OUT=/run/pb/crash-dumps.json", `OUT="${out}"`);
      execFileSync("sh", ["-c", script]);
      const counted = readCrashDumps(out);
      expect(counted).toEqual({ completed: { count: 2, newestAtWall: 1_700_000_500_000 }, pending: { count: 0, newestAtWall: null }, countedAtWall: expect.any(Number) });
      expect(readFileSync(out, "utf8")).not.toContain("secret");
    } finally {
      temp.remove();
    }
  });
});
