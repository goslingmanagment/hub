export const GENERATION_CHECK_INTERVAL_MS = 30_000;
const GENERATION_READ_DEADLINE_MS = 5_000;

export type GenerationReceipt = {
  kind: "generation_check";
  startedAt: string;
  finishedAt: string;
  state: "unchanged" | "changed" | "unavailable";
};

/** The timeout bounds waiting, not the underlying DB query. The pool also has
 * SQL/connection deadlines; a late read never reopens or authenticates a socket. */
export async function checkProbeGeneration(read: () => Promise<string>, expected: string): Promise<GenerationReceipt> {
  const startedAt = new Date().toISOString();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let state: GenerationReceipt["state"];
  try {
    const value = await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("generation_read_deadline")), GENERATION_READ_DEADLINE_MS);
      }),
    ]);
    state = value === expected ? "unchanged" : "changed";
  } catch { state = "unavailable"; }
  finally { clearTimeout(timer); }
  return { kind: "generation_check", startedAt, finishedAt: new Date().toISOString(), state };
}

/** One read in flight. Abort stops the observation; no credential rotation or retry. */
export function watchProbeGeneration(input: {
  read: () => Promise<string>;
  expected: string;
  controller: AbortController;
  retain: (receipt: GenerationReceipt) => void;
}) {
  let stopped = false;
  let pending: Promise<void> = Promise.resolve();
  let reading = false;
  const timer = setInterval(() => {
    if (stopped || reading || input.controller.signal.aborted) return;
    reading = true;
    pending = checkProbeGeneration(input.read, input.expected).then((receipt) => {
      try { input.retain(receipt); }
      catch { input.controller.abort(); }
      if (receipt.state !== "unchanged") input.controller.abort();
    }).finally(() => { reading = false; });
  }, GENERATION_CHECK_INTERVAL_MS);

  return async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
  };
}
