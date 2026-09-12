import { exportEarningsAudit } from "./earnings-audit-export.ts";
import { EarningsAuditReader } from "./earnings-audit-reader.ts";

const [sshHost, page, from, to, outputDirectory] = process.argv.slice(2);
if (!sshHost || !page || !from || !to || !outputDirectory || process.argv.length !== 7) {
  throw new Error("Usage: export-earnings-audit.ts SSH_HOST PAGE FROM TO NEW_OUTPUT_DIRECTORY");
}
const result = await exportEarningsAudit(
  { page, from, to, outputDirectory }, () => new EarningsAuditReader(sshHost),
);
if (result.completed) {
  process.stdout.write(`Earnings audit exported: ${page}; verified=${result.verified}.\n`);
} else {
  process.exitCode = 1;
  process.stderr.write("Earnings audit incomplete; inspect the private manifest and stderr files.\n");
}
