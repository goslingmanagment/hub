// Shared by the dedicated, shared and service workers of the stand: the
// same actions as the page's `site.*`, answered by message.
const WS_BASE = "wss://ws.stand.test";
const API_BASE = "https://api.stand.test";
const workerSockets = [];

async function workerAction(msg) {
  switch (msg.op) {
    case "probe":
      return {
        scope: String(self.constructor && self.constructor.name),
        sendToString: Function.prototype.toString.call(WebSocket.prototype.send),
        hasWebSocket: typeof WebSocket,
      };
    case "fetch": {
      try {
        const r = await fetch(`${API_BASE}/api/${msg.path || "w"}?rid=${encodeURIComponent(msg.rid)}`, {
          credentials: "include",
          headers: msg.plain ? {} : { authorization: "stand-token" },
        });
        return { status: r.status, body: (await r.text()).slice(0, 200) };
      } catch (e) {
        return { error: String(e) };
      }
    }
    case "ws": {
      const index = workerSockets.length;
      const entry = { events: [] };
      workerSockets.push(entry);
      const s = new WebSocket(`${WS_BASE}/ws?rid=${encodeURIComponent(msg.rid)}`);
      entry.socket = s;
      for (const type of ["open", "message", "error", "close"]) {
        s.addEventListener(type, (ev) => entry.events.push({ type, data: ev.data ? String(ev.data).slice(0, 200) : undefined, code: ev.code }));
      }
      await new Promise((resolve) => {
        s.addEventListener("open", resolve);
        s.addEventListener("close", resolve);
      });
      return { index, readyState: s.readyState, events: entry.events };
    }
    case "wsSend": {
      const entry = workerSockets[msg.index];
      if (!entry) return { error: "no socket" };
      try {
        entry.socket.send(msg.data);
        return { sent: true };
      } catch (e) {
        return { threw: String(e) };
      }
    }
    case "wsState": {
      const entry = workerSockets[msg.index];
      return entry ? { readyState: entry.socket.readyState, events: entry.events } : { error: "no socket" };
    }
    default:
      return { error: `unknown op ${msg.op}` };
  }
}
