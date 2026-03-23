import { sql, type SQLWrapper } from "drizzle-orm";

export function escapeLikePattern(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

export function buildContainsSearchPattern(query?: string | null) {
  const trimmed = query?.trim();
  return trimmed ? `%${escapeLikePattern(trimmed)}%` : null;
}

export function ilikeEscaped(column: SQLWrapper, pattern: string) {
  return sql`${column} ilike ${pattern} escape '\\'`;
}
