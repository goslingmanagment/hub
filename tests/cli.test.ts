import { describe, expect, it } from "vitest";

import { buildProgram } from "../apps/runtime/src/cli.ts";

function createProgramHarness() {
  const program = buildProgram();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
    outputError: (str, write) => {
      write(str);
    },
  });

  return {
    program,
  };
}

describe("CLI parsing", () => {
  it("documents sync --page and rejects sync --account", async () => {
    const helpProgram = buildProgram();
    const syncCommand = helpProgram.commands.find((command) => command.name() === "sync");
    expect(syncCommand).toBeDefined();
    const syncHelp = syncCommand?.helpInformation();
    expect(syncHelp).toContain("--page <label>");
    expect(syncHelp).not.toContain("--account <label>");

    const invalidHarness = createProgramHarness();
    const invalidSyncCommand = invalidHarness.program.commands.find(
      (command) => command.name() === "sync",
    );
    expect(invalidSyncCommand).toBeDefined();
    invalidSyncCommand?.exitOverride();
    invalidSyncCommand?.configureOutput({
      writeOut: () => {},
      writeErr: () => {},
      outputError: () => {},
    });
    await expect(
      invalidSyncCommand!.parseAsync(["--account", "lora-main"], { from: "user" }),
    ).rejects.toThrow("required option '--page <label>' not specified");
  });
});
