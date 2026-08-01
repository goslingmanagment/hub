import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AGENT_DATASETS,
  agentDatasetFieldSortable,
  agentRouteSchemas,
} from "@agency_hub_core/contracts";
import type { KernelClient } from "@kernel/sdk";

import { findHubCommand } from "../packages/hub-agent-cli/src/commands.ts";
import { HUB_EXIT_OK, runHubCli } from "../packages/hub-agent-cli/src/main.ts";

/**
 * Every `hub` command line printed in the docs, executed against the real
 * parser and the real contract.
 *
 * WHY THIS FILE EXISTS. Three command lines shipped in `docs/agent-read-skill.md`
 * could not have worked: the transcript example omitted `--to` on an operation
 * whose contract requires both bounds (400), the dataset example filtered on
 * `type` and `amountMills` when the registered fields are `transactionType` and
 * `grossMills` (400 before any SQL), and the enablement runbook told the owner to
 * run `hub threads --page` against a STRICT parser that refuses an unknown flag
 * (exit 4). Prose drifts silently from a contract; a test does not. A runbook
 * whose smoke test fails is worse than no runbook.
 *
 * The hub itself is a stub — what is under test is the flag surface and the
 * request each documented line builds, not the answer it would get.
 */

const ENV = { HUB_AGENT_KEY: "agency_hub_agent_docs-test" };
const NO_FILE = () => null;
const NO_MODE = () => null;

function docText(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

/**
 * Command lines out of fenced blocks, with backslash continuations joined.
 *
 * A line carrying a `<placeholder>` is skipped on purpose: those are teaching
 * shapes (`hub <command> [flags]`), not runnable commands, and the docs are
 * written so that every line WITHOUT one is literally runnable.
 */
function hubCommandLines(markdown: string): string[] {
  const joined = markdown.replace(/\\\n\s*/g, " ");
  const lines: string[] = [];
  let inFence = false;
  for (const rawLine of joined.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      continue;
    }
    const command = line.startsWith("pnpm hub ") ? line.slice("pnpm ".length) : line;
    if (!command.startsWith("hub ") || command.includes("<")) {
      continue;
    }
    lines.push(command);
  }
  return lines;
}

/** A shell-ish tokenizer: enough for the quoting the docs actually use. */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const character of command) {
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (character === " ") {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

function stubClient(calls: Array<{ method: string; input: unknown }>) {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, property: string) {
      return (input: unknown) => {
        calls.push({ method: property, input });
        return Promise.resolve({ conclusion: { blockers: [] } });
      };
    },
  };
  return new Proxy({}, handler) as unknown as KernelClient;
}

async function runDocumentedLine(command: string) {
  const calls: Array<{ method: string; input: unknown }> = [];
  const argv = tokenize(command).slice(1);
  const result = await runHubCli({
    argv,
    env: ENV,
    readFile: NO_FILE,
    fileMode: NO_MODE,
    createHubClient: () => stubClient(calls),
  });
  return { argv, calls, result };
}

/** Validates whatever halves of the request the route declares. */
function expectRequestMatchesContract(command: string, operation: string, input: unknown) {
  const route = (agentRouteSchemas as Record<string, {
    params?: { safeParse: (value: unknown) => { success: boolean; error?: unknown } };
    querystring?: { safeParse: (value: unknown) => { success: boolean; error?: unknown } };
    body?: { safeParse: (value: unknown) => { success: boolean; error?: unknown } };
  }>)[operation];
  expect(route, `${operation} is not a declared agent route`).toBeDefined();
  const request = (input ?? {}) as Record<string, unknown>;
  for (const half of ["params", "querystring", "body"] as const) {
    const schema = route?.[half];
    if (schema === undefined) {
      continue;
    }
    const value = half === "querystring" ? request.query : request[half];
    const parsed = schema.safeParse(value ?? {});
    expect(parsed.success, `${command}\n  ${half}: ${JSON.stringify(parsed.error ?? "")}`)
      .toBe(true);
  }
}

const SKILL_DOC = "docs/agent-read-skill.md";
const RUNBOOK = "docs/runbooks/agent-read-plane-enablement.md";

describe("the documented hub command lines", () => {
  for (const doc of [SKILL_DOC, RUNBOOK]) {
    const commands = hubCommandLines(docText(doc));

    it(`${doc} still teaches runnable commands`, () => {
      // A doc rewrite that quietly dropped every example must not leave this
      // file passing vacuously.
      expect(commands.length).toBeGreaterThanOrEqual(2);
    });

    for (const command of commands) {
      it(`${doc}: ${command}`, async () => {
        const { argv, calls, result } = await runDocumentedLine(command);
        // Exit 4 here means the CLI refused its own documented flags: an unknown
        // flag, a missing required one, or a value outside a closed enum.
        expect(result.exitCode, JSON.stringify(result.document.error ?? {})).toBe(HUB_EXIT_OK);
        expect(calls).toHaveLength(1);

        const hubCommand = findHubCommand(argv[0] ?? "");
        expect(hubCommand, `no such command: ${argv[0]}`).toBeDefined();
        expect(calls[0]?.method).toBe(hubCommand?.operation);
        expectRequestMatchesContract(command, hubCommand!.operation, calls[0]?.input);
      });
    }
  }

  it("documents dataset filters and sorts over REGISTERED fields only", async () => {
    const datasetLines = [...hubCommandLines(docText(SKILL_DOC)), ...hubCommandLines(docText(RUNBOOK))]
      .filter((command) => command.startsWith("hub dataset"));
    expect(datasetLines.length).toBeGreaterThanOrEqual(1);

    for (const command of datasetLines) {
      const { calls } = await runDocumentedLine(command);
      const input = calls[0]?.input as {
        params: { dataset: keyof typeof AGENT_DATASETS };
        body: { filters?: Array<{ field: string }>; sort?: Array<{ field: string }> };
      };
      const definition = AGENT_DATASETS[input.params.dataset];
      expect(definition, `unknown dataset ${String(input.params.dataset)}`).toBeDefined();
      const fields = definition.fields as Record<string, string>;
      for (const filter of input.body.filters ?? []) {
        expect(Object.hasOwn(fields, filter.field), `${command}\n  filter field ${filter.field}`)
          .toBe(true);
      }
      for (const sort of input.body.sort ?? []) {
        expect(
          agentDatasetFieldSortable(input.params.dataset, sort.field),
          `${command}\n  sort field ${sort.field}`,
        ).toBe(true);
      }
    }
  });
});

describe("the skill doc names fields that exist", () => {
  it("never sends an agent to `capture.captureFloor`, which is not on the envelope", () => {
    const text = docText(SKILL_DOC);
    // The floor is per PLANE (and per item). A doc that told an agent to read a
    // top-level one handed it `undefined` at the exact moment it was deciding
    // whether something is absent — the failure this whole plane exists to stop.
    expect(text).not.toMatch(/`capture\.captureFloor`(?! at the top| to quote)/);
    expect(text).toContain("capture.planes[].captureFloor");
  });

  it("says exit 0 is a transport verdict, not a completeness one", () => {
    const text = docText(SKILL_DOC);
    expect(text).toContain("`0` means the call succeeded, NOT that the answer is complete");
    expect(text).toContain("--fail-on-partial");
    // The old text claimed a 0 meant "no known narrowing", which is false: a
    // claimless call always carries `claim_not_declared` and still exits 0.
    expect(text).not.toContain("an answer came back with no known narrowing");
    expect(text).toContain("claim_not_declared");
  });

  it("describes hydration requests as existing, not as a 404", () => {
    const text = docText(SKILL_DOC);
    expect(text).not.toContain("calling the route would 404");
    expect(text).toContain("/api/v1/agent/pages/:pageLabel/threads/:conversationRef/hydration-requests");
    expect(text).toContain("request:hydration");
  });
});
