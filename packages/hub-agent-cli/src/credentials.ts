import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the CLI finds its key and its hub.
 *
 * TWO SOURCES, IN THIS ORDER: the `HUB_AGENT_KEY` environment variable, then
 * `~/.config/hub/credentials`. The env var wins so a single call can be pointed at
 * a different key without editing a file, which is what a one-off audit run needs.
 *
 * THE CLI CREATES NO STATE. It reads the credentials file if it is there and
 * never writes one: the sibling `tg` tool taught this lesson the expensive way,
 * where one-shot invocations left eight abandoned receipts behind. A missing file
 * is not an error worth a stack trace; it is one clear message naming both places
 * the key could have been.
 */

export const HUB_DEFAULT_BASE_URL = "https://gosling-agency.ru";

export const HUB_CREDENTIALS_PATH = join(homedir(), ".config", "hub", "credentials");

export interface HubCredentialsInput {
  env: Record<string, string | undefined>;
  /** Injected by tests; production reads the real file. */
  readFile?: (path: string) => string | null;
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Parses the credentials file.
 *
 * The format is deliberately the dumbest thing that works: `KEY=value` lines,
 * `#` comments, blank lines ignored. A token containing `=` survives, because
 * only the FIRST `=` splits. Anything else (TOML, JSON, a keychain call) would be
 * one more thing to get wrong in a file whose only job is to hold one secret.
 */
export function parseHubCredentialsFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export interface HubCredentials {
  token: string;
  baseUrl: string;
  /** Which source the token came from, so `hub whoami`-style output can say. */
  tokenSource: "env" | "file";
}

export class HubCredentialsError extends Error {}

/**
 * Resolves the token and the base URL.
 *
 * `HUB_BASE_URL` (env, then file) overrides the production default. There is no
 * "dev" flag: pointing at a local hub is done by naming its URL, so a call can
 * never quietly land on the wrong deployment because a flag was left set.
 */
export function resolveHubCredentials(input: HubCredentialsInput): HubCredentials {
  const readFile = input.readFile ?? defaultReadFile;
  const fileText = readFile(HUB_CREDENTIALS_PATH);
  const fileValues = fileText === null ? {} : parseHubCredentialsFile(fileText);

  const envToken = input.env.HUB_AGENT_KEY?.trim();
  const fileToken = fileValues.HUB_AGENT_KEY?.trim();
  const token = envToken !== undefined && envToken !== "" ? envToken : fileToken;

  if (token === undefined || token === "") {
    throw new HubCredentialsError(
      `no agent key: set HUB_AGENT_KEY or put HUB_AGENT_KEY=... in ${HUB_CREDENTIALS_PATH}`,
    );
  }

  const envBaseUrl = input.env.HUB_BASE_URL?.trim();
  const fileBaseUrl = fileValues.HUB_BASE_URL?.trim();
  const baseUrl = envBaseUrl !== undefined && envBaseUrl !== ""
    ? envBaseUrl
    : fileBaseUrl !== undefined && fileBaseUrl !== ""
      ? fileBaseUrl
      : HUB_DEFAULT_BASE_URL;

  return {
    token,
    // A trailing slash would double up against the operation paths, which all
    // begin with `/api/v1/`.
    baseUrl: baseUrl.replace(/\/+$/, ""),
    tokenSource: envToken !== undefined && envToken !== "" ? "env" : "file",
  };
}
