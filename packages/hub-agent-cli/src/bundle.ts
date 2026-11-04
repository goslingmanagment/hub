import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HUB_CREDENTIALS_PATH, parseHubCredentialsFile, resolveHubCredentials } from "./credentials.ts";
import { formatHubDocument, HUB_EXIT_ERROR, HUB_EXIT_OK, runHubCli } from "./main.ts";
import { VAULT_SKILL_TEXT } from "./vault-skill.ts";

/**
 * The entry of the one-file CLI for a computer without the checkout: a content
 * manager's own Claude (scripts/build-hub-cli.mjs builds it into the dashboard's
 * files as /hub-cli/hub.mjs). Everything else stays in cli.ts: on the operator's
 * machine that entry runs as before, pinned by the deploy.
 *
 * WHY IT REPLACES ITSELF. The CLI checks every answer against the contract built
 * into it, and the contract moves with the releases. Nobody will reinstall on that
 * computer, so before a command this file compares itself with the running release.
 * Offline, slow or a release without the file: it runs as it is.
 */

const KEY_PREFIX = "agency_hub_agent_";
const SKILL_PATH = join(homedir(), ".claude", "skills", "hub-vault", "SKILL.md");
const CHECK_TIMEOUT_MS = 3_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

const self = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

// Hub's own files, asked from the agent's computer: no platform is called, so the
// runtime's egress seam and its raw fetch( ratchet (scripts/check-raw-fetch.mjs)
// have no say here.
const fromHub = (url: string, timeoutMs: number): Promise<Response> =>
  globalThis.fetch(url, { signal: AbortSignal.timeout(timeoutMs) });

function finish(document: Record<string, unknown>, exitCode: number): never {
  process.stdout.write(`${formatHubDocument(document, argv.includes("--pretty"))}\n`);
  process.exit(exitCode);
}

function refuse(code: string, message: string): never {
  finish({ ok: false, operation: "setup", exitCode: HUB_EXIT_ERROR, error: { category: "cli", status: null, code, message } }, HUB_EXIT_ERROR);
}

/** True when this file was replaced by the release's. */
async function replacedByRelease(): Promise<boolean> {
  if (process.env.HUB_CLI_NO_UPDATE) return false;
  let baseUrl: string;
  try {
    ({ baseUrl } = resolveHubCredentials({ env: process.env }));
  } catch {
    return false; // No key: the command itself says so.
  }
  try {
    const answer = await fromHub(`${baseUrl}/hub-cli/hub.mjs.sha256`, CHECK_TIMEOUT_MS);
    const wanted = (await answer.text()).trim();
    // An unknown path answers with the dashboard's page and a 200: only a bare hash counts.
    if (!answer.ok || !/^[0-9a-f]{64}$/.test(wanted) || sha256(readFileSync(self)) === wanted) return false;
    const file = await fromHub(`${baseUrl}/hub-cli/hub.mjs`, DOWNLOAD_TIMEOUT_MS);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!file.ok || sha256(bytes) !== wanted) return false;
    const next = `${self}.${process.pid}`;
    try {
      writeFileSync(next, bytes);
      renameSync(next, self);
    } finally {
      rmSync(next, { force: true });
    }
    return true;
  } catch {
    return false;
  }
}

/** A release may change the skill: an installed one follows, none is added unasked. */
function refreshSkill(): void {
  try {
    if (existsSync(SKILL_PATH) && readFileSync(SKILL_PATH, "utf8") !== VAULT_SKILL_TEXT) writeFileSync(SKILL_PATH, VAULT_SKILL_TEXT);
  } catch {
    // The upload does not need the skill's newest words.
  }
}

async function setup(args: readonly string[]): Promise<never> {
  const at = args.indexOf("--key");
  const key = at === -1 ? undefined : args[at + 1]?.trim();
  if (key === undefined || !key.startsWith(KEY_PREFIX)) refuse("usage", `setup --key ${KEY_PREFIX}…: the key the owner issued for this computer`);
  const present = existsSync(HUB_CREDENTIALS_PATH)
    ? parseHubCredentialsFile(readFileSync(HUB_CREDENTIALS_PATH, "utf8")).HUB_AGENT_KEY
    : undefined;
  if (present !== undefined && present !== key && !args.includes("--force")) {
    refuse("credentials_present", `${HUB_CREDENTIALS_PATH} already holds another key: --force replaces it`);
  }

  // Checked before anything is written: a mistyped key leaves nothing behind.
  const checked = await runHubCli({ argv: ["capabilities"], env: { ...process.env, HUB_AGENT_KEY: key } });
  if (checked.exitCode !== HUB_EXIT_OK) finish({ ...checked.document, operation: "setup" }, checked.exitCode);

  mkdirSync(dirname(HUB_CREDENTIALS_PATH), { recursive: true });
  writeFileSync(HUB_CREDENTIALS_PATH, `HUB_AGENT_KEY=${key}\n`, { mode: 0o600 });
  chmodSync(HUB_CREDENTIALS_PATH, 0o600);
  mkdirSync(dirname(SKILL_PATH), { recursive: true });
  writeFileSync(SKILL_PATH, VAULT_SKILL_TEXT);

  const data = checked.document.data as {
    key: { capabilities: Array<{ capability: string; granted: boolean }> };
    grant: { pages: Array<{ pageLabel: string }> };
  };
  finish({
    ok: true,
    operation: "setup",
    exitCode: HUB_EXIT_OK,
    data: {
      credentials: HUB_CREDENTIALS_PATH,
      skill: SKILL_PATH,
      rights: data.key.capabilities.filter((one) => one.granted).map((one) => one.capability),
      pages: data.grant.pages.map((page) => page.pageLabel),
      next: "Ready. A new Claude session has the skill hub-vault: «залей пак в волт».",
    },
  }, HUB_EXIT_OK);
}

if (argv[0] === "setup") {
  await setup(argv.slice(1));
} else {
  if (await replacedByRelease()) {
    const again = spawnSync(process.execPath, [self, ...argv], { stdio: "inherit", env: { ...process.env, HUB_CLI_NO_UPDATE: "1" } });
    process.exit(again.status ?? HUB_EXIT_ERROR);
  }
  refreshSkill();
  await import("./cli.ts");
}
