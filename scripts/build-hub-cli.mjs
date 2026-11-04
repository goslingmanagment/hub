import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

// The hub CLI as one file for a computer without the checkout (a content
// manager's own Claude; docs/agent-read-skill.md, «A computer without the
// checkout»). It goes among the dashboard's files, so the release that serves it
// is the release whose contract it holds, as /hub-cli/hub.mjs with its SHA-256
// beside it. Runs after the dashboard's build, which empties that directory.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "apps/dashboard/dist/hub-cli/hub.mjs");

await build({
  absWorkingDir: root,
  entryPoints: ["packages/hub-agent-cli/src/bundle.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  tsconfig: "tsconfig.json",
  legalComments: "none",
  logLevel: "warning",
  banner: { js: 'import { createRequire as __hubRequire } from "node:module"; const require = __hubRequire(import.meta.url);' },
});

const sha256 = createHash("sha256").update(await readFile(outfile)).digest("hex");
await writeFile(`${outfile}.sha256`, `${sha256}\n`);
console.log(`hub-cli: ${path.relative(root, outfile)} ${sha256.slice(0, 12)}`);
