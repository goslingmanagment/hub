export type PublicRuntimeCapability = "desktop-lifecycle-v2";

/**
 * Single runtime/build-artifact source for public capability advertisement.
 * The deploy script interrogates the candidate image through startup's
 * print-public-capabilities mode before it can replace the running stack.
 */
export const PUBLIC_RUNTIME_CAPABILITIES: readonly PublicRuntimeCapability[] = [];
