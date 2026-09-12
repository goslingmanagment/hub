import {
  earningsAuditPageSchema, type EarningsAuditPage, type EarningsAuditScope,
} from "./earnings-audit-types.ts";
import { auditSqlLiteral as literal, MAX_AUDIT_RESPONSES } from "./earnings-audit-reader.ts";

export async function* earningsAuditPages(
  reader: { readMany(sql: string, count: number): Promise<unknown[]> },
  scope: EarningsAuditScope,
  operation: "observations" | "projection",
) {
  const rowCount = Number(operation === "observations" ? scope.observationCount : scope.projectionCount);
  const pageCount = Math.max(1, Math.ceil(rowCount / 100));
  if (pageCount > 10_000) throw new Error("Earnings audit page limit exceeded");
  const scopeSql = literal(JSON.stringify(scope)) + "::jsonb";
  const fields = operation === "observations" ? ["receivedAt", "id"] : ["fanId", "window"];
  const continuation = operation === "observations"
    ? ":'audit_first'::timestamptz, :'audit_second'::bigint"
    : ":'audit_first'::bigint, :'audit_second'::text";
  let after = operation === "observations" ? "NULL, 0" : "0, ''";
  for (let offset = 0; offset < pageCount; offset += MAX_AUDIT_RESPONSES) {
    const count = Math.min(MAX_AUDIT_RESPONSES, pageCount - offset);
    const statements = Array.from({ length: count }, (_, index) => `
      WITH response AS MATERIALIZED (
        SELECT public.fansly_earnings_audit_${operation}(
          ${scopeSql}, ${index === 0 ? after : continuation}, 100) AS page
      )
      SELECT page::text AS audit_page, page->'next'->>'${fields[0]}' AS audit_first,
        page->'next'->>'${fields[1]}' AS audit_second FROM response
      \\gset
      \\echo :audit_page
    `);
    // psql executes each statement once, locally on the database host. Each
    // retains its 15-second timeout; values from gset are quoted as SQL literals.
    const responses = await reader.readMany(statements.join("\n"), count);
    if (responses.length !== count) throw new Error("Incomplete earnings audit response batch");
    for (const value of responses) {
      const page: EarningsAuditPage = earningsAuditPageSchema.parse(value);
      yield page;
      if (page.next !== null) {
        after = page.operation === "observations"
          ? `${literal(page.next.receivedAt)}, ${literal(page.next.id)}`
          : `${literal(page.next.fanId)}, ${literal(page.next.window)}`;
      }
    }
  }
}
