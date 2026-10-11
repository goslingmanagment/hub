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
  // fansly-client-check as Fansly's bundle computes it (cyrb53 of
  // key_path_deviceId): the operator checks its own key against it.
  const cyrb53 = (text) => {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  };
  const DEVICE = "1";
  const clientCheck = (url) => cyrb53(`necvac-govry3-tybkYz_${new URL(url).pathname}_${DEVICE}`).toString(16);

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
        headers: opts.plain ? {} : { authorization: "stand-token", "fansly-client-id": DEVICE, "fansly-client-check": clientCheck(url) },
        keepalive: opts.keepalive === true,
      };
      if (opts.body) init.body = opts.body;
      const started = performance.now();
      return fetch(url, init).then(
        async (r) => note({ kind: "api", rid, status: r.status, ms: performance.now() - started, body: (await r.text()).slice(0, 300) }),
        (e) => note({ kind: "api", rid, error: String(e), ms: performance.now() - started }),
      );
    },

    /** A site request whose body the page reads and digests itself — the
     *  truth the operator's capture is compared with. `how`: "arrayBuffer"
     *  or "stream" (a reader loop, as Angular's fetch backend does). */
    async apiHash(rid, query, how = "arrayBuffer") {
      try {
        const r = await fetch(`${API}/api/body?rid=${encodeURIComponent(rid)}&${query}`, { credentials: "include", headers: { authorization: "stand-token" } });
        let buf;
        if (how === "stream") {
          const reader = r.body.getReader();
          const parts = [];
          for (;;) { const x = await reader.read(); if (x.done) break; parts.push(x.value); }
          buf = await new Blob(parts).arrayBuffer();
        } else {
          buf = await r.arrayBuffer();
        }
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
        const sha256 = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
        return note({ kind: "apiHash", rid, status: r.status, bytes: buf.byteLength, sha256 });
      } catch (e) {
        return note({ kind: "apiHash", rid, error: String(e) });
      }
    },

    /** n requests at once, as a page does at load. */
    burst(prefix, n, opts) {
      const all = [];
      for (let i = 0; i < n; i++) all.push(site.api(`${prefix}-${i}`, opts));
      return Promise.all(all);
    },

    /** Any request to the API by method and path (the rules extension and
     *  the operator's map are tested with it). */
    raw(rid, method, path, opts = {}) {
      const started = performance.now();
      return fetch(`${API}${path}${path.includes("?") ? "&" : "?"}rid=${encodeURIComponent(rid)}`, {
        method,
        credentials: "include",
        headers: opts.plain ? {} : { authorization: "stand-token" },
        body: method === "GET" || method === "HEAD" ? undefined : opts.bodySize ? JSON.stringify({ pad: "x".repeat(Math.max(0, opts.bodySize - 10)) }) : "{}",
        keepalive: opts.keepalive === true,
      }).then(
        // The body is read, as a site's client reads it: a response nobody
        // reads never ends for CDP (the operation would wait out its limit).
        async (r) => {
          await r.text().catch(() => "");
          return note({ kind: "raw", rid, method, path, status: r.status, ms: performance.now() - started });
        },
        (e) => note({ kind: "raw", rid, method, path, error: String(e), ms: performance.now() - started }),
      );
    },

    xhr(rid, opts = {}) {
      return new Promise((resolve) => {
        const x = new XMLHttpRequest();
        const url = `${API}/api/xhr?rid=${encodeURIComponent(rid)}`;
        x.open("GET", url);
        x.withCredentials = true;
        // `fansly`: the headers of Fansly's client in the order its Angular
        // interceptors set them (public bundle).
        if (opts.fansly) {
          x.setRequestHeader("accept", "application/json, text/plain, */*");
          x.setRequestHeader("authorization", "stand-token");
          x.setRequestHeader("fansly-client-id", DEVICE);
          x.setRequestHeader("fansly-client-ts", String(Date.now()));
          x.setRequestHeader("fansly-session-id", "stand-session");
          x.setRequestHeader("fansly-client-check", clientCheck(url));
        } else {
          x.setRequestHeader("authorization", "stand-token");
        }
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

    /** What a site sees of the page's environment and device (stage 1
     *  items 11 and 16). */
    async environment() {
      const out = {};
      out.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      out.tzOffsetMin = new Date().getTimezoneOffset();
      out.locale = Intl.DateTimeFormat().resolvedOptions().locale;
      out.language = navigator.language;
      out.languages = navigator.languages;
      out.geo = await new Promise((resolve) => {
        if (!navigator.geolocation) return resolve("no api");
        navigator.geolocation.getCurrentPosition(
          (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
          (e) => resolve(`error ${e.code}: ${e.message}`),
          { timeout: 3000 },
        );
      });
      out.geoPermission = await navigator.permissions.query({ name: "geolocation" }).then((s) => s.state, (e) => String(e));
      out.screen = { w: screen.width, h: screen.height, aw: screen.availWidth, ah: screen.availHeight, depth: screen.colorDepth, dpr: devicePixelRatio, inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight] };
      out.cores = navigator.hardwareConcurrency;
      out.memory = navigator.deviceMemory;
      out.platform = navigator.platform;
      out.userAgent = navigator.userAgent;
      out.webdriver = navigator.webdriver;
      out.plugins = navigator.plugins.length;
      out.maxTouchPoints = navigator.maxTouchPoints;
      out.uaData = navigator.userAgentData
        ? await navigator.userAgentData.getHighEntropyValues(["architecture", "bitness", "model", "platformVersion", "fullVersionList", "wow64"]).catch((e) => String(e))
        : null;
      try {
        const gl = document.createElement("canvas").getContext("webgl");
        const info = gl && gl.getExtension("WEBGL_debug_renderer_info");
        out.webgl = gl ? { vendor: info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : null, renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null, version: gl.getParameter(gl.VERSION) } : "no webgl";
      } catch (e) {
        out.webgl = String(e);
      }
      const probe = ["Arial", "Helvetica", "Times New Roman", "Courier New", "Verdana", "Georgia", "Liberation Sans", "DejaVu Sans", "Noto Sans", "Noto Color Emoji", "Ubuntu", "Roboto", "Segoe UI", "San Francisco"];
      const canvas = document.createElement("canvas").getContext("2d");
      const width = (font) => { canvas.font = `40px ${font}`; return canvas.measureText("mmmmmmmmmmlli10OQ").width; };
      const base = { mono: width("monospace"), sans: width("sans-serif"), serif: width("serif") };
      out.fonts = probe.filter((name) => width(`"${name}", monospace`) !== base.mono || width(`"${name}", sans-serif`) !== base.sans || width(`"${name}", serif`) !== base.serif);
      return out;
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

  // The rehearsal of the live test's engine (stand/live): the page works on
  // its own, as a site does — a burst at load, a socket, a login, a poll,
  // and, with `auto=429`, a request the server answers 429.
  const auto = new URLSearchParams(location.search).get("auto");
  if (auto) {
    const tag = `auto${Date.now() % 100000}`;
    site.burst(`${tag}-load`, 8);
    site.ws(`${tag}-ws`);
    site.raw(`${tag}-login`, "POST", "/api/v1/login", { bodySize: 120 });
    let n = 0;
    setInterval(() => {
      n += 1;
      site.api(`${tag}-poll-${n}`, auto === "429" && n === 4 ? { query: "status=429" } : {});
    }, 4000);
  }
})();
