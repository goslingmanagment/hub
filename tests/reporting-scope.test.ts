import { describe, expect, it } from "vitest";

import { listFanTransactionsCrossPage } from "../packages/db/src/repositories/reporting.ts";

describe("reporting repository scopes", () => {
  it("treats an empty page scope as no visible transactions", async () => {
    const db = {
      select() {
        throw new Error("query should not run for empty page scope");
      },
    };

    await expect(listFanTransactionsCrossPage(db as never, {
      fanId: 123,
      pageIds: [],
      limit: 25,
      offset: 0,
    })).resolves.toEqual({
      total: 0,
      items: [],
    });
  });
});
