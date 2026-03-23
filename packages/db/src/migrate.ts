import { pathToFileURL } from "node:url";

export { runMigrations } from "./migrate-runner.ts";

import { runMigrations } from "./migrate-runner.ts";

async function main() {
  await runMigrations();
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
