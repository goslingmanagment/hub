export function qs(params: Record<string, string | number | boolean | Array<string | number | boolean> | undefined>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        searchParams.append(key, String(entry));
      }
    } else {
      searchParams.append(key, String(value));
    }
  }

  const query = searchParams.toString();
  return query ? `?${query}` : "";
}

