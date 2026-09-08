// Fansly WS tap — paste into the DevTools Console of the fansly.com tab (page context, not extension).
// Logs frames with the auth token redacted. Then force a reconnect: Firefox menu → File → Work Offline (on, then off).
// After a few minutes of activity run __wsDump() — the JSON lands in the clipboard.
(() => {
  const NativeWS = window.WebSocket;
  const log = [];
  const redact = (s) => String(s).replace(/"token"\s*:\s*\\?"[^"\\]+\\?"/g, '"token":"<redacted>"');
  const rec = (dir, url, data) => log.push({
    at: new Date().toISOString(), dir, url: String(url),
    data: typeof data === "string" ? redact(data) : `[binary ${data && data.byteLength != null ? data.byteLength : "?"} bytes]`,
  });
  function TappedWS(url, protocols) {
    const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    ws.addEventListener("open", () => rec("open", url, ""));
    ws.addEventListener("message", (e) => rec("in", url, e.data));
    ws.addEventListener("close", (e) => rec("close", url, `${e.code} ${e.reason}`));
    ws.addEventListener("error", () => rec("error", url, ""));
    const send = ws.send.bind(ws);
    ws.send = (d) => { rec("out", url, d); return send(d); };
    return ws;
  }
  TappedWS.prototype = NativeWS.prototype;
  Object.assign(TappedWS, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = TappedWS;
  window.__wsLog = log;
  window.__wsDump = () => { copy(JSON.stringify(log, null, 1)); return `${log.length} frames copied`; };
  console.log("[ws-tap] installed. Now: File → Work Offline → on, wait 3 s, → off. Later: __wsDump()");
})();
