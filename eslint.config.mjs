import js from "@eslint/js";
import tseslint from "typescript-eslint";
import tsParser from "@typescript-eslint/parser";

const moneyRestriction = {
  selector: "CallExpression > Identifier[name='toMills']",
  message: "toMills was deleted (Stage 27): use millsFromInteger / millsFromDollars / millsFromCents.",
};
const dynamicUndiciRestriction = {
  selector: "ImportExpression > Literal[value='undici']",
  message: "Dynamic undici imports bypass the Stage 26 wall: use undiciRequest from @agency_hub_core/shared (http-client) or resolve transports via resolveEgress.",
};
const undiciRestrictions = [{
  selector: "ImportDeclaration[source.value='undici'][importKind='value']",
  message: "Import undici only inside services/egress or packages/shared/http-client (Stage 26): resolve transports via resolveEgress.",
}, dynamicUndiciRestriction];
const websocketMessage = "WebSocket transport belongs only in services/egress: use the page-scoped egress constructor.";
const dynamicWsRestriction = {
  selector: "ImportExpression > Literal[value=/^ws($|\\u002F)/]",
  message: websocketMessage,
};

// The family lint standard (Stage 35), grown from the Stage 19 bootstrap.
// Two layers:
// - Base hygiene seeded from the desktop's config: js/ts recommended,
//   no-unused-vars with the `_` escape hatch, consistent-type-imports,
//   no-explicit-any (assertions across trust boundaries get reviewed).
// - The architecture walls earlier stages introduced: changes require an
//   explicit rationale and updated regression coverage. The
//   auth-declaration gate is a contracts unit test, not a lint rule, so it
//   cannot be skipped by skipping lint. The `platform ===` and raw-fetch
//   ratchets are counted scripts inside the test suite, not lint rules.
//
// Module-boundary walls, both on import SPECIFIERS:
// 1. Path-qualified deep imports naming a modules/ internal (the composition
//    root and services must use "./modules/<m>/index.ts").
// 2. Relative sibling imports from inside a module: every module is a single
//    modules/<name>/index.ts, so "../<other>/<file>" is a cross-module reach —
//    allowed only for "../<other>/index.ts"; "../context.ts" (the shared
//    module context) is one segment and passes.

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      ".claude/worktrees/**",
      "apps/dashboard/**",
      "artifacts/**",
      "docs/**",
      "packages/contracts/src/generated/**",
      ".playwright-cli/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/scripts/**/*.mjs", "**/*.config.*", "**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
        performance: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        AbortController: "readonly",
        crypto: "readonly",
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": "off",
    },
  },
  {
    files: ["**/*.d.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "off",
    },
  },
  {
    files: ["apps/runtime/src/**/*.ts", "packages/*/src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      // Kernel Stage 27: toMills is dead — money enters through the codec's
      // source-named constructors (packages/shared/src/money.ts) only.
      // Stage 26 blocks static and dynamic undici value imports; the
      // resolver and existing HTTP importers are exempted below.
      "no-restricted-syntax": ["error", moneyRestriction, ...undiciRestrictions],
      "no-restricted-imports": ["error", {
        paths: [{
          // Kernel Stage 29: vendor AI SDKs live only inside the gateway
          // (services/ai-gateway*) — everything else goes through it, so
          // spend, budgets, and the restricted capture class cannot be
          // bypassed. The exemption block below carves out the gateway.
          name: "@anthropic-ai/sdk",
          message: "Vendor AI SDK imports are gateway-only (Stage 29): call the gateway (prepareAiGatewayStream / runGatewayCompletion).",
        }, {
          // Decision #216: drizzle's builtin `jsonb` JSON.parses a value that
          // node-postgres already parsed, so a stored JSON string comes back as
          // whatever it re-parses to ("4" → 4). Use the `jsonbSafe` custom type
          // in packages/db/src/schema.ts instead — every other export here is
          // fine, so only this one name is blocked.
          name: "drizzle-orm/pg-core",
          importNames: ["jsonb"],
          message: "drizzle's builtin jsonb double-parses on read (decision #216): declare the column with the jsonbSafe custom type in packages/db/src/schema.ts.",
        }],
        patterns: [
          {
            group: [
              "**/modules/*/*",
              "**/modules/*/*/**",
              "!**/modules/*/index.ts",
            ],
            message: "Import a module only through its modules/<name>/index.ts.",
          },
        ],
      }],
    },
  },
  {
    files: ["apps/runtime/src/**/*.ts", "packages/*/src/**/*.ts"],
    ignores: ["apps/runtime/src/services/egress/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", moneyRestriction, ...undiciRestrictions, dynamicWsRestriction],
      "no-restricted-globals": ["error", { name: "WebSocket", message: websocketMessage }],
      // Also covers computed access and destructuring a constructor alias.
      "no-restricted-properties": ["error", ...["globalThis", "global", "window", "self"].map((object) => ({
        object, property: "WebSocket", message: websocketMessage,
      }))],
      // A separate rule preserves the core import rule's AI/module walls,
      // including their later exemptions. Namespace/default imports cannot
      // hide a WebSocket alias inside the existing HTTP-only undici homes.
      "@typescript-eslint/no-restricted-imports": ["error", {
        paths: [{
          name: "undici", importNames: ["WebSocket", "default"],
          allowTypeImports: true, message: websocketMessage,
        }],
        patterns: [{ group: ["ws", "ws/**"], allowTypeImports: true, message: websocketMessage }],
      }],
    },
  },
  {
    // Stage 29 exemption: the gateway providers are the ONE legal home for
    // vendor AI SDK imports (module-boundary patterns still apply).
    files: ["apps/runtime/src/services/ai-gateway*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          {
            group: [
              "**/modules/*/*",
              "**/modules/*/*/**",
              "!**/modules/*/index.ts",
            ],
            message: "Import a module only through its modules/<name>/index.ts.",
          },
        ],
      }],
    },
  },
  {
    // Stage 26: the resolver's own modules are the legal transport home.
    files: ["apps/runtime/src/services/egress/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-restricted-syntax": ["error", moneyRestriction],
    },
  },
  {
    // Existing HTTP-only undici exceptions keep named HTTP imports. A
    // dynamic namespace would also expose WebSocket, so it is not exempt.
    files: ["packages/shared/src/http-client.ts", "packages/fansly/src/adapter.ts"],
    rules: {
      "no-restricted-syntax": ["error", moneyRestriction, dynamicUndiciRestriction, dynamicWsRestriction],
    },
  },
  {
    files: ["apps/runtime/src/modules/*/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          {
            group: [
              "**/modules/*/*",
              "**/modules/*/*/**",
              "!**/modules/*/index.ts",
            ],
            message: "Import a module only through its modules/<name>/index.ts.",
          },
          {
            // `*` also matches `..`, so exempt parent traversal explicitly:
            // "../../services/x" climbs OUT of modules/ and is not a sibling.
            group: [
              "../*/*",
              "../*/*/**",
              "!../*/index.ts",
              "!../../**",
            ],
            message: "Reach another module only through its ../<name>/index.ts.",
          },
        ],
      }],
    },
  },
);
