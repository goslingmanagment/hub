import tsParser from "@typescript-eslint/parser";

// Kernel Stage 19 ESLint bootstrap. Deliberately minimal: the ONLY rules are the
// module-boundary walls (the desktop's no-restricted-imports pattern). The
// auth-declaration gate is a contracts unit test, not a lint rule, so it cannot
// be skipped by skipping lint. The full family lint standard arrives in Stage 35
// — do not grow this config before it.
//
// The wall below matches import SPECIFIERS that name a modules/ path (the
// composition root and services importing "./modules/<m>/<internal>"). Task 3
// adds the relative-sibling walls (`../<other-module>/…`) once the module
// layout exists and their depth is known.

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
];
