import { createHmac } from "node:crypto";

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

export function code(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 65535
    ? value : null;
}

// Emit names from this list, never names supplied by the frame itself.
const knownFields = [
  "type", "message", "group", "groupUser", "messageAckEvent", "like", "transaction",
  "wallet", "walletVersion", "tip", "follow", "subscription", "version", "notification",
  "media", "order", "post", "wallPost", "account", "status", "id", "messageId", "groupId",
];
const referenceFields = [
  ["message", "id"], ["message", "groupId"], ["group", "id"],
  ["messageAckEvent", "messageId"], ["like", "messageId"],
  ["transaction", "id"], ["notification", "id"], ["post", "id"],
] as const;

export function summarizeEvent(event: Record<string, unknown>, key: Buffer) {
  const fields = knownFields.filter((name) => Object.hasOwn(event, name));
  const references: { field: string; pseudonym: string }[] = [];
  for (const [parent, name] of referenceFields) {
    const id = record(event[parent])?.[name];
    if (typeof id !== "string" || !/^[0-9]{1,32}$/.test(id)) continue;
    const entity = name === "messageId" ? "message" : name === "groupId" ? "group" : parent;
    references.push({
      field: `${parent}.${name}`,
      pseudonym: createHmac("sha256", key).update(`${entity}:${id}`).digest("hex"),
    });
  }
  return { fields, unknownFieldCount: Object.keys(event).length - fields.length, references };
}
