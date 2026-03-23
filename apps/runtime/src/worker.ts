import { pathToFileURL } from "node:url";

import { runWorkerRuntime } from "./worker-runtime.ts";

export async function main() {
  await runWorkerRuntime();
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
