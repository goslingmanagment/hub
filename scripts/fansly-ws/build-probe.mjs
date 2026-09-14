import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const output = process.argv[2];
const continuity = process.argv[3] === "--continuity";
if (!output || process.argv.length !== (continuity ? 4 : 3)) {
  throw new Error("Usage: build-probe.mjs <new-private-output.mjs> [--continuity]");
}
const root = fileURLToPath(new URL("../../", import.meta.url));
const alias = Object.fromEntries([
  "contracts", "db", "fansly", "platform-core", "shared",
].map((name) => [`@agency_hub_core/${name}`, `${root}packages/${name}/src/index.ts`]));

// Bundle local workspace code; runtime packages resolve from the pinned
// production image. No environment values or credentials enter the bundle.
const result = await build({
  absWorkingDir: root,
  entryPoints: [continuity ? "scripts/fansly-ws/continuity-cli.ts" : "scripts/fansly-ws/probe-cli.ts"],
  alias,
  bundle: true,
  packages: "external",
  platform: "node",
  target: "node22",
  format: "esm",
  write: false,
  logLevel: "warning",
});
if (result.outputFiles.length !== 1) throw new Error("Unexpected probe output count");
await writeFile(output, result.outputFiles[0].contents, { flag: "wx", mode: 0o600 });
process.stdout.write("Built the isolated probe entrypoint.\n");
