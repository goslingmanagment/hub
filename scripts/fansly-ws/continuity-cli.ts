import { CONTINUITY_PHASES, parseContinuityArgs } from "./continuity.ts";
import { writeContinuityLine } from "./continuity-receipts.ts";
import { runStoredFanslyContinuity } from "./continuity-runtime.ts";
import { bindingRefusalReceipt } from "./binding-receipt.ts";
import { engineOwnedRefusalLine } from "./engine-owned.ts";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
let deadline: ReturnType<typeof setTimeout> | undefined;

try {
  const args = parseContinuityArgs(process.argv.slice(2));
  // Separate auth, final generation read and cleanup allowance. The host's
  // longer deadline also covers a blocked event loop or upgraded socket.
  deadline = setTimeout(() => process.exit(124), CONTINUITY_PHASES[args.phase].durationMs + 30_000);
  const completed = await runStoredFanslyContinuity(args, controller, writeContinuityLine);
  process.exit(completed ? 0 : 2);
} catch (error) {
  const refusal = bindingRefusalReceipt(error);
  if (refusal) {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(JSON.stringify(refusal) + "\n", (failure) => failure ? reject(failure) : resolve());
    });
    process.exit(2);
  }
  const engineOwned = engineOwnedRefusalLine(error);
  if (engineOwned) {
    process.stderr.write(engineOwned);
    process.exit(1);
  }
  process.stderr.write("Continuity observation failed; no credential or provider error text was exported.\n");
  process.exit(1);
} finally { clearTimeout(deadline); }
