type Shortcut = { kind: "focus" | "handled" | "snooze" | "details"; fanId: number };

export function resolveWorkboardShortcut(input: {
  key: string;
  modified: boolean;
  repeated: boolean;
  interactive: boolean;
  visibleFanIds: number[];
  focusedFanId: number | null;
  actionsAllowed: boolean;
}): Shortcut | null {
  if (input.modified || input.interactive || input.visibleFanIds.length === 0) return null;
  const index = input.visibleFanIds.indexOf(input.focusedFanId ?? -1);
  if (input.key === "j" || input.key === "ArrowDown") {
    return { kind: "focus", fanId: input.visibleFanIds[index < 0 ? 0 : Math.min(index + 1, input.visibleFanIds.length - 1)]! };
  }
  if (input.key === "k" || input.key === "ArrowUp") {
    return { kind: "focus", fanId: input.visibleFanIds[index <= 0 ? 0 : index - 1]! };
  }
  // A fan disappearing after recompute, pagination, or collapsing a band
  // invalidates the old focus. A stale highlight cannot authorize a write.
  if (index < 0) return null;
  const fanId = input.visibleFanIds[index]!;
  if (input.key === "Enter") return { kind: "details", fanId };
  if (!input.actionsAllowed || input.repeated) return null;
  if (input.key === "e") return { kind: "handled", fanId };
  if (input.key === "s") return { kind: "snooze", fanId };
  return null;
}
