import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";

// A chunk can build several adapter contexts (including nested hydration).
// Scope admission to the async execution, rather than to a shared client or
// one of those contexts. This signal never aborts an in-flight response body:
// the caller still owns capture of everything the provider already returned.
const requestSignalStorage = new AsyncLocalStorage<AbortSignal>();

export function runWithHttpRequestSignal<T>(signal: AbortSignal, run: () => T): T {
  return requestSignalStorage.run(signal, run);
}

export function getHttpRequestSignal(): AbortSignal | undefined {
  return requestSignalStorage.getStore();
}

export function assertHttpRequestActive() {
  getHttpRequestSignal()?.throwIfAborted();
}

/** Cancel admission, never the work that receives/captures a response. A
 * custom waiter may finish its existing reservation after cancellation; its
 * result is drained and cannot start an HTTP attempt. */
export async function waitForHttpRequestPermit<T>(wait: () => Promise<T>): Promise<T> {
  const signal = getHttpRequestSignal();
  signal?.throwIfAborted();
  if (!signal) return wait();

  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([wait(), cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function waitForHttpRequestDelay(ms: number): Promise<void> {
  const signal = getHttpRequestSignal();
  signal?.throwIfAborted();
  if (!signal) {
    await delay(ms);
    return;
  }
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    // node:timers wraps the reason in AbortError. Preserve the owner's
    // control outcome so it cannot be mistaken for a transport failure.
    signal.throwIfAborted();
    throw error;
  }
}
