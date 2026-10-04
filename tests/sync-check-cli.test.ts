import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildSyncCheckCommandGroup, type SyncCheckCliDeps } from "../apps/runtime/src/sync/cli/checks.ts";

// The wiring of the engine's read-only checks (`sync/checks/`, step 4 S4-21):
// `sync check live-hour` parses as the runbook writes it — `--page` repeated
// or comma-separated for pages that went live together, `--since` required —
// opens its context only after its options parsed, and is the one command
// left of the step-3 switch CLI: the switch and its roll-back are not
// commands any more.

class Opened extends Error {}

function deps(): SyncCheckCliDeps & { opened: number } {
  const state = {
    opened: 0,
    openContext: async () => {
      state.opened += 1;
      throw new Opened("opened");
    },
    print: () => undefined,
    writeFile: async () => undefined,
    setExitCode: () => undefined,
  };
  return state;
}

async function parse(argv: string[]) {
  const d = deps();
  const sync = buildSyncCheckCommandGroup(d);
  const error = await sync.parseAsync(argv, { from: "user" }).then(() => null, (failure: unknown) => failure);
  return { error, opened: d.opened };
}

describe("sync check CLI", () => {
  it.each([
    [["check", "live-hour", "--page", "lilly-1", "--since", "2026-10-02T10:00:00Z", "--until", "2026-10-02T11:00:00Z", "--out", "/tmp/a.json"]],
    [["check", "live-hour", "--page", "ari-1", "--page", "lilly-2,lora-3", "--since", "2026-10-03T10:00:00Z"]],
  ])("parses %j and opens its context", async (argv) => {
    const { error, opened } = await parse(argv);
    expect(error).toBeInstanceOf(Opened);
    expect(opened).toBe(1);
  });

  it.each([
    [["check", "live-hour", "--since", "2026-10-02T10:00:00Z"], /--page/],
    [["check", "live-hour", "--page", ",", "--since", "2026-10-02T10:00:00Z"], /--page/],
    [["check", "live-hour", "--page", "lilly-1"], /--since/],
    [["check", "live-hour", "--page", "lilly-1", "--since", "yesterday"], /ISO date/],
  ])("refuses %j before opening anything", async (argv, message) => {
    const { error, opened } = await parse(argv);
    expect(error).not.toBeInstanceOf(Opened);
    expect(String((error as Error).message)).toMatch(message);
    expect(opened).toBe(0);
  });

  it.each([
    [["switch", "--page", "lilly-1", "--shadow-report", "/tmp/shadow-report.json"]],
    [["switch", "check", "--page", "lilly-1", "--since", "2026-10-02T10:00:00Z"]],
    [["rollback", "--page", "lilly-1"]],
  ])("knows no %j: the switch and its roll-back are gone", async (argv) => {
    const { error, opened } = await parse(argv);
    expect(String((error as Error).message)).toMatch(/unknown command/);
    expect(opened).toBe(0);
  });

  it("is the only command the main CLI registers of the step-3 switch", () => {
    const cli = readFileSync("apps/runtime/src/cli.ts", "utf8");
    expect(cli).toContain("registerSyncCheckCommands(sync);");
    expect(cli).not.toMatch(/registerSyncSwitchCommands|queueLegacyRecoverySync|reason: "recovery"/);
    expect(existsSync("apps/runtime/src/sync/switch")).toBe(false);
    expect(existsSync("apps/runtime/src/sync/cli/switch.ts")).toBe(false);
  });
});
