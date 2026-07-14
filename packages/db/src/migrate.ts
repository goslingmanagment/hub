import { pathToFileURL } from "node:url";

export { runMigrations } from "./migrate-runner.ts";

import { runMigrations } from "./migrate-runner.ts";

async function main() {
  const args = process.argv.slice(2);
  let through: string | undefined;
  if (args.length > 0) {
    if (args.length !== 2 || args[0] !== "--through" || !args[1]) {
      throw new Error("Usage: migrate [--through <exact-migration-filename>]");
    }
    through = args[1];
  }
  await runMigrations(through === undefined ? undefined : { through });
}

const isMainModule = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMainModule) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
