import { readFileSync, statSync } from "node:fs";
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
 *
 * BUT IT DOES REFUSE AN OVER-PERMISSIVE ONE (review round 1). The file holds a
 * live bearer token to every granted page's transcripts and money. Because the
 * CLI never creates the file it cannot fix the mode either, so the only honest
 * options are silence and refusal, and silence around a world-readable secret is
 * how it stays world-readable. This is the ssh private-key precedent, including
 * the remedy in the message.
 */

export const HUB_DEFAULT_BASE_URL = "https://gosling-agency.ru";

export const HUB_CREDENTIALS_PATH = join(homedir(), ".config", "hub", "credentials");

export interface HubCredentialsInput {
  env: Record<string, string | undefined>;
  /** Injected by tests; production reads the real file. */
  readFile?: (path: string) => string | null;
  /** Injected by tests; production stats the real file. `null` = no such file. */
  fileMode?: (path: string) => number | null;
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function defaultFileMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

/** Any group or other bit set on a file holding a bearer token. */
function isOverPermissive(mode: number): boolean {
  return (mode & 0o077) !== 0;
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
  const mode = (input.fileMode ?? defaultFileMode)(HUB_CREDENTIALS_PATH);
  if (mode !== null && isOverPermissive(mode)) {
    throw new HubCredentialsError(
      `${HUB_CREDENTIALS_PATH} is readable by others (mode ${mode.toString(8).padStart(4, "0")}); `
      + `run: chmod 600 ${HUB_CREDENTIALS_PATH}`,
    );
  }
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
