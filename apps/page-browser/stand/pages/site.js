// The stand's "site": what a page of Fansly does, on command. The runner
// drives it from the main world through the operator's `test.eval` hook
// (stand only) — `site.*` below. Every action records its result in
// `site.log` so the runner can read it back.
(() => {
  const API = "https://api.stand.test";
  const WS = "wss://ws.stand.test";
  const log = [];
  const sockets = [];
  const note = (entry) => {
    log.push(Object.assign({ at: performance.now() }, entry));
    return entry;
  };

  const site = {
    log,
    sockets,

    /** A site API request with the headers Fansly's client sends (they make
     *  it a CORS request with a preflight). */
    api(rid, opts = {}) {
      const url = `${API}/api/${opts.path || "item"}?rid=${encodeURIComponent(rid)}${opts.query ? `&${opts.query}` : ""}`;
      const init = {
        method: opts.method || "GET",
        credentials: "include",
        headers: opts.plain ? {} : { authorization: "stand-token", "fansly-client-id": "1", "fansly-client-check": "abc" },
        keepalive: opts.keepalive === true,
      };
      if (opts.body) init.body = opts.body;
      const started = performance.now();
      return fetch(url, init).then(
        async (r) => note({ kind: "api", rid, status: r.status, ms: performance.now() - started, body: (await r.text()).slice(0, 300) }),
        (e) => note({ kind: "api", rid, error: String(e), ms: performance.now() - started }),
      );
    },

    /** n requests at once, as a page does at load. */
    burst(prefix, n, opts) {
      const all = [];
      for (let i = 0; i < n; i++) all.push(site.api(`${prefix}-${i}`, opts));
      return Promise.all(all);
    },

    xhr(rid) {
      return new Promise((resolve) => {
        const x = new XMLHttpRequest();
        x.open("GET", `${API}/api/xhr?rid=${encodeURIComponent(rid)}`);
        x.withCredentials = true;
        x.setRequestHeader("authorization", "stand-token");
        x.onloadend = () => resolve(note({ kind: "xhr", rid, status: x.status }));
        x.send();
      });
    },

    beacon(rid) {
      const ok = navigator.sendBeacon(`${API}/beacon?rid=${encodeURIComponent(rid)}`, "x");
      return note({ kind: "beacon", rid, queued: ok });
    },

    /** Open a socket; its events are recorded. Returns its index. */
    ws(rid, path = "/ws") {
      const index = sockets.length;
      const entry = { rid, events: [] };
      sockets.push(entry);
      let s;
      try {
        s = new WebSocket(`${WS}${path}?rid=${encodeURIComponent(rid)}`);
      } catch (e) {
        entry.events.push({ type: "throw", error: String(e) });
        return index;
      }
      entry.socket = s;
      for (const type of ["open", "message", "error", "close"]) {
        s.addEventListener(type, (ev) => entry.events.push({ type, at: performance.now(), data: ev.data ? String(ev.data).slice(0, 200) : undefined, code: ev.code }));
      }
      return index;
    },

    wsSend(index, data) {
      const s = sockets[index] && sockets[index].socket;
      if (!s) return "no socket";
      try {
        const r = s.send(data);
        return { returned: r === undefined ? "undefined" : String(r), readyState: s.readyState };
      } catch (e) {
        return { threw: String(e) };
      }
    },

    wsState(index) {
      const entry = sockets[index];
      return entry ? { readyState: entry.socket ? entry.socket.readyState : null, events: entry.events } : null;
    },

    /** A fetch to the socket host: Chrome would open an HTTP/2 session a
     *  later socket could ride. The operator refuses it. */
    wsHostFetch(rid) {
      // Credentialed: Chrome puts a socket only on a credentialed HTTP/2
      // session (stand server's finding).
      return fetch(`https://ws.stand.test/plain?rid=${encodeURIComponent(rid)}`, { mode: "no-cors", credentials: "include" }).then(
        (r) => note({ kind: "wsHostFetch", rid, status: r.status }),
        (e) => note({ kind: "wsHostFetch", rid, error: String(e) }),
      );
    },

    worker() {
      const w = new Worker("/worker.js");
      site._worker = w;
      return new Promise((resolve) => {
        w.onmessage = (ev) => resolve(note({ kind: "worker.ready", data: ev.data }));
      });
    },

    /** Run an action in the dedicated worker: {op:"fetch"|"ws"|"wsSend"|"probe", ...}. */
    inWorker(msg) {
      const w = site._worker;
      if (!w) return Promise.resolve({ error: "no worker" });
      return new Promise((resolve) => {
        const id = Math.random().toString(36).slice(2);
        const onMsg = (ev) => {
          if (ev.data && ev.data.id === id) {
            w.removeEventListener("message", onMsg);
            resolve(note(Object.assign({ kind: `worker.${msg.op}` }, ev.data)));
          }
        };
        w.addEventListener("message", onMsg);
        w.postMessage(Object.assign({ id }, msg));
      });
    },

    sharedWorker() {
      const w = new SharedWorker("/shared-worker.js");
      site._shared = w;
      w.port.start();
      return new Promise((resolve) => {
        w.port.onmessage = (ev) => resolve(note({ kind: "shared.ready", data: ev.data }));
      });
    },

    inShared(msg) {
      const w = site._shared;
      if (!w) return Promise.resolve({ error: "no shared worker" });
      return new Promise((resolve) => {
        const id = Math.random().toString(36).slice(2);
        const onMsg = (ev) => {
          if (ev.data && ev.data.id === id) {
            w.port.removeEventListener("message", onMsg);
            resolve(note(Object.assign({ kind: `shared.${msg.op}` }, ev.data)));
          }
        };
        w.port.addEventListener("message", onMsg);
        w.port.postMessage(Object.assign({ id }, msg));
      });
    },

    async serviceWorker() {
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      site._sw = reg;
      return note({ kind: "sw.ready", active: !!reg.active });
    },

    inServiceWorker(msg) {
      const sw = navigator.serviceWorker.controller || (site._sw && site._sw.active);
      if (!sw) return Promise.resolve({ error: "no service worker" });
      return new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = (ev) => resolve(note(Object.assign({ kind: `sw.${msg.op}` }, ev.data)));
        sw.postMessage(msg, [channel.port2]);
      });
    },

    /** A same-origin iframe running this script; returns its window's site. */
    iframe(src = "/frame.html") {
      return new Promise((resolve) => {
        const f = document.createElement("iframe");
        f.src = src;
        f.onload = () => resolve(note({ kind: "iframe.loaded", src }));
        document.body.appendChild(f);
        site._frames = (site._frames || []).concat([f]);
      });
    },

    frameSite(index = 0) {
      const f = (site._frames || [])[index];
      return f && f.contentWindow && f.contentWindow.site;
    },

    /** The classic way to a pristine realm: an about:blank iframe created by
     *  script. Does the guard reach it before the page can use it? */
    blankIframeSend(index, data) {
      const f = document.createElement("iframe");
      document.body.appendChild(f);
      const send = f.contentWindow.WebSocket.prototype.send;
      const s = sockets[index] && sockets[index].socket;
      const text = Function.prototype.toString.call(send);
      try {
        send.call(s, data);
        return { sent: true, sendSource: text };
      } catch (e) {
        return { threw: String(e), sendSource: text };
      }
    },

    /** What a site could notice about the guard. */
    detect() {
      const out = {};
      const send = WebSocket.prototype.send;
      out.sendToString = Function.prototype.toString.call(send);
      out.sendName = send.name;
      out.sendLength = send.length;
      out.toStringToString = Function.prototype.toString.toString();
      out.toStringName = Function.prototype.toString.name;
      out.sendOwnKeys = Reflect.ownKeys(send).map(String);
      out.protoKeys = Object.getOwnPropertyNames(WebSocket.prototype);
      out.ctorToString = Function.prototype.toString.call(WebSocket);
      out.instanceofOk = (() => {
        try {
          return new WebSocket(`${WS}/ws?rid=detect`) instanceof WebSocket;
        } catch (e) {
          return String(e);
        }
      })();
      try {
        send.call({}, "x");
      } catch (e) {
        out.illegalInvocation = String(e);
        out.illegalStack = String(e.stack || "").split("\n").slice(0, 4);
      }
      out.webSocketStream = typeof WebSocketStream;
      // The classic CDP probe: a client with Runtime enabled serializes
      // console arguments and touches the error's stack getter.
      let touched = false;
      const probe = new Error("probe");
      Object.defineProperty(probe, "stack", { configurable: true, get() { touched = true; return ""; } });
      console.debug(probe);
      out.runtimeProbeTouched = touched;
      out.windowKeysWithPb = Object.getOwnPropertyNames(window).filter((k) => /^__pb/.test(k));
      return out;
    },
  };
  window.site = site;
})();
