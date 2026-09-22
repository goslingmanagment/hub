import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(rootDir, "..");
const execFileAsync = promisify(execFile);
const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const workspaceAliases = {
  "@agency_hub_core/contracts": path.join(workspaceRoot, "packages/contracts/src/index.ts"),
  "@agency_hub_core/db": path.join(workspaceRoot, "packages/db/src/index.ts"),
  "@agency_hub_core/fansly": path.join(workspaceRoot, "packages/fansly/src/index.ts"),
  "@agency_hub_core/platform-core": path.join(workspaceRoot, "packages/platform-core/src/index.ts"),
  "@agency_hub_core/shared": path.join(workspaceRoot, "packages/shared/src/index.ts"),
};

const runtimeExternal = [
  // Native bindings resolve from node_modules at run time (Stage 28).
  "@duckdb/node-api",
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
];
const bundledPackageOptions = { external: [] };
const nodeBundledPackageOptions = {
  ...bundledPackageOptions,
  banner: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
};

async function cleanDist(relativePath) {
  await rm(path.join(workspaceRoot, relativePath), {
    force: true,
    recursive: true,
  });
}

async function buildPackage(packageDir, entryPoints, options = {}) {
  const args = [
    ...Object.values(entryPoints).map((entryPoint) => path.join(workspaceRoot, entryPoint)),
    "--bundle",
    "--entry-names=[name]",
    "--format=esm",
    "--log-level=info",
    `--outdir=${path.join(workspaceRoot, packageDir)}`,
    `--platform=${options.platform ?? "node"}`,
    `--target=${options.target ?? "node22"}`,
  ];

  for (const [name, target] of Object.entries(workspaceAliases)) {
    args.push(`--alias:${name}=${target}`);
  }

  for (const externalPackage of options.external ?? runtimeExternal) {
    args.push(`--external:${externalPackage}`);
  }
  if (options.banner) {
    args.push(`--banner:js=${options.banner}`);
  }

  const { stdout, stderr } = await execFileAsync(pnpmBin, [
    "exec",
    "esbuild",
    ...args,
  ], {
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
  cleanDist("packages/db/dist"),
  cleanDist("packages/shared/dist"),
]);

// Dashboard consumes this source directly; bundling it here also rejects any
// accidental dependency on Node built-ins in the browser entry point.
await buildPackage("packages/shared/dist", {
  browser: "packages/shared/src/browser.ts",
}, {
  ...bundledPackageOptions,
  platform: "browser",
  target: "es2022",
});

await buildPackage("packages/db/dist", {
  index: "packages/db/src/index.ts",
  migrate: "packages/db/src/migrate.ts",
}, nodeBundledPackageOptions);

await buildPackage("apps/runtime/dist", {
  api: "apps/runtime/src/api.ts",
  cli: "apps/runtime/src/cli.ts",
  startup: "apps/runtime/src/startup.ts",
  worker: "apps/runtime/src/worker.ts",
});
