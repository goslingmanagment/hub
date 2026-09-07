/** A closed, typed adapter result. Only server-owned definitions construct paths. */
export interface OfapiActionRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  query?: Record<string, string>;
  estimatedCredits: number;
  resultKind: "read" | "ack" | "resource" | "queue" | "partial";
}
