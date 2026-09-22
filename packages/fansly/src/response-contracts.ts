/** Identity fields that group-detail consumers need before applying or
 * remembering a captured response. Other provider fields remain untouched. */
export function isFanslyGroupDetailIdentity(value: unknown, expectedGroupId: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const detail = value as Record<string, unknown>;
  return typeof detail.id === "string" && detail.id.length > 0 && detail.id === expectedGroupId &&
    Array.isArray(detail.users) && detail.users.every(user => {
      if (typeof user !== "object" || user === null || Array.isArray(user)) return false;
      const userId = (user as Record<string, unknown>).userId;
      return typeof userId === "string" && userId.length > 0;
    });
}
