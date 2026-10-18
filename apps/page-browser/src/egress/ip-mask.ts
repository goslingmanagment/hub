// IP addresses out of a text that leaves the page for Hub (a transition's
// note, protocol minor 5): an exit IP or the proxy's is never told there —
// the journal on the volume keeps the words as they were.

import { isIP } from "node:net";

const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
const IPV6 = /(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![0-9A-Fa-f:])/g;

/** Every IP address in the text as `<ip>` (a time like 12:30:45 is none). */
export function maskIps(text: string): string {
  return text.replace(IPV4, (found) => (isIP(found) === 4 ? "<ip>" : found)).replace(IPV6, (found) => (isIP(found) === 6 ? "<ip>" : found));
}
