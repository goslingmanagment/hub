import type { Dispatcher } from "undici";

type DispatcherRequestInit = RequestInit & { dispatcher: Dispatcher };

/**
 * The only fetch seam for service-vendor traffic. A dispatcher is mandatory,
 * so ElevenLabs and Telegram cannot silently fall back to process-direct
 * egress.
 */
export function fetchWithEgress(
  fetchImpl: typeof fetch,
  dispatcher: Dispatcher,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  return fetchImpl(input, {
    ...init,
    dispatcher,
  } as DispatcherRequestInit);
}
