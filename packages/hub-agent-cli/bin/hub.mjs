#!/usr/bin/env node
// The `hub` entry point.
//
// This workspace has no build step for packages: everything runs from TypeScript
// source through tsx, and the CLI is no exception. So the bin is a loader rather
// than a compiled artifact that would need its own build and its own drift gate.
//
// TWO THINGS HERE ARE LOAD-BEARING, and both are review findings (round 1):
//
// 1. **The tsconfig is passed explicitly.** Without it tsx picks up whatever
//    tsconfig sits near the CWD, so `hub` worked from the repo root and died with
//    ERR_MODULE_NOT_FOUND anywhere else. Resolving the repo's own tsconfig
//    relative to THIS FILE makes the workspace path aliases (`@kernel/sdk`,
//    `@agency_hub_core/contracts`) resolve identically from any directory. The
//    manifest declares both dependencies as well; this makes the documented
//    invocation work without also depending on the installer's node_modules
//    layout.
// 2. **Nothing may escape as a stack trace.** The CLI promises exactly one JSON
//    document on stdout and an exit code from {0,3,4}, and a loader failure is
//    the one path that could break both at once (empty stdout, exit 1). So the
//    load itself is wrapped: whatever goes wrong, one document goes out and the
//    code is 4.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tsconfig = join(here, "..", "..", "..", "tsconfig.json");

try {
  const { register } = await import("tsx/esm/api");
  register({ tsconfig });
  await import("../src/cli.ts");
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    operation: null,
    exitCode: 4,
    error: {
      category: "cli",
      status: null,
      code: "bootstrap_failed",
      message: error instanceof Error ? error.message : String(error),
    },
  })}\n`);
  process.exitCode = 4;
}
