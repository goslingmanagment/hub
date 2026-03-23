import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(rootDir, "..");
const execFileAsync = promisify(execFile);
const esbuildBin = path.join(workspaceRoot, "node_modules/.bin/esbuild");

const workspaceAliases = {
  "@agency_hub_core/contracts": path.join(workspaceRoot, "packages/contracts/src/index.ts"),
  "@agency_hub_core/db": path.join(workspaceRoot, "packages/db/src/index.ts"),
  "@agency_hub_core/fansly": path.join(workspaceRoot, "packages/fansly/src/index.ts"),
  "@agency_hub_core/onlyfans": path.join(workspaceRoot, "packages/onlyfans/src/index.ts"),
  "@agency_hub_core/shared": path.join(workspaceRoot, "packages/shared/src/index.ts"),
};

const runtimeExternal = [
  "@fastify/cookie",
  "@fastify/rate-limit",
  "@fastify/static",
  "@fastify/swagger",
  "@fastify/swagger-ui",
  "argon2",
  "commander",
  "dotenv",
  "drizzle-orm",
  "fastify",
  "fastify-type-provider-zod",
  "openapi-typescript",
  "pg",
  "pg-boss",
  "pino",
  "socks",
  "undici",
  "zod",
  "zod-to-json-schema",
];

async function cleanDist(relativePath) {
  await rm(path.join(workspaceRoot, relativePath), {
    force: true,
    recursive: true,
  });
}

async function buildPackage(packageDir, entryPoints, options = {}) {
  const args = [
    ...Object.values(entryPoints),
    "--bundle",
    "--entry-names=[name]",
    "--format=esm",
    "--log-level=info",
    `--outdir=${packageDir}`,
    `--platform=${options.platform ?? "node"}`,
    `--target=${options.target ?? "node22"}`,
  ];

  for (const [name, target] of Object.entries(workspaceAliases)) {
    args.push(`--alias:${name}=${target}`);
  }

  for (const externalPackage of options.external ?? runtimeExternal) {
    args.push(`--external:${externalPackage}`);
  }

  const { stdout, stderr } = await execFileAsync(esbuildBin, args, {
    cwd: workspaceRoot,
  });

  if (stdout.trim()) {
    process.stdout.write(stdout);
  }
  if (stderr.trim()) {
    process.stderr.write(stderr);
  }
}

await Promise.all([
  cleanDist("apps/runtime/dist"),
  cleanDist("packages/contracts/dist"),
  cleanDist("packages/db/dist"),
  cleanDist("packages/fansly/dist"),
  cleanDist("packages/onlyfans/dist"),
  cleanDist("packages/shared/dist"),
]);

await buildPackage("packages/shared/dist", {
  browser: "packages/shared/src/browser.ts",
  index: "packages/shared/src/index.ts",
});

await buildPackage("packages/contracts/dist", {
  index: "packages/contracts/src/index.ts",
});

await buildPackage("packages/fansly/dist", {
  index: "packages/fansly/src/index.ts",
});

await buildPackage("packages/onlyfans/dist", {
  index: "packages/onlyfans/src/index.ts",
});

await buildPackage("packages/db/dist", {
  index: "packages/db/src/index.ts",
  migrate: "packages/db/src/migrate.ts",
});

await buildPackage("apps/runtime/dist", {
  api: "apps/runtime/src/api.ts",
  cli: "apps/runtime/src/cli.ts",
  startup: "apps/runtime/src/startup.ts",
  worker: "apps/runtime/src/worker.ts",
});
