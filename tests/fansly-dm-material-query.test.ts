import { readFileSync } from "node:fs";

import ts from "typescript";
import { expect, it } from "vitest";

const migration = "0192_fansly_dm_shadow_material_probe.sql";

it("explains the runtime material query with the same typed VALUES and predicates", () => {
  const runtime = ts.createSourceFile(
    "fansly-dm-shadow.ts",
    readFileSync("packages/db/src/repositories/fansly-dm-shadow.ts", "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const queries: ts.TemplateExpression[] = [];
  function visit(node: ts.Node) {
    if (ts.isTaggedTemplateExpression(node) && ts.isTemplateExpression(node.template)
      && node.template.head.text.includes("select h.conversation_id")) {
      queries.push(node.template);
    }
    ts.forEachChild(node, visit);
  }
  visit(runtime);
  expect(queries).toHaveLength(1);
  const query = queries[0]!;
  expect(query.templateSpans).toHaveLength(1);
  expect(query.templateSpans[0]!.expression.getText(runtime)).toBe("values");
  const runtimeSql = query.head.text + "%s" + query.templateSpans[0]!.literal.text;
  const migrationSql = readFileSync(`packages/db/migrations/${migration}`, "utf8");
  expect(migrationSql).toContain("format('(%L::bigint, %L::text)', c.id, c.last_message_id)");
  const probeSql = migrationSql.match(/\$material_query\$([\s\S]+?)\$material_query\$/)?.[1];
  expect(probeSql).toBeDefined();
  const normalize = (text: string) => text.replace(/\bpublic\./g, "").replace(/\s+/g, " ").trim();
  expect(normalize(probeSql!)).toBe(normalize(runtimeSql));
});

it("allows application rollback after the additive read function migration", () => {
  const deploy = readFileSync("scripts/deploy-production.sh", "utf8");
  expect(deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0])
    .toContain(`"${migration}"`);
});
