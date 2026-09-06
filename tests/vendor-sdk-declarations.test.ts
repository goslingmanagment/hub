import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { expect, it } from "vitest";

const run = promisify(execFile);
const require = createRequire(import.meta.url);

it("emits and loads external SDK declarations with the complete owner action union", async () => {
  const target = await mkdtemp(join(tmpdir(), "ofapi-owner-sdk-declarations-"));
  try {
    // The 81-command union previously passed normal noEmit checks but made
    // actual external SDK declaration emission fail with TS7056 in routes.ts.
    await run(process.execPath, ["scripts/vendor-sdk.mjs", target, "--allow-dirty"], { maxBuffer: 2 * 1024 * 1024 });
    const contractsRequire = createRequire(join(process.cwd(), "packages/contracts/package.json"));
    await cp(dirname(contractsRequire.resolve("zod/package.json")), join(target, "node_modules/zod"), { recursive: true });
    const bundlePath = join(target, "runtime-check.cjs");
    await build({ entryPoints: [join(target, "dist/index.js")], outfile: bundlePath, bundle: true, platform: "node", format: "cjs" });
    const sdk = require(bundlePath);
    const manifest = JSON.parse(await readFile(join(target, "kernel-sdk.vendor.json"), "utf8"));
    expect(sdk.KERNEL_CONTRACT_HASH).toBe(manifest.contractHash);
    const operations = Object.keys(sdk.kernelOperations).filter(key => key.startsWith("ofapiAction")).sort();
    expect(operations).toEqual(["ofapiActionCancel", "ofapiActionDispatch", "ofapiActionGet", "ofapiActionList", "ofapiActionPrepare", "ofapiActionRepair"]);
    const client = sdk.createClient({ baseUrl: "https://sdk-check.invalid", fetch: () => { throw new Error("Packaging checks must never call the API"); } });
    for (const operation of operations) expect(typeof client[operation]).toBe("function");
    expect(sdk.routeSchemas.ofapiActionPrepare.body.shape.command.options).toHaveLength(81);

    // Compile a consumer of the shipped declarations, including negative
    // assignments: broadening the command to object/any must not fix packaging.
    await writeFile(join(target, "consumer.ts"), `
import type { KernelOperationRequest, KernelOperationResponse } from "./dist/index.js";
type Prepare = KernelOperationRequest<"ofapiActionPrepare">;
type Response = KernelOperationResponse<"ofapiActionGet">;
type Assert<T extends true> = T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Period = Extract<Prepare["body"]["command"], { action: "saved_post_autopost_update" }>["period"];
type ExactPeriod = Assert<Same<Period, 6 | 12 | 24 | 48>>;
type ExactResponseActions = Assert<Same<Response["command"]["action"], Prepare["body"]["command"]["action"]>>;
const native: Prepare = { body: { id: "00000000-0000-4000-8000-000000000001", command: { action: "saved_post_autopost_update", pageId: 1, period: 12 } } };
const publication: Prepare = { body: { id: "00000000-0000-4000-8000-000000000002", command: { action: "post_create", pageId: 1, text: "Ready" } } };
// @ts-expect-error Unsupported provider interval must remain a compile error.
const badPeriod: Prepare = { body: { id: "00000000-0000-4000-8000-000000000003", command: { action: "saved_post_autopost_update", pageId: 1, period: 8 } } };
// @ts-expect-error Unknown operations must remain a compile error.
const unknownAction: Prepare = { body: { id: "00000000-0000-4000-8000-000000000004", command: { action: "subscribe_user", pageId: 1 } } };
// @ts-expect-error A profile update must not become an untyped provider request.
const arbitraryBody: Prepare = { body: { id: "00000000-0000-4000-8000-000000000005", command: { action: "account_profile_update", pageId: 1, name: "Name", endpoint: "/bank" } } };
`);
    await run(join(process.cwd(), "node_modules/.bin/tsc"), ["--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "bundler", "consumer.ts"], { cwd: target, maxBuffer: 2 * 1024 * 1024 })
      .catch((error: Error & { stdout?: string; stderr?: string }) => {
        throw new Error(`${error.message}\n${error.stdout ?? ""}${error.stderr ?? ""}`, { cause: error });
      });
  } finally {
    await rm(target, { recursive: true, force: true });
  }
}, 120000);
