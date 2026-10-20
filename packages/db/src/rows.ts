/** Enforce the cardinality of a statement that must return exactly one row.
 * Optional lookups and writes with ON CONFLICT DO NOTHING must handle absence
 * in their own domain instead. */
export function requireSingleRow<T extends object>(rows: readonly T[], operation: string): T {
  const [row] = rows;
  if (rows.length !== 1 || row === undefined) {
    throw new Error(`${operation} expected one row, received ${rows.length}`);
  }
  return row;
}
