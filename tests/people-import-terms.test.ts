import { describe, expect, it } from "vitest";

import { peopleImportArgsSchema, planPeopleImport, renderImportMarkdown, type ImportCatalog } from "../apps/runtime/src/services/people/import.ts";

// The people import's pay terms from the payout tabs' headers: a «Фикс/см» the import could not read is no term at
// all — never a silent zero rate once the ledger takes the terms from Hub — and the owner's report lists it as
// «не прочитано» with the cell as the tab has it. Invented people, models and amounts.

const catalog: ImportCatalog = {
  users: [],
  pages: [],
  models: [{ id: 1, slug: "Mia", name: "Mia Hart" }, { id: 2, slug: "Nova", name: "Nova Lane" }],
  agentKeys: [],
  existingCodes: new Set(),
  linkedLogins: new Map(),
};

function args(tabs: Array<{ model: string; fixPerShiftMills: number | null; fixCell?: string | null }>) {
  return peopleImportArgsSchema.parse({
    version: 1,
    cards: [{ code: "alex", title: "Alex", position: "чаттер", status: "active" }],
    ledger: {
      people: [{ slug: "alex", name: "Alex", status: "active" }],
      payrollTabs: tabs.map((tab) => ({ name: "Alex", code: "alex", shareBasisPoints: 2_000, status: "ok", ...tab })),
    },
    termsValidFrom: "2026-11-01",
  });
}

describe("the people import's pay terms", () => {
  it("takes a «Фикс/см» it read, a zero included", () => {
    const plan = planPeopleImport(args([{ model: "Mia", fixPerShiftMills: 5_000 }, { model: "Nova", fixPerShiftMills: 0, fixCell: "0" }]), catalog);
    expect(plan.drafts.find((draft) => draft.code === "alex")?.payTerms).toEqual([
      { modelSlug: "Mia", validFrom: "2026-11-01", shareBasisPoints: 2_000, fixPerShiftMills: 5_000 },
      { modelSlug: "Nova", validFrom: "2026-11-01", shareBasisPoints: 2_000, fixPerShiftMills: 0 },
    ]);
    expect(plan.discrepancies.filter((one) => one.code.startsWith("tab_fix"))).toEqual([]);
  });

  it("an unreadable «Фикс/см» makes no term; the report says «не прочитано» with the cell, the stored note never the money", () => {
    const plan = planPeopleImport(args([{ model: "Mia", fixPerShiftMills: 5_000 }, { model: "Nova", fixPerShiftMills: null, fixCell: "7$ за см" }]), catalog);
    expect(plan.drafts.find((draft) => draft.code === "alex")?.payTerms).toEqual([
      { modelSlug: "Mia", validFrom: "2026-11-01", shareBasisPoints: 2_000, fixPerShiftMills: 5_000 },
    ]);
    const unread = plan.discrepancies.filter((one) => one.code === "tab_fix_unread");
    expect(unread).toHaveLength(1);
    expect(unread[0]).toMatchObject({ person: "alex", detail: "в ячейке: «7$ за см»" });
    expect(unread[0]!.text).toContain("«Фикс/см» не прочитано");
    expect(unread[0]!.text).not.toContain("7$");
    const report = renderImportMarkdown(plan, { title: "Импорт", preparedAt: "2026-11-12" });
    expect(report).toContain("«Фикс/см» не прочитано");
    expect(report).toContain("«7$ за см»");
  });

  it("a cell the tab did not pass is said as such", () => {
    const plan = planPeopleImport(args([{ model: "Nova", fixPerShiftMills: null }]), catalog);
    expect(plan.drafts.find((draft) => draft.code === "alex")?.payTerms).toEqual([]);
    expect(plan.discrepancies.find((one) => one.code === "tab_fix_unread")).toMatchObject({ detail: "ячейки в файле аргументов нет" });
  });
});
