import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { KernelApiError, createClient, type KernelClient } from "@kernel/sdk";

import {
  HUB_COMMANDS,
  HubCompositeResult,
  HubUsageError,
  findHubCommand,
  type HubCommand,
  type HubOptionValues,
  type HubRunDeps,
} from "./commands.ts";
import {
  HUB_CREDENTIALS_PATH,
  HUB_DEFAULT_BASE_URL,
  HubCredentialsError,
  resolveHubCredentials,
} from "./credentials.ts";

/**
 * `hub` — the Agent Read Plane CLI.
 *
 * THE TWO PROMISES THIS FILE KEEPS:
 *
 * 1. **Exactly one JSON document on stdout, always.** Success, refusal, hub
 *    error, bad flag: all of them print a document. An agent parsing stdout never
 *    has to branch on "did it print anything".
 * 2. **The exit code carries the epistemic verdict, not just the transport.**
 *    `0` the answer came back — and NOTHING MORE: without `--fail-on-partial` a
 *    response whose `blockers` is non-empty still exits `0`, which is the normal
 *    case (`claim_not_declared` fires on every claimless call). `3` the answer
 *    came back, the hub listed reasons it is narrower than the question, AND
 *    `--fail-on-partial` was asked for; `4` no answer (hub error, refusal,
 *    timeout, bad flags). Completeness is read from the document, never from the
 *    exit code.
 *
 * WHY 3 EXISTS AT ALL. The obvious design, copied from the sibling `tg` tool, is
 * "always exit 0 and let the document speak". That works there because a failure
 * is a document in the same ontology. Here it is not: a 404 means the conclusion
 * is unreachable, and reporting that with a zero exit is the same lie as printing
 * a bare `[]`. Exit 3 is opt-in because a partial answer is often exactly what was
 * wanted; what must never happen is a partial answer read as a complete one.
 *
 * THE HTTP GOES THROUGH THE GENERATED SDK AND NOWHERE ELSE. Not a style
 * preference: the SDK validates every successful response against the same Zod
 * contract the server enforces, so a hub that drifted from this CLI's expectations
 * fails loudly here instead of handing an agent a body it will misread.
 */

/** The call succeeded. NOT a completeness verdict: `blockers` can be non-empty. */
export const HUB_EXIT_OK = 0;
/** The answer came back with blockers, and --fail-on-partial was passed. */
export const HUB_EXIT_PARTIAL = 3;
/** No answer: hub error, refusal, timeout, or a flag this CLI could not use. */
export const HUB_EXIT_ERROR = 4;

const GLOBAL_OPTIONS = {
  "base-url": { type: "string" },
  "fail-on-partial": { type: "boolean" },
  pretty: { type: "boolean" },
  help: { type: "boolean" },
} as const;

export interface HubCliResult {
  exitCode: number;
  /** The single document that goes to stdout. */
  document: Record<string, unknown>;
}

export interface HubCliDeps {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  /** Injected by tests; production builds one from the resolved credentials. */
  createHubClient?: (options: { baseUrl: string; token: string }) => KernelClient;
  readFile?: (path: string) => string | null;
  fileMode?: (path: string) => number | null;
  /** The composites' clock (`history-status --wait`); injected by tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  randomUUID?: () => string;
}

function readLocalFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function usageDocument(message: string, command?: HubCommand): Record<string, unknown> {
  return {
    ok: false,
    operation: command?.operation ?? null,
    exitCode: HUB_EXIT_ERROR,
    error: {
      category: "usage",
      status: null,
      code: "usage",
      message,
      ...(command
        ? {
          command: command.name,
          options: Object.fromEntries(
            Object.entries(command.options).map(([name, option]) => [
              name,
              `${option.kind}: ${option.describe}`,
            ]),
          ),
        }
        : {
          commands: Object.fromEntries(
            HUB_COMMANDS.map((entry) => [entry.name, entry.summary]),
          ),
          credentials: `HUB_AGENT_KEY, or HUB_AGENT_KEY=... in ${HUB_CREDENTIALS_PATH}`,
          baseUrl: `HUB_BASE_URL (default ${HUB_DEFAULT_BASE_URL})`,
          exitCodes: {
            "0": "call succeeded; `blockers` may still be non-empty, read it",
            "3": "answer has blockers and --fail-on-partial was passed",
            "4": "no answer",
          },
        }),
    },
  };
}

/**
 * The blockers an answer carries.
 *
 * Read defensively rather than through the response type: `capabilities` has no
 * conclusion at all, and a hub one version ahead may add a shape this build does
 * not know. An unreadable conclusion is reported as no blockers, never as a
 * fabricated one.
 */
function blockersOf(data: unknown): string[] {
  if (typeof data !== "object" || data === null) {
    return [];
  }
  const conclusion = (data as { conclusion?: unknown }).conclusion;
  if (typeof conclusion !== "object" || conclusion === null) {
    return [];
  }
  const blockers = (conclusion as { blockers?: unknown }).blockers;
  return Array.isArray(blockers) ? blockers.filter((item) => typeof item === "string") : [];
}

/** Error text is metadata, so it is bounded. A driver or a hub can put an
 *  arbitrary amount of prose in a message; the CLI's job is to name the failure,
 *  not to relay a payload. */
const HUB_ERROR_MESSAGE_MAX = 500;

function boundedMessage(text: string): string {
  return text.length <= HUB_ERROR_MESSAGE_MAX
    ? text
    : `${text.slice(0, HUB_ERROR_MESSAGE_MAX)}... (truncated)`;
}

/**
 * Failure metadata, and DELIBERATELY NOT THE RESPONSE BODY (review round 2).
 *
 * `KernelApiError.body` on a 2xx that failed contract validation is the COMPLETE
 * UNVALIDATED payload, and on a non-2xx it is whatever arrived. Printing it would
 * hand the agent exactly what the schema refused, including fields the contract
 * deliberately excludes (signed CDN URLs are the standing example). SDK
 * validation is the boundary of what this plane will show a model, and a
 * diagnostic channel that routes around the boundary is not a diagnostic channel,
 * it is a second, unvalidated read path.
 *
 * What survives is enough to act on: which operation, which status, which code,
 * and a bounded message. The message on a validation failure is the SDK's issue
 * list, which names paths and expected types and carries no values.
 */
function errorDocument(command: HubCommand, error: unknown): Record<string, unknown> {
  const operation = command.operation;
  if (error instanceof KernelApiError) {
    // A command may name the next step for a refusal it expects (the history
    // commands' hydration fallback on a page the engine does not own yet).
    const hint = command.hint?.(error) ?? null;
    return {
      ok: false,
      operation,
      exitCode: HUB_EXIT_ERROR,
      error: {
        category: error.category,
        status: error.status,
        code: error.code,
        message: boundedMessage(error.message),
        ...(hint === null ? {} : { hint }),
      },
    };
  }
  return {
    ok: false,
    operation,
    exitCode: HUB_EXIT_ERROR,
    error: {
      category: "cli",
      status: null,
      code: "unexpected",
      message: boundedMessage(error instanceof Error ? error.message : String(error)),
    },
  };
}

export async function runHubCli(deps: HubCliDeps): Promise<HubCliResult> {
  let globals;
  try {
    globals = parseArgs({
      args: [...deps.argv],
      options: GLOBAL_OPTIONS,
      allowPositionals: true,
      strict: false,
    });
  } catch (error) {
    return {
      exitCode: HUB_EXIT_ERROR,
      document: usageDocument(error instanceof Error ? error.message : String(error)),
    };
  }

  const commandName = globals.positionals[0];
  if (commandName === undefined || globals.values.help === true) {
    const command = commandName === undefined ? undefined : findHubCommand(commandName);
    return {
      exitCode: HUB_EXIT_ERROR,
      document: usageDocument(
        commandName === undefined ? "no command given" : `usage for "${commandName}"`,
        command,
      ),
    };
  }

  const command = findHubCommand(commandName);
  if (!command) {
    return {
      exitCode: HUB_EXIT_ERROR,
      document: usageDocument(`unknown command "${commandName}"`),
    };
  }

  // Parsed a SECOND time, now strictly and against this command's own options, so
  // a typo in a flag name is a refusal rather than a filter that silently did not
  // apply. The first pass was deliberately loose: it only had to find the command.
  const options: Record<string, { type: "string" | "boolean"; multiple?: boolean }> = {
    ...GLOBAL_OPTIONS,
  };
  for (const [name, option] of Object.entries(command.options)) {
    options[name] = option.kind === "boolean"
      ? { type: "boolean" }
      : option.kind === "list"
        ? { type: "string", multiple: true }
        : { type: "string" };
  }

  let values: HubOptionValues;
  let failOnPartial: boolean;
  let baseUrlOverride: string | undefined;
  try {
    const parsed = parseArgs({
      args: [...deps.argv],
      options,
      allowPositionals: true,
      strict: true,
    });
    // EXACTLY the command word. `parseArgs` collects trailing positionals and
    // says nothing about them, so `hub threads lora-2` used to run a query over
    // every granted page and exit 0: a scope typo silently WIDENING the answer,
    // which is the false-completeness family this whole plane exists to prevent.
    if (parsed.positionals.length > 1) {
      const stray = parsed.positionals.slice(1).map((value) => `"${value}"`).join(", ");
      throw new Error(
        `unexpected argument ${stray}: every input is a named flag, so a bare word `
        + "would be silently ignored (see --help)",
      );
    }
    values = parsed.values as HubOptionValues;
    failOnPartial = parsed.values["fail-on-partial"] === true;
    const override = parsed.values["base-url"];
    baseUrlOverride = typeof override === "string" ? override : undefined;
  } catch (error) {
    return {
      exitCode: HUB_EXIT_ERROR,
      document: usageDocument(error instanceof Error ? error.message : String(error), command),
    };
  }

  let credentials;
  try {
    credentials = resolveHubCredentials({
      env: deps.env,
      ...(deps.readFile ? { readFile: deps.readFile } : {}),
      ...(deps.fileMode ? { fileMode: deps.fileMode } : {}),
    });
  } catch (error) {
    if (error instanceof HubCredentialsError) {
      return { exitCode: HUB_EXIT_ERROR, document: usageDocument(error.message) };
    }
    throw error;
  }

  const baseUrl = (baseUrlOverride ?? credentials.baseUrl).replace(/\/+$/, "");
  const createHubClient = deps.createHubClient
    ?? ((input) => createClient({
      baseUrl: input.baseUrl,
      auth: { mode: "bearer", token: () => input.token },
    }));
  const client = createHubClient({ baseUrl, token: credentials.token });

  const runDeps: HubRunDeps = {
    readFile: deps.readFile ?? readLocalFile,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: deps.now ?? Date.now,
    randomUUID: deps.randomUUID ?? randomUUID,
  };
  let data: unknown;
  try {
    data = await command.run(client, values, runDeps);
  } catch (error) {
    if (error instanceof HubUsageError) {
      return {
        exitCode: HUB_EXIT_ERROR,
        document: usageDocument(error.message, command),
      };
    }
    return { exitCode: HUB_EXIT_ERROR, document: errorDocument(command, error) };
  }

  if (data instanceof HubCompositeResult) {
    // Several calls, one document. A failed call is reported inside `data`
    // (metadata only) and turns the whole run into "no complete answer" (4),
    // without dropping what the other calls returned.
    const compositeBlockers = blockersOf(data.data);
    const exitCode = data.failed > 0
      ? HUB_EXIT_ERROR
      : failOnPartial && compositeBlockers.length > 0 ? HUB_EXIT_PARTIAL : HUB_EXIT_OK;
    return {
      exitCode,
      document: {
        ok: data.failed === 0,
        operation: command.operation,
        exitCode,
        composite: data.meta,
        blockers: compositeBlockers,
        data: data.data,
      },
    };
  }

  const blockers = blockersOf(data);
  const exitCode = failOnPartial && blockers.length > 0 ? HUB_EXIT_PARTIAL : HUB_EXIT_OK;
  return {
    exitCode,
    document: {
      ok: true,
      operation: command.operation,
      exitCode,
      // Lifted out of the body on purpose: this list IS the exit-code contract,
      // and an agent that reads nothing else must still see it.
      blockers,
      data,
    },
  };
}

/** Formats the single document. `--pretty` is for humans reading a terminal. */
export function formatHubDocument(
  document: Record<string, unknown>,
  pretty: boolean,
): string {
  return pretty ? JSON.stringify(document, null, 2) : JSON.stringify(document);
}

