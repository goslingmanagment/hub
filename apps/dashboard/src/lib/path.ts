export function pathSegment(value: string | number) {
  return encodeURIComponent(String(value));
}
