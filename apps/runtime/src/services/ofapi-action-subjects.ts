function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function fanId(value: unknown): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? value : null;
}

/** Derive the response index AFTER its exact encrypted receipt is captured.
 * An unqualified id on a list, post, media or creator profile is not a fan. */
export function ofapiActionResponseSubjectRefs(command: { action: string }, responseData: unknown): string[] {
  const refs = new Set<string>();
  const add = (value: unknown) => { const id = fanId(value); if (id !== null) refs.add(id); };
  const personResult = ["user_block", "user_unblock", "user_restrict", "user_unrestrict", "fan_notes_update", "fan_notes_clear"].includes(command.action);
  const pending: { value: unknown; person: boolean }[] = [{ value: responseData, person: personResult }];
  const seen = new WeakSet<object>();
  while (pending.length) {
    const current = pending.pop()!;
    if (Array.isArray(current.value)) {
      if (seen.has(current.value)) continue;
      seen.add(current.value);
      for (const value of current.value) pending.push({ value, person: current.person });
      continue;
    }
    const value = record(current.value);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    if (current.person) add(value.id);
    for (const [key, nested] of Object.entries(value)) {
      if (["userId", "fanId", "user_id", "fan_id"].includes(key)) add(nested);
      if (["userIds", "fanIds", "user_ids", "fan_ids"].includes(key) && Array.isArray(nested)) nested.forEach(add);
      if (nested !== null && typeof nested === "object") pending.push({ value: nested, person: ["user", "fan", "users", "fans"].includes(key) });
    }
  }
  return [...refs].sort();
}
