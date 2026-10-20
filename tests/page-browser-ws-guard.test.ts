import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { allowedMessage, guardExpression, guardSource, messageKind, parseGuardReport, shapeFields, shapeOf, SOCKET_POLICY } from "../apps/page-browser/src/ws/guard.ts";

// The socket guard inside the page (Project Browser plan §4.3; spec §2.6;
// mandatory condition №3; stage 1, `ws-tamper`, `ws-detect`): its source
// runs here in a Node realm of its own (vm), the way Chrome runs it before
// the site — with a WebSocket shaped like Chrome's (send and readyState on
// the prototype, brand-checked) — and then "the site's" code runs there.
// What must hold: only spec §2.6's messages leave an open socket; the first
// other one never does and is reported by its shape, never its content; the
// site's replacing of built-ins and prototypes neither lets one through nor
// hands it the native send; and the page sees WebSocket as before.

const BINDING = "pbTestBinding0123456789";
const TOKEN = "eyJ-socket-token-value-9f8e7d6c5b4a";
const AUTH = JSON.stringify({ t: 1, d: JSON.stringify({ token: TOKEN, v: 3 }) });

/** Chrome's WebSocket, as far as the guard touches it, in the realm's own
 *  built-ins: `send` writes to the wire only when OPEN, throws while
 *  CONNECTING, drops when CLOSING or CLOSED; both check their `this`. */
const CHROME_LIKE = `
  const slots = new WeakMap();
  function WebSocket(url) {
    if (!new.target) throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator.");
    slots.set(this, { state: 0, url: String(url) });
  }
  Object.defineProperty(WebSocket.prototype, "readyState", { get: function readyState() { const s = slots.get(this); if (!s) throw new TypeError("Illegal invocation"); return s.state; }, enumerable: true, configurable: true });
  Object.defineProperty(WebSocket.prototype, "url", { get: function url() { const s = slots.get(this); if (!s) throw new TypeError("Illegal invocation"); return s.url; }, enumerable: true, configurable: true });
  Object.defineProperty(WebSocket.prototype, "send", { value: function send(data) {
    const s = slots.get(this);
    if (!s) throw new TypeError("Illegal invocation");
    if (s.state === 0) { const e = new Error("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state."); e.name = "InvalidStateError"; throw e; }
    if (s.state === 1) __wire(data);
  }, writable: true, enumerable: true, configurable: true });
  Object.defineProperty(WebSocket.prototype, "close", { value: function close() { const s = slots.get(this); if (s) s.state = 3; }, writable: true, enumerable: true, configurable: true });
  globalThis.WebSocket = WebSocket;
  globalThis.WebSocketStream = function WebSocketStream() {};
  globalThis.__setState = (ws, state) => { slots.get(ws).state = state; };
`;

interface Realm {
  context: vm.Context;
  wire: unknown[];
  reports: Array<Record<string, unknown>>;
  /** Raw report payloads, as the binding got them. */
  payloads: string[];
  run: <T = unknown>(code: string) => T;
}

function realm(options: { prelude?: string; install?: boolean; binding?: boolean } = {}): Realm {
  const wire: unknown[] = [];
  const payloads: string[] = [];
  const context = vm.createContext({ __wire: (data: unknown) => wire.push(data) });
  if (options.binding !== false) context[BINDING] = (payload: string) => payloads.push(payload);
  vm.runInContext(options.prelude ?? CHROME_LIKE, context, { filename: "chrome.js" });
  if (options.install !== false) vm.runInContext(guardExpression(BINDING), context, { filename: "ws-guard.js" });
  return {
    context,
    wire,
    payloads,
    get reports() {
      return payloads.map((payload) => JSON.parse(payload) as Record<string, unknown>);
    },
    run: <T,>(code: string) => vm.runInContext(code, context, { filename: "site.js" }) as T,
  };
}

/** An open socket of the realm, as a global named `ws`. */
function openSocket(r: Realm, name = "ws"): void {
  r.run(`globalThis.${name} = new WebSocket("wss://wsv3.fansly.com/?v=3"); __setState(${name}, 1);`);
}

describe("the socket guard: what may leave (spec §2.6)", () => {
  it("installs before the site: reports it, and the binding is gone from the global object", () => {
    const r = realm();
    expect(r.reports).toEqual([{ k: "installed", ws: true, where: "" }]);
    expect(r.run(`typeof globalThis[${JSON.stringify(BINDING)}]`)).toBe("undefined");
    expect(r.run(`Object.getOwnPropertyNames(globalThis).filter((name) => name.startsWith("pb"))`)).toEqual([]);
    expect(r.run(`typeof pbWsGuard`)).toBe("undefined");
  });

  it("lets the authorization and the ping go, as they are", () => {
    const r = realm();
    openSocket(r);
    r.run(`ws.send(${JSON.stringify(AUTH)}); ws.send("p"); ws.send("p")`);
    expect(r.wire).toEqual([AUTH, "p", "p"]);
    expect(r.reports.filter((report) => report.k === "blocked_send")).toEqual([]);
  });

  it("never lets the first forbidden or unknown message leave, and reports only its shape", () => {
    const r = realm();
    openSocket(r);
    const refused = [
      JSON.stringify({ t: 46001, d: JSON.stringify({ chatRoomId: "1" }) }), // a chat room subscription (chatws)
      JSON.stringify({ t: 99, d: "x" }),
      JSON.stringify({ t: 1, d: JSON.stringify({ token: TOKEN, v: 2 }) }), // another version
      JSON.stringify({ t: 1, d: JSON.stringify({ token: 42, v: 3 }) }), // a token that is not a string
      JSON.stringify({ t: 1, d: JSON.stringify({ token: TOKEN, v: 3, extra: true }) }),
      JSON.stringify({ t: 1, d: JSON.stringify({ token: TOKEN, v: 3 }), x: 1 }),
      JSON.stringify({ t: "1", d: JSON.stringify({ token: TOKEN, v: 3 }) }),
      JSON.stringify({ t: 1, d: { token: TOKEN, v: 3 } }),
      " " + AUTH,
      "P",
      "ping",
      "",
    ];
    for (const message of refused) r.run(`ws.send(${JSON.stringify(message)})`);
    r.run(`ws.send(new Uint8Array([1, 2, 3])); ws.send({ toString() { return "p"; } })`);
    expect(r.wire).toEqual([]);
    const blocked = r.reports.filter((report) => report.k === "blocked_send");
    expect(blocked).toHaveLength(refused.length + 2);
    expect(blocked[0]).toEqual({ k: "blocked_send", form: "json", len: refused[0]!.length, msgType: 46001, keys: '["t","d"]', dKeys: '["chatRoomId"]', where: "" });
    expect(blocked[2]).toMatchObject({ form: "json", msgType: 1, dKeys: '["token","v"]' });
    expect(blocked.at(-2)).toEqual({ k: "blocked_send", form: "non-text", type: "object", where: "" });
    // Never a value: the token is in no report.
    expect(r.payloads.join("\n")).not.toContain(TOKEN);
    expect(r.payloads.join("\n")).not.toContain("chatRoomId\":\"1");
  });

  it("leaves a socket that is not open to the native send: it throws while connecting, drops once closed — and an error carries no frame of the guard", () => {
    const r = realm();
    r.run(`globalThis.ws = new WebSocket("wss://wsv3.fansly.com/?v=3")`);
    const error = r.run<Error>(`try { ws.send(${JSON.stringify(JSON.stringify({ t: 99 }))}); null } catch (e) { e }`);
    expect(error).toMatchObject({ name: "InvalidStateError" });
    expect(String(error.stack)).toContain("site.js");
    expect(String(error.stack)).not.toContain("ws-guard.js");
    r.run(`__setState(ws, 3); ws.send("anything")`);
    const illegal = r.run<Error>(`try { WebSocket.prototype.send.call({}, "p"); null } catch (e) { e }`);
    expect(illegal).toMatchObject({ name: "TypeError", message: "Illegal invocation" });
    expect(String(illegal.stack)).not.toContain("ws-guard.js");
    expect(r.wire).toEqual([]);
    expect(r.reports.filter((report) => report.k === "blocked_send")).toEqual([]);
  });

  it("agrees with the operator's own check (ws/guard.ts) on every message", () => {
    const r = realm();
    openSocket(r);
    const corpus = [
      "p",
      AUTH,
      JSON.stringify({ d: JSON.stringify({ v: 3, token: "a" }), t: 1 }),
      JSON.stringify({ t: 1, d: JSON.stringify({ token: "", v: 3 }) }),
      JSON.stringify({ t: 1, d: JSON.stringify({ token: "a", v: "3" }) }),
      JSON.stringify({ t: 1, d: "[1,2]" }),
      JSON.stringify({ t: 1, d: "not json" }),
      JSON.stringify({ t: 2 }),
      JSON.stringify([1, AUTH]),
      "{",
      "pp",
      JSON.stringify({ t: 1, d: JSON.stringify({ token: "a", v: 3 }), __proto__: null }),
      '{"t":1,"d":"{\\"token\\":\\"a\\",\\"v\\":3}","t":1}',
    ];
    for (const message of corpus) {
      const before = r.wire.length;
      r.run(`ws.send(${JSON.stringify(message)})`);
      expect(r.wire.length > before, message).toBe(allowedMessage(message));
    }
  });
});

describe("the socket guard against the site's own scripts (ws-tamper)", () => {
  it("is not fooled, nor robbed of the native send, by replaced built-ins and prototypes", () => {
    const r = realm();
    openSocket(r);
    const out = r.run<Record<string, unknown>>(`(() => {
      const out = {};
      const msg = (n) => JSON.stringify({ t: 99, d: "tamper-" + n });
      // A spy on Reflect.apply that grabs a function called "send".
      const realApply = Reflect.apply;
      let captured = null;
      Reflect.apply = function (target, thisArg, args) { if (captured === null && typeof target === "function" && target !== WebSocket.prototype.send) captured = target; return realApply(target, thisArg, args); };
      try { ws.send("p"); } finally { Reflect.apply = realApply; }
      if (captured) { try { captured.call(ws, msg(1)); out.viaApply = true; } catch (e) { out.applyError = String(e); } }
      // A JSON.parse that says "authorization".
      const realParse = JSON.parse;
      JSON.parse = function () { return { t: 1, d: '{"token":"x","v":3}' }; };
      try { ws.send(msg(2)); } finally { JSON.parse = realParse; }
      // A "t" on every object.
      Object.defineProperty(Object.prototype, "t", { configurable: true, get() { return 1; } });
      try { ws.send(JSON.stringify({ d: '{"token":"x","v":3}', x: "tamper-3" })); } finally { delete Object.prototype.t; }
      // A spy on WeakMap.prototype.get (the guard's originals).
      const realGet = WeakMap.prototype.get;
      let map = null;
      WeakMap.prototype.get = function (key) { map = this; return realGet.call(this, key); };
      try { Function.prototype.toString.call(WebSocket.prototype.send); } finally { WeakMap.prototype.get = realGet; }
      if (map) { const n = realGet.call(map, WebSocket.prototype.send); if (typeof n === "function") { try { n.call(ws, msg(4)); out.viaMap = true; } catch (e) { out.mapError = String(e); } } }
      // Set, Map, ownKeys, hasOwnProperty, charCodeAt that say yes.
      const realHas = Set.prototype.has; Set.prototype.has = () => true;
      try { ws.send(msg(5)); } finally { Set.prototype.has = realHas; }
      const realMapGet = Map.prototype.get; Map.prototype.get = () => ({ keys: ["t", "d"], dKeys: null, fields: [] });
      try { ws.send(msg(6)); } finally { Map.prototype.get = realMapGet; }
      const realOwnKeys = Reflect.ownKeys; Reflect.ownKeys = () => ["t", "d"];
      try { ws.send(JSON.stringify({ t: 1, d: '{"token":"x","v":3,"x":"tamper-7"}' })); } finally { Reflect.ownKeys = realOwnKeys; }
      const realHasOwn = Object.prototype.hasOwnProperty; Object.prototype.hasOwnProperty = () => true;
      try { ws.send(JSON.stringify({ t: 1, d: '{"token":"x","v":3,"x":"tamper-8"}' })); } finally { Object.prototype.hasOwnProperty = realHasOwn; }
      const realCharCodeAt = String.prototype.charCodeAt; String.prototype.charCodeAt = () => 123;
      try { ws.send("tamper-9"); } finally { String.prototype.charCodeAt = realCharCodeAt; }
      // Function.prototype.call, apply and bind replaced.
      const realCall = Function.prototype.call; const realBind = Function.prototype.bind; const realFnApply = Function.prototype.apply;
      Function.prototype.call = function () { return true; }; Function.prototype.bind = function () { return () => true; }; Function.prototype.apply = function () { return true; };
      try { ws.send(msg(10)); } finally { Function.prototype.call = realCall; Function.prototype.bind = realBind; Function.prototype.apply = realFnApply; }
      // Array iteration replaced.
      const realIterator = Array.prototype[Symbol.iterator]; Array.prototype[Symbol.iterator] = function* () {};
      try { ws.send(msg(11)); } finally { Array.prototype[Symbol.iterator] = realIterator; }
      // A Proxy trap inherited by the guard's handlers would receive the
      // native send as its target.
      let leaked = null;
      for (const trap of ["get", "has", "getOwnPropertyDescriptor", "ownKeys", "getPrototypeOf", "set", "defineProperty", "deleteProperty", "isExtensible", "preventExtensions", "setPrototypeOf"]) {
        Object.prototype[trap] = function (target) { if (leaked === null && typeof target === "function") leaked = target; return Reflect[trap](...arguments); };
      }
      try {
        const send = WebSocket.prototype.send;
        void send.name; void ("x" in send); void Object.getOwnPropertyDescriptor(send, "length"); void Reflect.ownKeys(send); void Object.getPrototypeOf(send);
        void Object.isExtensible(send);
      } finally {
        for (const trap of ["get", "has", "getOwnPropertyDescriptor", "ownKeys", "getPrototypeOf", "set", "defineProperty", "deleteProperty", "isExtensible", "preventExtensions", "setPrototypeOf"]) delete Object.prototype[trap];
      }
      if (leaked) { try { leaked.call(ws, msg(12)); out.viaTrap = true; } catch (e) { out.trapError = String(e); } }
      // A toJSON everywhere would rewrite the guard's report.
      Object.prototype.toJSON = function () { return { k: "installed", ws: true }; };
      try { ws.send(msg(13)); } finally { delete Object.prototype.toJSON; }
      // A site wrapper of its own around send (zone.js does that): still checked.
      const guarded = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) { return guarded.call(this, data); };
      ws.send(msg(14));
      ws.send("p");
      WebSocket.prototype.send = guarded;
      return out;
    })()`);
    const leaked = r.wire.filter((data) => String(data).includes("tamper"));
    expect(leaked).toEqual([]);
    expect(out.viaApply).toBeUndefined();
    expect(out.viaMap).toBeUndefined();
    expect(out.viaTrap).toBeUndefined();
    expect(r.wire).toEqual(["p", "p"]);
    // The spies on Reflect.apply, WeakMap.prototype.get and the traps never
    // ran: nothing was captured to send with. Every other tampered send was
    // reported as blocked — the toJSON one too.
    expect(out).toEqual({});
    const blocked = r.reports.filter((report) => report.k === "blocked_send");
    expect(blocked.length).toBe(11);
    expect(r.reports.filter((report) => report.k === "installed")).toHaveLength(1);
  });
});

describe("the socket guard where it cannot guard", () => {
  it("still guards without its binding (it cannot report, nothing leaves)", () => {
    const r = realm({ binding: false });
    openSocket(r);
    r.run(`ws.send(${JSON.stringify(JSON.stringify({ t: 99 }))}); ws.send("p")`);
    expect(r.wire).toEqual(["p"]);
    expect(r.payloads).toEqual([]);
  });
});

describe("the operator's side of the guard (ws/guard.ts)", () => {
  it("builds one expression from inpage/ws-guard.js that leaves nothing global", () => {
    const expression = guardExpression("pbX", SOCKET_POLICY);
    expect(expression).toContain(guardSource());
    expect(expression.trim().endsWith("})()")).toBe(true);
    expect(() => new vm.Script(expression)).not.toThrow();
  });

  it("reads the guard's reports as untrusted text: names and types only when they look like names", () => {
    expect(parseGuardReport(JSON.stringify({ k: "blocked_send", form: "json", len: 40, msgType: TOKEN, keys: JSON.stringify(["t", TOKEN]), dKeys: null, where: "https://fansly.com/messages?token=1" }))).toEqual({
      k: "blocked_send",
      where: "https://fansly.com/messages?token=1",
      shape: { form: "json", len: 40, msgType: "?", keys: ["t", "?"], dKeys: null },
    });
    expect(parseGuardReport("not json")).toBeNull();
    expect(parseGuardReport(JSON.stringify({ k: "something" }))).toBeNull();
    expect(parseGuardReport("x".repeat(9000))).toBeNull();
    expect(parseGuardReport(JSON.stringify({ k: "guard_failed", why: "WebSocketStream stays" }))).toMatchObject({ k: "guard_failed", why: "WebSocketStream stays" });
    expect(parseGuardReport(JSON.stringify({ k: "guard_failed", why: "y".repeat(500) }))).toMatchObject({ k: "guard_failed", why: "?" });
    expect(parseGuardReport(JSON.stringify({ k: "guard_failed", why: `token=${TOKEN}` }))).toMatchObject({ k: "guard_failed", why: "?" });
  });

  it("names what left: ping, authorization, or other — and a shape never carries a value", () => {
    expect(messageKind("p")).toBe("ping");
    expect(messageKind(AUTH)).toBe("auth");
    expect(messageKind(JSON.stringify({ t: 46001 }))).toBe("other");
    const fields = shapeFields(shapeOf(AUTH));
    expect(fields).toEqual({ form: "json", len: AUTH.length, msgType: 1, keys: "t,d", dKeys: "token,v" });
    expect(JSON.stringify(fields)).not.toContain(TOKEN);
  });
});
