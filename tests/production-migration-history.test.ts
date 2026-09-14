import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

// These identities already exist in the production ledger. Restoring history
// must neither rename them nor replace the SQL associated with those names.
it.each([
  {
    file: "0185_fansly_followers_membership_read.sql",
    sha256: "bd9c2ee7987815ef6fd0f517a0783ead45954a2eb6ad7b5553c0075859940cb0",
  },
  {
    file: "0186_ops_metrics_recent_series.sql",
    sha256: "8fde039eb9e8f0d211ab419f0cd7264e5186aa79d9e223c6a4a42a083d571b7e",
  },
])("preserves deployed migration $file", async ({ file, sha256 }) => {
  const bytes = await readFile(`packages/db/migrations/${file}`);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
});
