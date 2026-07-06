import tsParser from "@typescript-eslint/parser";

// Kernel Stage 19 ESLint bootstrap. Deliberately minimal: the ONLY rules are the
// module-boundary walls (the desktop's no-restricted-imports pattern). The
// auth-declaration gate is a contracts unit test, not a lint rule, so it cannot
// be skipped by skipping lint. The full family lint standard arrives in Stage 35
// — do not grow this config before it.
//
// Two walls, both on import SPECIFIERS:
// 1. Path-qualified deep imports naming a modules/ internal (the composition
//    root and services must use "./modules/<m>/index.ts").
// 2. Relative sibling imports from inside a module: every module is a single
//    modules/<name>/index.ts, so "../<other>/<file>" is a cross-module reach —
//    allowed only for "../<other>/index.ts"; "../context.ts" (the shared
//    module context) is one segment and passes.

export default [
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "apps/dashboard/**",
      "docs/**",
      "packages/contracts/src/generated/**",
    ],
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
      "no-restricted-syntax": ["error", {
        selector: "CallExpression > Identifier[name='toMills']",
        message: "toMills was deleted (Stage 27): use millsFromInteger / millsFromDollars / millsFromCents.",
      }],
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
];
