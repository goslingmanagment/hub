import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildSyncSwitchCommandGroup, type SyncSwitchCliDeps } from "../apps/runtime/src/sync/cli/switch.ts";

// The step-3 switch CLI's wiring (design step 3 §3.5 item 8): the commands and
// their options parse as the runbook writes them (`sync switch check --page`
// is the subcommand's own option, repeated or comma-separated for pages
// switched together — step 3b ruling 13; the owner's acceptance of a report's red
// lines names red lines alone, with a reason — ruling 12), every command opens its
// context only after its options parsed, and the main CLI registers the group with
// the legacy recovery request of the rollback's last step.

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
    [["switch", "--page", "ari-1", "--shadow-report", "/tmp/r.json", "--accept-red-lines", "a1,a2,a3,b6", "--red-lines-reason", "lilly-1 live", "--dry-run"]],
    [["switch", "--page", "ari-1", "--shadow-report", "/tmp/r.json", "--accept-red-lines", " A2 ", "--red-lines-reason", "shared queue"]],
    [["switch", "check", "--page", "lilly-1", "--since", "2026-10-02T10:00:00Z", "--until", "2026-10-02T11:00:00Z", "--out", "/tmp/a.json"]],
    [["switch", "check", "--page", "ari-1", "--page", "lilly-2,lora-3", "--since", "2026-10-03T10:00:00Z"]],
    [["rollback", "--page", "lilly-1"]],
    [["rollback", "--page", "lilly-1", "--with-auth-hold"]],
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
    // Step 3b ruling 12: the owner accepts red lines, with a reason, never a hard check.
    [["switch", "--page", "ari-1", "--shadow-report", "/tmp/r.json", "--accept-red-lines", "a1,a2"], /--accept-red-lines needs --red-lines-reason/],
    [["switch", "--page", "ari-1", "--shadow-report", "/tmp/r.json", "--accept-red-lines", "a1", "--red-lines-reason", "  "], /needs --red-lines-reason/],
    [["switch", "--page", "ari-1", "--shadow-report", "/tmp/r.json", "--red-lines-reason", "why"], /--red-lines-reason goes with --accept-red-lines/],
    ...["covered", "a4", "budgets", "walks", "build"].map((hard) => [
      ["switch", "--page", "ari-1", "--shadow-report", "/tmp/r.json", "--accept-red-lines", `a1,${hard}`, "--red-lines-reason", "why"],
      new RegExp(`${hard} is a hard check of the shadow report, never accepted`),
    ] as [string[], RegExp]),
    [["switch", "--page", "ari-1", "--shadow-report", "/tmp/r.json", "--accept-red-lines", "a9", "--red-lines-reason", "why"], /a9 is no check of the shadow report/],
    [["switch", "--page", "ari-1", "--shadow-report", "/tmp/r.json", "--accept-red-lines", ",", "--red-lines-reason", "why"], /expected red lines/],
    [["switch", "--page", "ari-1", "--open-requests", "--accept-red-lines", "a1", "--red-lines-reason", "why"], /not --open-requests/],
  ])("refuses %j before opening anything", async (argv, message) => {
    const { error, opened } = await parse(argv);
    expect(error).not.toBeInstanceOf(Opened);
    expect(String((error as Error).message)).toMatch(message);
    expect(opened).toBe(0);
  });

  it("is registered by the main CLI with the rollback's legacy recovery request", () => {
    const cli = readFileSync("apps/runtime/src/cli.ts", "utf8");
    expect(cli).toContain("registerSyncSwitchCommands(sync, { requestLegacyRecovery: queueLegacyRecoverySync });");
    expect(cli).toMatch(/async function queueLegacyRecoverySync\(pageLabel: string\) \{[\s\S]{0,400}requestPageSync\(app, boss, \{ pageLabel, scope: "all", reason: "recovery" \}\)/);
  });
});
