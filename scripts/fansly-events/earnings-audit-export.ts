import { createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

import { EarningsAudit } from "./earnings-audit.ts";
import { earningsAuditScopeSchema } from "./earnings-audit-types.ts";
import { earningsAuditPages } from "./earnings-audit-pages.ts";
import { auditSqlLiteral as literal } from "./earnings-audit-reader.ts";

export interface EarningsAuditTransport {
  read(sql: string): Promise<unknown>;
  readMany(sql: string, count: number): Promise<unknown[]>;
  close(): Promise<{ stderr: string; error: string | null }>;
}

export async function exportEarningsAudit(
  input: { page: string; from: string; to: string; outputDirectory: string },
  createReader: () => EarningsAuditTransport,
) {
  const { page, from, to, outputDirectory } = input;
  z.string().min(1).max(256).parse(page);
  z.iso.datetime({ offset: true }).parse(from);
  z.iso.datetime({ offset: true }).parse(to);
  const directory = resolve(outputDirectory);
  await mkdir(directory, { mode: 0o700 });
  const output = await open(resolve(directory, "snapshot.jsonl"), "wx", 0o600);
  const hash = createHash("sha256");
  let reader: EarningsAuditTransport | null = null;
  let report: ReturnType<EarningsAudit["report"]> | null = null;
  const startedAt = new Date().toISOString();
  let records = 0;
  let completed = false;
  let failure: string | null = null;

  async function retain(value: unknown) {
    const line = JSON.stringify(value) + "\n";
    await output.writeFile(line);
    hash.update(line);
    records += 1;
  }

  try {
    reader = createReader();
    const identity = z.object({
      role: z.literal("read_only"), readOnly: z.literal("on"),
      isolation: z.literal("repeatable read"), asOf: z.iso.datetime({ offset: true }),
      planCacheMode: z.literal("force_custom_plan"),
    }).parse(await reader.read(`
      BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
      SET LOCAL standard_conforming_strings = on;
      -- A generic plan can scan the window prefix again for each keyset page.
      SET LOCAL plan_cache_mode = force_custom_plan;
      SET LOCAL statement_timeout = '15s';
      SET LOCAL lock_timeout = '1s';
      SET LOCAL idle_in_transaction_session_timeout = '30s';
      SELECT jsonb_build_object('role', current_user,
        'planCacheMode', current_setting('plan_cache_mode'),
        'readOnly', current_setting('transaction_read_only'),
        'isolation', current_setting('transaction_isolation'), 'asOf', transaction_timestamp());
    `));
    await retain({ operation: "identity", identity });
    const scope = earningsAuditScopeSchema.parse(await reader.read(
      `SELECT public.fansly_earnings_audit_scope(${literal(page)}, ${literal(from)}, ${literal(to)});`,
    ));
    if (scope.asOf !== identity.asOf) throw new Error("Audit identity and scope timestamps differ");
    await retain({ operation: "scope", scope });
    const audit = new EarningsAudit(scope);
    for (const operation of ["observations", "projection"] as const) {
      for await (const response of earningsAuditPages(reader, scope, operation)) {
        audit.accept(response);
        await retain(response);
      }
    }
    report = audit.report();
    // The marker is read inside READ ONLY. Clean EOF/exit proves psql then consumed ROLLBACK.
    const ended = await reader.read(
      "SELECT jsonb_build_object('ended', current_setting('transaction_read_only') = 'on'); ROLLBACK;",
    );
    if (JSON.stringify(ended) !== '{"ended":true}') throw new Error("Audit session did not close cleanly");
    completed = true;
  } catch (error) {
    failure = error instanceof Error ? error.message : "Earnings audit failed";
  } finally {
    const cleanup = reader ? await reader.close() : { stderr: "", error: null };
    if (cleanup.error) { completed = false; failure ??= cleanup.error; }
    await output.close();
    if (completed && report) {
      await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", {
        flag: "wx", mode: 0o600,
      });
    }
    await writeFile(resolve(directory, "stderr.txt"), cleanup.stderr, { flag: "wx", mode: 0o600 });
    await writeFile(resolve(directory, "manifest.json"), JSON.stringify({
      operation: "earnings_audit", source: "normalized_json_from_read_only_psql",
      startedAt, completedAt: new Date().toISOString(), completed, records,
      sha256: hash.digest("hex"), failure, page, from, to,
    }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
  return { completed, verified: completed && report?.verified === true, failure };
}
