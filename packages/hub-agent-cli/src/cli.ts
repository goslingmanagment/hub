import { formatHubDocument, runHubCli } from "./main.ts";

/**
 * The executable entry, kept apart from `main.ts` so the library half has NO
 * side effect on import: the tests exercise `runHubCli` directly, and a module
 * that ran a command merely because it was imported would make that impossible.
 *
 * The whole process surface is here: read argv, print one document, set the
 * exit code. Nothing else touches stdout, so the "exactly one JSON document"
 * promise holds by construction rather than by discipline.
 */
const argv = process.argv.slice(2);
const result = await runHubCli({ argv, env: process.env });
process.stdout.write(`${formatHubDocument(result.document, argv.includes("--pretty"))}\n`);
process.exitCode = result.exitCode;
