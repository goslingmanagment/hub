// The socket guard inside the page (plan §4.3, mandatory condition №3),
// PROTOTYPE. It runs in the main world of every document (via
// Page.addScriptToEvaluateOnNewDocument) and in every worker (at a pause
// before its first script), before any script of the site.
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
// The site's scripts run after the guard and may replace any global or
// prototype method. So the guard takes every built-in it calls at install
// time (Reflect.apply, JSON, Set and WeakMap methods...) and never hands a
// native function to code the site could have replaced (Astra review of the
// prototype, finding 1).
//
// The cost to the page's environment (owner decision №11): `send` and
// `Function.prototype.toString` are Proxies; toString answers for both as for
// the native functions, and an error the native send throws carries no frame
// of the guard. The stand lists what is still observable.

export interface GuardPolicy {
  /** Messages allowed verbatim (Fansly's ping is "p"). */
  exact: string[];
  /** JSON object messages, by their `t`: the object's own keys, exactly, and
   *  — when its `d` is a JSON string — the own keys of what `d` holds. */
  json: Array<{ t: number | string; keys: string[]; dKeys?: string[] }>;
}

export function guardSource(binding: string, policy: GuardPolicy): string {
  return `(() => {
  "use strict";
  const g = globalThis;
  const report = typeof g[${JSON.stringify(binding)}] === "function" ? g[${JSON.stringify(binding)}] : null;
  try { delete g[${JSON.stringify(binding)}]; } catch (e) {}
  // Built-ins, taken before the site runs.
  const rApply = Reflect.apply;
  const ownKeys = Reflect.ownKeys;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const isArray = Array.isArray;
  const getProto = Object.getPrototypeOf;
  const defineProp = Object.defineProperty;
  const getOwnDesc = Object.getOwnPropertyDescriptor;
  const capture = Error.captureStackTrace;
  const ErrorCtor = Error;
  const uncurry = (fn) => rApply(Function.prototype.bind, Function.prototype.call, [fn]);
  const setHas = uncurry(Set.prototype.has);
  const mapGet = uncurry(Map.prototype.get);
  const weakGet = uncurry(WeakMap.prototype.get);
  const weakSet = uncurry(WeakMap.prototype.set);
  const hasOwn = uncurry(Object.prototype.hasOwnProperty);
  const charCodeAt = uncurry(String.prototype.charCodeAt);
  const tagOf = uncurry(Object.prototype.toString);
  const say = (k, extra) => {
    if (report === null) return;
    try {
      let href = "";
      try { href = "" + g.location.href; } catch (e) {}
      rApply(report, undefined, [stringify({ k: k, href: href, ...extra })]);
    } catch (e) {}
  };
  const WS = g.WebSocket;
  if (typeof WS !== "function") { say("installed", { ws: false }); return; }
  const proto = WS.prototype;
  const sendDesc = getOwnDesc(proto, "send");
  if (!sendDesc || typeof sendDesc.value !== "function") { say("guard_failed", { why: "no send" }); return; }
  const nativeSend = sendDesc.value;
  const readyState = getOwnDesc(proto, "readyState");
  const stateOf = readyState && typeof readyState.get === "function" ? readyState.get : null;
  if (stateOf === null) { say("guard_failed", { why: "no readyState" }); return; }
  const exact = new Set(${JSON.stringify(policy.exact)});
  const rules = new Map(${JSON.stringify(policy.json.map((rule) => [rule.t, { keys: rule.keys, dKeys: rule.dKeys ?? null }]))});
  const keysAre = (object, keys) => {
    const own = ownKeys(object);
    if (own.length !== keys.length) return false;
    for (let i = 0; i < keys.length; i++) if (!hasOwn(object, keys[i])) return false;
    return true;
  };
  const parseObject = (text) => {
    if (typeof text !== "string" || text.length === 0 || charCodeAt(text, 0) !== 123) return null;
    let value;
    try { value = parse(text); } catch (e) { return null; }
    return value !== null && typeof value === "object" && !isArray(value) ? value : null;
  };
  const allowed = (data) => {
    if (typeof data !== "string") return false;
    if (setHas(exact, data)) return true;
    const m = parseObject(data);
    if (m === null || !hasOwn(m, "t")) return false;
    const rule = mapGet(rules, m.t);
    if (rule === undefined || !keysAre(m, rule.keys)) return false;
    if (rule.dKeys === null) return true;
    const inner = parseObject(m.d);
    return inner !== null && keysAre(inner, rule.dKeys);
  };
  // What is reported about a blocked message: its form, length, JSON type
  // and key names — never a value (it may carry a token).
  const shape = (data) => {
    if (typeof data !== "string") return { form: tagOf(data) };
    const m = parseObject(data);
    if (m === null) return { form: "text", len: data.length };
    const inner = parseObject(m.d);
    const type = hasOwn(m, "t") && (typeof m.t === "number" || typeof m.t === "string") ? m.t : null;
    return { form: "json", len: data.length, msgType: type, keys: ownKeys(m).length <= 20 ? ownKeys(m) : null, dKeys: inner !== null && ownKeys(inner).length <= 20 ? ownKeys(inner) : null };
  };
  const originals = new WeakMap();
  // An error the native function throws must look thrown by it: the
  // guard's frames are cut from its stack.
  const native = (trap, target, thisArg, args) => {
    try {
      return rApply(target, thisArg, args);
    } catch (e) {
      if (e instanceof ErrorCtor && typeof capture === "function") capture(e, trap);
      throw e;
    }
  };
  const sendHandler = {
    apply(target, thisArg, args) {
      // Only an open socket sends. Anything else — not a socket, still
      // connecting, closing, no argument — is the native send's business:
      // it throws or drops the data exactly as without the guard.
      let open = false;
      try { open = rApply(stateOf, thisArg, []) === 1; } catch (e) {}
      if (open && args.length > 0 && !allowed(args[0])) {
        say("blocked_send", shape(args[0]));
        return undefined;
      }
      return native(sendHandler.apply, target, thisArg, args);
    },
  };
  const sendProxy = new Proxy(nativeSend, sendHandler);
  weakSet(originals, sendProxy, nativeSend);
  const fnToString = Function.prototype.toString;
  const ownFunctionProto = Function.prototype;
  let toStringProxy = null;
  const toStringHandler = {
    apply(target, thisArg, args) {
      const original = weakGet(originals, thisArg);
      if (original !== undefined) return native(toStringHandler.apply, target, original, args);
      // A function of another realm (a frame, say): that realm's toString
      // knows its own wrappers.
      if (typeof thisArg === "function") {
        const other = getProto(thisArg);
        if (other && other !== ownFunctionProto) {
          const desc = getOwnDesc(other, "toString");
          if (desc && typeof desc.value === "function" && desc.value !== toStringProxy) return native(toStringHandler.apply, desc.value, thisArg, args);
        }
      }
      return native(toStringHandler.apply, target, thisArg, args);
    },
  };
  toStringProxy = new Proxy(fnToString, toStringHandler);
  weakSet(originals, toStringProxy, fnToString);
  defineProp(proto, "send", { ...sendDesc, value: sendProxy });
  const tsDesc = getOwnDesc(ownFunctionProto, "toString");
  defineProp(ownFunctionProto, "toString", { ...tsDesc, value: toStringProxy });
  // WebSocketStream (Chrome 124+) is a second way to send on a socket that
  // bypasses WebSocket.prototype.send: removed, so every socket goes through
  // the checked path. (Fansly's bundle uses WebSocket.)
  if (typeof g.WebSocketStream !== "undefined") {
    try { delete g.WebSocketStream; } catch (e) {}
    if (typeof g.WebSocketStream !== "undefined") { say("guard_failed", { why: "WebSocketStream stays" }); return; }
  }
  say("installed", { ws: true });
})();`;
}
