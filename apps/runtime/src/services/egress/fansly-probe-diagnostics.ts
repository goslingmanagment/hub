import type { Dispatcher } from "undici";

const TRANSPORT_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_ABORTED",
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function transportCode(error: unknown): string | null {
  const seen = new Set<object>();
  let current = error;
  try {
    for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth++) {
      if (seen.has(current)) break;
      seen.add(current);
      const value = current as { code?: unknown; cause?: unknown };
      const code = value.code;
      if (typeof code === "string" && TRANSPORT_CODES.has(code)) return code;
      current = value.cause;
    }
  } catch { /* Diagnostic access must not change the original failure. */ }
  return null;
}

export type ProbeTransportDiagnostics = ReturnType<typeof createProbeTransportDiagnostics>;

/** One W0 attempt only. No arbitrary error or response strings enter the receipt. */
export function createProbeTransportDiagnostics() {
  let finished = false;
  let errorSeen = false;
  let transportErrorCode: string | null = null;
  let httpStatus: number | null = null;
  function status(value: number) {
    if (!finished && httpStatus === null && Number.isInteger(value)
      && (value === 101 || (value >= 200 && value <= 599))) httpStatus = value;
  }
  return {
    wrap(dispatcher: Dispatcher) {
      // compose adapts Undici's legacy Fetch handler to these supported callbacks.
      // Call the original handler as receiver; its adapter has private fields.
      return dispatcher.compose((dispatch) => (options, handler) => dispatch(options, {
        onRequestStart: (controller, context) => handler.onRequestStart?.(controller, context),
        onRequestUpgrade(controller, code, headers, socket) {
          status(code);
          return handler.onRequestUpgrade?.(controller, code, headers, socket);
        },
        onResponseStart(controller, code, headers, statusText) {
          status(code);
          return handler.onResponseStart?.(controller, code, headers, statusText);
        },
        onResponseStarted: () => handler.onResponseStarted?.(),
        onResponseData: (controller, chunk) => handler.onResponseData?.(controller, chunk),
        onResponseEnd: (controller, trailers) => handler.onResponseEnd?.(controller, trailers),
        onResponseError(controller, error) {
          if (!finished && !errorSeen) {
            errorSeen = true;
            transportErrorCode = transportCode(error);
          }
          return handler.onResponseError?.(controller, error);
        },
      }));
    },
    finish() {
      finished = true;
      return { transportErrorCode, httpStatus };
    },
  };
}
