// Every command of the engine carries its own id and is never executed twice
// (plan §4.13). A repeat — the engine resent it after a reconnect, say — gets
// the first execution's result, waiting for it if it still runs. The ledger
// keeps the last `capacity` ids; the engine's `notAfterMono` makes an older
// repeat expire anyway.

export interface CommandOutcome {
  ok: boolean;
  detail: string | null;
}

export class CommandLedger {
  readonly #capacity: number;
  readonly #seen = new Map<string, Promise<CommandOutcome>>();

  constructor(capacity = 1000) {
    this.#capacity = capacity;
  }

  has(commandId: string): boolean {
    return this.#seen.has(commandId);
  }

  /** `execute` runs once per id; every call gets that run's outcome. */
  run(commandId: string, execute: () => Promise<CommandOutcome>): { outcome: Promise<CommandOutcome>; repeat: boolean } {
    const known = this.#seen.get(commandId);
    if (known) return { outcome: known, repeat: true };
    const outcome = (async () => {
      try {
        return await execute();
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    })();
    this.#seen.set(commandId, outcome);
    while (this.#seen.size > this.#capacity) this.#seen.delete(this.#seen.keys().next().value!);
    return { outcome, repeat: false };
  }
}
