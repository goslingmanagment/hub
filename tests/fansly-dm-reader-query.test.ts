import { readFileSync } from "node:fs";

import ts from "typescript";
import { expect, it } from "vitest";

const migration = "0194_fansly_dm_shadow_reader_probe.sql";

it("pins the exact reader classifier in the separately measurable read-only probe", () => {
  const runtime = ts.createSourceFile(
    "fansly-dm-reader-heads.ts",
    readFileSync("packages/db/src/repositories/fansly-dm-reader-heads.ts", "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const queries: ts.TemplateExpression[] = [];
  function visit(node: ts.Node) {
    if (ts.isTaggedTemplateExpression(node) && ts.isTemplateExpression(node.template)
      && node.template.head.text.includes("with page as (")) {
      queries.push(node.template);
    }
    ts.forEachChild(node, visit);
  }
  visit(runtime);
  expect(queries).toHaveLength(1);
  const query = queries[0]!;
  expect(query.templateSpans.map(span => span.expression.getText(runtime))).toEqual(["pageId", "values"]);
  const runtimeSql = query.head.text + query.templateSpans.map((span, index) =>
    (index === 0 ? "%L" : "%s") + span.literal.text).join("");
  const migrationSql = readFileSync(`packages/db/migrations/${migration}`, "utf8");
  expect(migrationSql).toContain("format('(%L::integer, %L::text, %L::text)'");
  expect(migrationSql).toContain("$reader_query$, selected_page, head_values)");
  const probeSql = migrationSql.match(/\$reader_query\$([\s\S]+?)\$reader_query\$/)?.[1];
  expect(probeSql).toBeDefined();
  const normalize = (text: string) => text.replace(/\bpublic\./g, "").replace(/\s+/g, " ").trim();
  expect(normalize(probeSql!)).toBe(normalize(runtimeSql));
});

it("allows application rollback after the additive read function migration", () => {
  const deploy = readFileSync("scripts/deploy-production.sh", "utf8");
  expect(deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0])
    .toContain(`"${migration}"`);
});
