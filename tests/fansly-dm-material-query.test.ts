import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

// 0192 added a read-only probe function for the legacy DM sweep shadow's
// material query. The shadow is gone since step 4 (S4-14); the function stays
// in the database (forward-only migrations), and the migration stays
// rollback-compatible.
const migration = "0192_fansly_dm_shadow_material_probe.sql";

it("allows application rollback after the additive read function migration", () => {
  const deploy = readFileSync("scripts/deploy-production.sh", "utf8");
  expect(deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0])
    .toContain(`"${migration}"`);
});
