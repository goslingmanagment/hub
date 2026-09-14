import { parseProbeArgs, runStoredFanslyProbe } from "./probe.ts";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

// Run only in a separate memory-limited process/container. V8's heap limit
// does not bound undici's fragmented-message Buffers. This timer is a second
// deadline; the operator's outer timeout must also cover a blocked event loop.
const deadline = setTimeout(() => {
  process.stderr.write("Fansly probe exceeded its process deadline.\n");
  process.exit(124);
}, 145_000);

try {
  const args = parseProbeArgs(process.argv.slice(2));
  const report = await runStoredFanslyProbe({ ...args, controller });
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(JSON.stringify(report) + "\n", (error) => error ? reject(error) : resolve());
  });
  // Force closure of this one-shot process after the complete sanitized output;
  // never rely on destroying an HTTP dispatcher to close an upgraded socket.
  const completed = report.observation.stopReason === "deadline"
    && report.observation.sessionFrameSeen && report.generationUnchanged === true;
  process.exit(completed ? 0 : 2);
} catch {
  // Provider, parser, filesystem, config and SQL errors may contain credentials.
  process.stderr.write("Fansly probe failed; no credential or provider error text was exported.\n");
  process.exit(1);
} finally {
  clearTimeout(deadline);
}
