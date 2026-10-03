import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildSyncSwitchCommandGroup,
  SYNC_ROLLBACK_RETIRED,
  type SyncSwitchCliDeps,
} from "../apps/runtime/src/sync/cli/switch.ts";

// The step-3 switch CLI's wiring (design step 3 §3.5 item 8): the commands and
// their options parse as the runbook writes them (`sync switch check --page`
// is the subcommand's own option, repeated or comma-separated for pages
// switched together — step 3b ruling 13), every command opens its context only after
// its options parsed, and the main CLI registers the group. Since step 4
// (S4-10) `sync rollback` refuses before it opens anything: the legacy
// executor serves no Fansly page to hand one back to.

class Opened extends Error {}

function deps(): SyncSwitchCliDeps & { opened: number } {
  const state = {
    opened: 0,
    openContext: async () => {
      state.opened += 1;
      throw new Opened("opened");
    },
    print: () => undefined,
    readFile: async () => "",
    writeFile: async () => undefined,
    sleep: async () => undefined,
    requestLegacyRecovery: async () => undefined,
    setExitCode: () => undefined,
    buildSha: () => null,
  };
  return state;
}

async function parse(argv: string[]) {
  const d = deps();
  const sync = buildSyncSwitchCommandGroup(d);
  const error = await sync.parseAsync(argv, { from: "user" }).then(() => null, (failure: unknown) => failure);
  return { error, opened: d.opened };
}

describe("sync switch / rollback CLI", () => {
  it.each([
    [["switch", "--page", "lilly-1", "--shadow-report", "/tmp/shadow-report.json", "--dry-run"]],
    [["switch", "--page", "lilly-1", "--shadow-report", "/tmp/shadow-report.json"]],
    [["switch", "--page", "lilly-1", "--open-requests"]],
    [["switch", "check", "--page", "lilly-1", "--since", "2026-10-02T10:00:00Z", "--until", "2026-10-02T11:00:00Z", "--out", "/tmp/a.json"]],
    [["switch", "check", "--page", "ari-1", "--page", "lilly-2,lora-3", "--since", "2026-10-03T10:00:00Z"]],
  ])("parses %j and opens its context", async (argv) => {
    const { error, opened } = await parse(argv);
    expect(error).toBeInstanceOf(Opened);
    expect(opened).toBe(1);
  });

  it.each([
    [["switch", "check", "--since", "2026-10-02T10:00:00Z"], /--page/],
    [["switch", "check", "--page", ",", "--since", "2026-10-02T10:00:00Z"], /--page/],
    [["switch", "check", "--page", "lilly-1"], /--since/],
    [["switch", "check", "--page", "lilly-1", "--since", "yesterday"], /ISO date/],
    [["rollback"], /--page/],
  ])("refuses %j before opening anything", async (argv, message) => {
    const { error, opened } = await parse(argv);
    expect(error).not.toBeInstanceOf(Opened);
    expect(String((error as Error).message)).toMatch(message);
    expect(opened).toBe(0);
  });

  it.each([
    [["rollback", "--page", "lilly-1"]],
    [["rollback", "--page", "lilly-1", "--with-auth-hold"]],
  ])("refuses %j as retired at step 4 without opening anything", async (argv) => {
    const { error, opened } = await parse(argv);
    expect(error).toMatchObject({ name: "SwitchRefusedError", message: SYNC_ROLLBACK_RETIRED });
    expect(SYNC_ROLLBACK_RETIRED).toMatch(/^sync rollback is retired at step 4: .*recovery is a fix forward/);
    expect(opened).toBe(0);
  });

  it("is registered by the main CLI with the rollback's legacy recovery request", () => {
    const cli = readFileSync("apps/runtime/src/cli.ts", "utf8");
    expect(cli).toContain("registerSyncSwitchCommands(sync, { requestLegacyRecovery: queueLegacyRecoverySync });");
    expect(cli).toMatch(/async function queueLegacyRecoverySync\(pageLabel: string\) \{[\s\S]{0,400}requestPageSync\(app, boss, \{ pageLabel, scope: "all", reason: "recovery" \}\)/);
  });
});
