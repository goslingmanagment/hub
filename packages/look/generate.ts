/**
 * `node --import tsx/esm packages/look/generate.ts`: writes Hub's two copies of the token values from
 * packages/look/src/tokens.ts. CI runs it and fails when a copy in the commit
 * differs from what it writes (a value edited by hand in a copy, or a value
 * changed without regenerating).
 */
import { writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { renderConsoleTokensCss, renderUiTokensCss } from "./src/css.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

export const GENERATED_COPIES = {
  "packages/ui/src/styles/tokens.css": renderUiTokensCss,
  "apps/dashboard/src/styles/tokens.css": renderConsoleTokensCss,
} as const;

for (const [path, render] of Object.entries(GENERATED_COPIES)) {
  const target = join(root, path);
  writeFileSync(target, render());
  console.log(`look: wrote ${relative(root, target)}`);
}
