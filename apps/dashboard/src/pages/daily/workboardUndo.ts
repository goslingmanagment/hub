interface WorkboardUndoTarget {
  readonly pageLabel: string;
  readonly fanId: number;
}

/** The server deletes/retracts current state, not a particular receipt. A lost
 * reply must consume this receipt too: repeating could affect a later action. */
export function createWorkboardUndoReceipt(pageLabel: string, fanId: number, kind: "contact" | "snooze") {
  const target: WorkboardUndoTarget = Object.freeze({ pageLabel, fanId });
  let attempted = false;
  return {
    ...target,
    kind,
    get attempted() { return attempted; },
    async run(action: (target: WorkboardUndoTarget) => Promise<unknown>): Promise<void> {
      if (attempted) throw new Error("This Undo receipt has already been attempted.");
      attempted = true;
      await action(target);
    },
  };
}
