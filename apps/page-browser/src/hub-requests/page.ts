// What runs in the page for a Hub request (plan §4.2, step 3): functions the
// operator calls with Runtime.callFunctionOn in its isolated world of the
// work tab — the same tab, so the network sees the site's request; a JS
// realm the site's code never sees. Nothing comes back through JS: the
// operator reads the request and its answer from CDP.
//
// - An API request goes by XMLHttpRequest, as Fansly's own API calls do
//   (Angular's HttpClient), so the headers Chrome adds are the site's
//   (stage 1, amendment 14). The headers come as [name, value] pairs: their
//   order is the site's. The body is read to its end (`arraybuffer`): a body
//   nobody reads never ends for CDP (stage 1, FINDINGS 24), and Chrome ends
//   a body read as a stream with a cancel. A redirect is not followed: the
//   operator answers it to the page as final (hub.ts).
// - Media go as the site loads them (plan §3.2): an image by an Image, a
//   video by a video element — fetch() would say `sec-fetch-dest: empty`.
//   This path is not on the stand yet (CDN under the gate, header parity
//   for media, one request per video: see hub.ts).
// - The request starts from an address of its own: the real host behind
//   `.pb-hold.invalid` and a fragment `#hub-<attempt id>`. If Chrome let go
//   of it without the operator (CDP lost), it would go to a host that does
//   not exist, and the operator's proxy refuses it; the fragment never
//   leaves Chrome, and ties the request to its attempt in Fetch (stage 1,
//   §3.2, item 14).
// - What started is held from the isolated world's global object until the
//   operator lets go of it (`RELEASE`): garbage collection does not cancel a
//   Hub request (stage 1, `hub-gc-body`). Letting go never cancels anything
//   — except a video element's further loading, after the attempt's end.
// - A Hub request past its deadline or its body limit is cancelled here
//   (`ABORT`), never by cutting tunnels: the site's own requests share them
//   (variant Б, plan-b §4.1.10).

/** The isolated world's name in the work tab. */
export const WORLD = "pb-hub";

/** The placeholder the request starts from: `<host>.pb-hold.invalid`. */
export const PLACEHOLDER_SUFFIX = ".pb-hold.invalid";

/** The fragment that ties a request to its attempt. */
export function marker(attemptId: number): string {
  return `#hub-${attemptId}`;
}

/** The attempt a fragment names, or null. */
export function attemptOf(fragment: string): number | null {
  const match = /^#hub-([1-9][0-9]{0,15})$/.exec(fragment);
  return match ? Number(match[1]) : null;
}

/** The address the page starts the request from. */
export function issuedUrl(real: URL, attemptId: number): string {
  const issued = new URL(real.toString());
  issued.hostname = `${real.hostname}${PLACEHOLDER_SUFFIX}`;
  issued.hash = marker(attemptId).slice(1);
  return issued.toString();
}

/** The real address of a paused request of an attempt: its host back, no
 *  fragment (Fetch.continueRequest's `url`, not observable by the page). */
export function realUrl(pausedUrl: string, realHost: string): string {
  const url = new URL(pausedUrl);
  url.hostname = realHost;
  url.hash = "";
  return url.toString();
}

/** (id, url, kind, headers) → true once started, false if `id` is known. */
export const ISSUE = `function (id, url, kind, headers) {
  const g = globalThis;
  const live = g.__pbHub || (g.__pbHub = new Map());
  if (live.has(id)) return false;
  if (kind === "api") {
    const x = new XMLHttpRequest();
    live.set(id, { kind: kind, el: x });
    x.open("GET", url, true);
    x.withCredentials = true;
    x.responseType = "arraybuffer";
    for (let i = 0; i < headers.length; i++) x.setRequestHeader(headers[i][0], headers[i][1]);
    x.onloadend = function () { if (live.get(id) && live.get(id).el === x) live.delete(id); };
    x.send();
    return true;
  }
  if (kind === "image") {
    const img = new Image();
    live.set(id, { kind: kind, el: img });
    img.src = url;
    return true;
  }
  const v = document.createElement("video");
  live.set(id, { kind: kind, el: v });
  v.muted = true;
  v.preload = "auto";
  v.src = url;
  return true;
}`;

/** (id) → true if it was held: the request is cancelled in the page. */
export const ABORT = `function (id) {
  const live = globalThis.__pbHub;
  const entry = live && live.get(id);
  if (!entry) return false;
  live.delete(id);
  try {
    if (entry.kind === "api") entry.el.abort();
    else { entry.el.removeAttribute("src"); if (entry.kind === "video") entry.el.load(); }
  } catch (e) { /* gone with its document */ }
  return true;
}`;

/** (id) → true if it was held. */
export const RELEASE = `function (id) {
  const live = globalThis.__pbHub;
  const entry = live && live.get(id);
  if (!entry) return false;
  live.delete(id);
  if (entry.kind === "video") {
    try { entry.el.removeAttribute("src"); entry.el.load(); } catch (e) { /* gone with its document */ }
  }
  return true;
}`;
