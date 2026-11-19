/**
 * A build-only Vite plugin of both web apps: the routes' OpenAPI prose stays out of the browser bundles.
 *
 * The SDK keeps every route of `routeSchemas` (it validates each response by its operation at run time), so the
 * bundler cannot drop one, and with it came every route's `summary` and `description`. Only the server's OpenAPI
 * reads them (`packages/contracts/src/generate.ts`, `generate-sdk.ts`), and it is built without Vite. So in the
 * modules of `packages/contracts/src`, in every object literal with both an `auth` and a `response` property (a
 * route's definition), the `summary` and `description` properties are cut out. Nothing else: no other key, object or
 * file. `vite` dev servers (`pnpm dev`, `dev:demo`) never run it.
 *
 * Outside `src` on purpose: no app's tsconfig compiles it, and it imports nothing (a plain plugin object).
 */

/** An ESTree node as Rollup's `this.parse` gives it (offsets into the code it was handed). */
interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

const CONTRACTS_MODULE = /\/packages\/contracts\/src\/[^/]+\.ts$/;
const PROSE = new Set(["summary", "description"]);

function keyName(node: AstNode): string | null {
  if (node.type !== "Property" || node.computed) return null;
  const key = node.key as AstNode;
  if (key.type === "Identifier") return key.name as string;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return null;
}

/** The [from, to) ranges to cut: each prose property of a route's definition with what separates it from the next. */
function proseRanges(code: string, root: AstNode): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const node = value as AstNode;
    if (node.type === "ObjectExpression" && code[node.end - 1] === "}") {
      const properties = node.properties as AstNode[];
      const keys = properties.map(keyName);
      if (keys.includes("auth") && keys.includes("response")) {
        properties.forEach((property, index) => {
          if (!PROSE.has(keys[index] ?? "")) return;
          // Up to the next property (its comma goes with it); the last one up to the closing brace, so a
          // trailing comma goes too and the comma before it stays (a trailing comma is valid in an object).
          const next = properties[index + 1];
          ranges.push([property.start, next ? next.start : node.end - 1]);
        });
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "type" && key !== "start" && key !== "end") visit(child);
    }
  };
  visit(root);
  ranges.sort((a, b) => a[0] - b[0]);
  // A range inside one already taken (a route's definition inside a prose value) is cut with it.
  const cuts: Array<[number, number]> = [];
  let end = 0;
  for (const range of ranges) {
    if (range[0] < end) continue;
    cuts.push(range);
    end = range[1];
  }
  return cuts;
}

export function stripRouteProse() {
  return {
    name: "hub:strip-route-prose",
    apply: "build" as const,
    transform(this: { parse(code: string): unknown }, code: string, id: string) {
      if (!CONTRACTS_MODULE.test(id) || !code.includes("auth")) return null;
      const ranges = proseRanges(code, this.parse(code) as AstNode);
      if (ranges.length === 0) return null;
      let out = "";
      let at = 0;
      for (const [from, to] of ranges) {
        out += code.slice(at, from);
        at = to;
      }
      return { code: out + code.slice(at), map: null };
    },
  };
}
