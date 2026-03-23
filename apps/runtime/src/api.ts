import { pathToFileURL } from "node:url";

import { runApiRuntime } from "./api-runtime.ts";

export async function main() {
  await runApiRuntime();
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
