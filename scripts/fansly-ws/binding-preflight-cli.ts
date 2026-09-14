import { parseBindingPreflightArgs, runBindingPreflight } from "./binding-preflight.ts";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
const deadline = setTimeout(() => process.exit(124), 35_000);
try {
  const args = parseBindingPreflightArgs(process.argv.slice(2));
  const receipt = await runBindingPreflight(args.pageLabel, controller.signal);
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(JSON.stringify(receipt) + "\n", (error) => error ? reject(error) : resolve());
  });
  process.exit(receipt.identityMatched ? 0 : 2);
} catch {
  process.stderr.write("Binding preflight failed; no credential or provider error text was exported.\n");
  process.exit(1);
} finally { clearTimeout(deadline); }
