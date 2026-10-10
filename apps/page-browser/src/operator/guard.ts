// The socket guard inside the page (plan §4.3, mandatory condition №3),
// PROTOTYPE. It runs in the main world of every document (via
// Page.addScriptToEvaluateOnNewDocument) and in every worker (via
// Runtime.evaluate before the worker starts), before any script of the site.
//
// What it does: every outgoing WebSocket message is checked synchronously
// against the allow-list embedded at injection; a message that is not on it
// is not sent, and the guard reports it to the operator through a CDP
// binding (captured, then removed from the global object). Nothing else of
// WebSocket is touched: the constructor, the instances, the events and every
// other property stay native. Admission of a new socket connection happens
// outside the page, at the operator's proxy (each socket of the socket host
// is its own tunnel; requests that could open an HTTP/2 session to that host
// are refused, so no socket can ride an existing connection).
//
// The cost to the page's environment (owner decision №11): `send` and
// `Function.prototype.toString` are Proxies; toString answers for both as for
// the native functions. The stand lists what is still observable.

export interface GuardPolicy {
  /** Messages allowed verbatim (Fansly's ping is "p"). */
  exact: string[];
  /** JSON object messages allowed by their `t` field. */
  jsonTypes: Array<number | string>;
}

export function guardSource(binding: string, policy: GuardPolicy): string {
  return `(() => {
  "use strict";
  const g = globalThis;
  const report = typeof g[${JSON.stringify(binding)}] === "function" ? g[${JSON.stringify(binding)}] : null;
  try { delete g[${JSON.stringify(binding)}]; } catch (e) {}
  const say = (k, extra) => { if (report) { try { report(JSON.stringify(Object.assign({ k: k, href: String(g.location && g.location.href) }, extra || {}))); } catch (e) {} } };
  const WS = g.WebSocket;
  if (typeof WS !== "function") { say("installed", { ws: false }); return; }
  const proto = WS.prototype;
  const sendDesc = Object.getOwnPropertyDescriptor(proto, "send");
  if (!sendDesc || typeof sendDesc.value !== "function") { say("guard_failed", { why: "no send" }); return; }
  const nativeSend = sendDesc.value;
  const exact = new Set(${JSON.stringify(policy.exact)});
  const types = new Set(${JSON.stringify(policy.jsonTypes)});
  const allowed = (data) => {
    if (typeof data !== "string") return false;
    if (exact.has(data)) return true;
    if (data.charCodeAt(0) !== 123) return false;
    let m;
    try { m = JSON.parse(data); } catch (e) { return false; }
    return m !== null && typeof m === "object" && !Array.isArray(m) && types.has(m.t);
  };
  // What is reported about a blocked message: its form, length and JSON
  // type only — never its content (it may carry a token).
  const shape = (data) => {
    if (typeof data !== "string") return { form: Object.prototype.toString.call(data) };
    let type = null;
    try { const m = JSON.parse(data); if (m && typeof m === "object") type = m.t; } catch (e) {}
    return { form: "text", len: data.length, msgType: type };
  };
  const originals = new WeakMap();
  const sendProxy = new Proxy(nativeSend, {
    apply(target, thisArg, args) {
      if (args.length > 0 && !allowed(args[0])) {
        say("blocked_send", shape(args[0]));
        return undefined;
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
  originals.set(sendProxy, nativeSend);
  const fnToString = Function.prototype.toString;
  const ownFunctionProto = Function.prototype;
  const toStringProxy = new Proxy(fnToString, {
    apply(target, thisArg, args) {
      const original = originals.get(thisArg);
      if (original !== undefined) return Reflect.apply(target, original, args);
      // A function of another realm (a frame, say): that realm's toString
      // knows its own wrappers.
      if (typeof thisArg === "function") {
        const proto = Object.getPrototypeOf(thisArg);
        if (proto && proto !== ownFunctionProto && typeof proto.toString === "function" && proto.toString !== toStringProxy) {
          return Reflect.apply(proto.toString, thisArg, args);
        }
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
  originals.set(toStringProxy, fnToString);
  Object.defineProperty(proto, "send", Object.assign({}, sendDesc, { value: sendProxy }));
  const tsDesc = Object.getOwnPropertyDescriptor(Function.prototype, "toString");
  Object.defineProperty(Function.prototype, "toString", Object.assign({}, tsDesc, { value: toStringProxy }));
  // WebSocketStream (Chrome 124+) is a second way to send on a socket that
  // bypasses WebSocket.prototype.send: removed, so every socket goes through
  // the checked path. (Fansly's bundle uses WebSocket.)
  let wss = typeof g.WebSocketStream;
  if (wss !== "undefined") {
    try { delete g.WebSocketStream; } catch (e) {}
    wss = typeof g.WebSocketStream === "undefined" ? "removed" : "present";
  }
  say("installed", { ws: true, wss: wss });
})();`;
}
