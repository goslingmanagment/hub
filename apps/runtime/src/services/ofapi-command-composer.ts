export function ofapiWireId(id: string): string | number {
  const value = /^\d+$/.test(id) ? Number(id) : NaN;
  return Number.isSafeInteger(value) ? value : id;
}
