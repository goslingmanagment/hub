import { routeSchemas } from "@agency_hub_core/contracts";
import type { KernelClient } from "@kernel/sdk";

import { HubUsageError, type HubCommand } from "./commands.ts";

/**
 * What the operation's contract says about a command's request, said BEFORE the
 * request goes out.
 *
 * WHY. The help said "Maximum records in this response" and "Window start", and
 * the hub refused the rest: agents asked `transcript` for 300-5000 rows and read
 * windowed operations without a window, 267 refusals (400) of the transcript
 * route alone in the two weeks to 2026-11-06 (nginx), each a round trip and a
 * turn. The bounds and the window rule live in the operation's own schema, so
 * the help and the check below both read them there: no number is copied into
 * this CLI, and a contract that moves moves both.
 */

interface ContractIssue {
  path: PropertyKey[];
  message: string;
}

/** The part of a Zod schema read here (the CLI does not depend on zod itself). */
interface ContractSchema {
  safeParse(value: unknown): { success: true } | { success: false; error: { issues: ContractIssue[] } };
  shape?: Record<string, unknown>;
}

interface ContractRoute {
  querystring?: ContractSchema;
  body?: ContractSchema;
}

function routeOf(operation: string): ContractRoute | undefined {
  return (routeSchemas as unknown as Record<string, ContractRoute | undefined>)[operation];
}

/** The request schema holding `field`: the query's, else the body's. */
function schemaWith(operation: string, field: string): ContractSchema | undefined {
  const route = routeOf(operation);
  return [route?.querystring, route?.body].find((schema) => schema?.shape?.[field] !== undefined);
}

interface FieldLike {
  safeParse(value: unknown): { success: boolean; data?: unknown };
  unwrap?: () => FieldLike;
  minValue?: unknown;
  maxValue?: unknown;
}

/** `limit` as the schema declares it, or null when this code cannot read it (then the help says nothing extra). */
function limitBounds(schema: ContractSchema): { min: number; max: number; fallback: unknown } | null {
  let field = schema.shape?.limit as FieldLike | undefined;
  if (field === undefined) {
    return null;
  }
  const empty = field.safeParse(undefined);
  const fallback = empty.success ? empty.data : undefined;
  for (let depth = 0; depth < 4 && typeof field.unwrap === "function"; depth += 1) {
    field = field.unwrap();
  }
  const { minValue: min, maxValue: max } = field;
  return typeof min === "number" && Number.isFinite(min) && typeof max === "number" && Number.isFinite(max)
    ? { min, max, fallback }
    : null;
}

/**
 * Whether the operation refuses a request without `from`/`to`: an empty request
 * is put to its schema and the window issue answers. The rule is a refinement,
 * not a field property, so asking the schema is the only way to read it. Null
 * when the empty request is refused for another reason first (`search` needs
 * `q`): the help then says nothing, and the check below still refuses.
 */
function windowRequired(schema: ContractSchema): boolean | null {
  const result = schema.safeParse({});
  if (result.success) {
    return false;
  }
  return result.error.issues.some((issue) => issue.path.length === 1 && issue.path[0] === "from") ? true : null;
}

/** The command's options as the help prints them, with the contract's bounds on `--limit` and `--from`/`--to`. */
export function hubOptionHelp(command: HubCommand): Record<string, string> {
  const cursor = "cursor" in command.options;
  const limitSchema = "limit" in command.options ? schemaWith(command.operation, "limit") : undefined;
  const limit = limitSchema === undefined ? null : limitBounds(limitSchema);
  const windowSchema = "from" in command.options ? schemaWith(command.operation, "from") : undefined;
  const window = windowSchema === undefined ? null : windowRequired(windowSchema);
  return Object.fromEntries(Object.entries(command.options).map(([name, option]) => {
    let text = option.describe;
    if (name === "limit" && limit !== null) {
      text += `: ${limit.min} to ${limit.max}`;
      if (typeof limit.fallback === "number") {
        text += `, default ${limit.fallback}`;
      }
      if (cursor) {
        text += "; more: follow --cursor";
      }
    }
    if ((name === "from" || name === "to") && window === true) {
      text += cursor ? "; required unless --cursor" : "; required";
    }
    return [name, `${option.kind}: ${text}`];
  }));
}

/**
 * The query as the hub's schema receives it. The SDK (sdk-runtime.ts,
 * buildQuery) writes each value with String() and an array as repeated keys,
 * dropping undefined and null; the hub's query parser reads one key back as a
 * string and a repeated one as an array.
 */
export function hubWireQuery(query: Record<string, unknown>): Record<string, string | string[]> {
  const wire: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }
    const items = Array.isArray(value) ? value.map(String) : [String(value)];
    if (items.length === 1) {
      wire[key] = items[0]!;
    } else if (items.length > 1) {
      wire[key] = items;
    }
  }
  return wire;
}

/** At most this many issues in one refusal, like the hub's own 400. */
const ISSUES_SHOWN = 5;

/** The issues the operation's schema finds in this request, or none. Params are the path, not the question: not checked. */
export function hubRequestIssues(
  operation: string,
  input: { query?: Record<string, unknown>; body?: unknown } | undefined,
): string[] {
  const route = routeOf(operation);
  const parts: Array<[string, ContractSchema | undefined, unknown]> = [
    ["query", route?.querystring, input?.query === undefined ? undefined : hubWireQuery(input.query)],
    // A body goes out as JSON: what the hub parses is the round trip, not the object.
    ["body", route?.body, input?.body === undefined ? undefined : JSON.parse(JSON.stringify(input.body))],
  ];
  const issues: string[] = [];
  for (const [where, schema, value] of parts) {
    // Nothing sent, or no schema here: the hub decides, as before.
    if (schema === undefined || value === undefined) {
      continue;
    }
    const result = schema.safeParse(value);
    if (!result.success) {
      issues.push(...result.error.issues.map((issue) => `${issue.path.map(String).join(".") || where}: ${issue.message}`));
    }
  }
  return issues;
}

/**
 * The client a command runs with. A command that takes `--limit` or a window has
 * its FIRST request of its operation put to the operation's schema: one the hub
 * would refuse with 400 is refused here, nothing is sent, and the usage document
 * prints the options with their bounds. Only the first: it is the one built from
 * the flags; later calls follow the hub's own cursor (`--all`) or repeat it
 * (`--wait`). Other commands go out as before.
 */
export function hubCheckedClient(client: KernelClient, command: HubCommand): KernelClient {
  if (!("limit" in command.options) && !("from" in command.options)) {
    return client;
  }
  let checked = false;
  return new Proxy(client, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (key !== command.operation || checked || typeof value !== "function") {
        return value;
      }
      return async (input?: { query?: Record<string, unknown>; body?: unknown }) => {
        checked = true;
        const issues = hubRequestIssues(command.operation, input);
        if (issues.length > 0) {
          const shown = issues.slice(0, ISSUES_SHOWN).join("; ");
          const more = issues.length > ISSUES_SHOWN ? `; ${issues.length - ISSUES_SHOWN} more` : "";
          throw new HubUsageError(`the hub would refuse this request (its contract), so nothing was sent: ${shown}${more}`);
        }
        return (value as (input: unknown) => Promise<unknown>).call(target, input);
      };
    },
  });
}
