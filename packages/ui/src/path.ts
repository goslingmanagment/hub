export function pathSegment(value: string | number) {
  return encodeURIComponent(String(value));
}

/** A location's path as the router matches it: each segment decoded, a slash
 *  inside a segment left as %2F. */
export function decodedPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment).replace(/\//g, "%2F");
      } catch {
        return segment;
      }
    })
    .join("/");
}
