importScripts("/worker-actions.js");
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (ev) => ev.waitUntil(self.clients.claim()));
// Pass every request of the page through the worker, as Angular's ngsw does
// for the requests it does not cache.
self.addEventListener("fetch", (ev) => {
  const url = new URL(ev.request.url);
  if (url.hostname === "api.stand.test" && url.searchParams.get("viaSw") === "1") ev.respondWith(fetch(ev.request));
});
self.addEventListener("message", async (ev) => {
  const result = await workerAction(ev.data);
  ev.ports[0].postMessage(result);
});
