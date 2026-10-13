// The socket guard (plan §4.3, mandatory condition №3; spec §2.6; stage 1,
// §3.2, amendments 4, 5, 8, 9; FINDINGS 15, 21) — plain JavaScript that
// Chrome runs, not the operator. It goes, before any script of the site, into
// the main world of every document of the page — every tab and frame,
// about:blank and sandboxed ones included (Page.addScriptToEvaluateOnNewDocument)
// — and into every dedicated, shared and service worker, at a pause before
// its first script (ws/install.ts). The operator runs it as
//
//   (() => { <this file> pbWsGuard(binding, policy); })()
//
// so nothing of it is global.
//
// What it does: every message the page sends on a WebSocket is checked,
// synchronously, against the allow-list the operator embedded (spec §2.6):
// one that is not on it — forbidden or unknown — never leaves; the guard
// drops it and reports its shape (never its content: an authorization
// carries the token) to the operator through a CDP binding, which it takes
// and removes from the global object before the site runs. The operator
// then closes the exit and stops the page (`unknown_ws_message`). It is the
// first layer, not the only one: a context it could not go into (a frame
// created at the bottom of an exhausted stack throws before it runs) sends
// with the native send, and the proxy's socket gate (egress/socket-gate.ts)
// holds what that context writes outside the page's JavaScript.
//
// Nothing else of WebSocket is touched: the constructor, the instances, the
// events and every other property stay native. A new connection waits for
// the engine's admission outside the page, at the operator's proxy — each
// socket of the socket host is its own tunnel, and any other request to that
// host is refused, so no socket rides an existing connection (amendment 8).
// WebSocketStream, a second way to send that bypasses WebSocket.prototype.send,
// is removed (FINDINGS 9; Fansly's bundle does not use it).
//
// The site's scripts run after the guard and may replace any global or
// prototype method (zone.js patches plenty). So every built-in the guard
// calls is taken at install time, no native function is ever handed to code
// the site could have replaced, the Proxies' handlers and the objects the
// guard reads or reports have no prototype (an inherited `get` would be a
// Proxy trap that receives the native send; an inherited `toJSON` would
// rewrite a report), and nothing is iterated with the site's iterators
// (Astra's review of the prototype, finding 1; `ws-tamper`).
//
// The cost to the page's environment (owner decision №11): `send` and
// `Function.prototype.toString` are Proxies; toString answers for both as for
// the native functions, and an error the native send throws carries no frame
// of the guard.
//
// If the guard cannot do its job in a context — no `send` or `readyState` to
// wrap, a WebSocketStream that stays — it says so (`guard_failed`) and takes
// WebSocket away from that context: a context without the guard never sends
// unchecked, even before the operator has stopped the page.

function pbWsGuard(binding, policy) {
  "use strict";
  const g = globalThis;

  // ── built-ins, taken before the site runs ──────────────────────────────
  const rApply = Reflect.apply;
  const ownKeys = Reflect.ownKeys;
  const getOwnDesc = Object.getOwnPropertyDescriptor;
  const defineProp = Object.defineProperty;
  const getProto = Object.getPrototypeOf;
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const isArray = Array.isArray;
  const ProxyCtor = Proxy;
  const capture = typeof Error.captureStackTrace === "function" ? Error.captureStackTrace : null;
  const fnProto = Function.prototype;
  const uncurry = (fn) => rApply(fnProto.bind, fnProto.call, [fn]);
  const setHas = uncurry(Set.prototype.has);
  const mapGet = uncurry(Map.prototype.get);
  const weakGet = uncurry(WeakMap.prototype.get);
  const weakSet = uncurry(WeakMap.prototype.set);
  const hasOwn = uncurry(Object.prototype.hasOwnProperty);
  const charCodeAt = uncurry(String.prototype.charCodeAt);

  const report = typeof g[binding] === "function" ? g[binding] : null;
  try {
    delete g[binding];
  } catch {
    // a binding that cannot go stays unreachable by name only
  }
  // Where the guard went in (the document's or the worker's address at
  // install), read before the site could redefine anything on the way.
  let where = "";
  try {
    where = "" + g.location.href;
  } catch {
    // no location (some worklets): the operator knows the target
  }

  /** One report to the operator: a prototype-less object of primitives. */
  const say = (fields) => {
    if (report === null) return;
    try {
      fields.where = where;
      rApply(report, undefined, [stringify(fields)]);
    } catch {
      // a context that is going away
    }
  };

  /** WebSocket goes from this context: it cannot be guarded here. */
  const disable = () => {
    try {
      delete g.WebSocket;
    } catch {
      // non-configurable: overwritten below if possible
    }
    if (typeof g.WebSocket !== "undefined") {
      try {
        defineProp(g, "WebSocket", { __proto__: null, value: undefined, writable: false, configurable: false });
      } catch {
        // nothing more can be done in this context; the page stops
      }
    }
  };

  /** WebSocketStream (Chrome 124+) sends past WebSocket.prototype.send. */
  const removeStream = () => {
    if (typeof g.WebSocketStream === "undefined") return true;
    try {
      delete g.WebSocketStream;
    } catch {
      // checked below
    }
    return typeof g.WebSocketStream === "undefined";
  };

  const WS = g.WebSocket;
  if (typeof WS !== "function") {
    if (!removeStream()) return say({ __proto__: null, k: "guard_failed", why: "WebSocketStream stays" });
    return say({ __proto__: null, k: "installed", ws: false });
  }
  const proto = WS.prototype;
  const sendDesc = proto ? getOwnDesc(proto, "send") : undefined;
  const stateDesc = proto ? getOwnDesc(proto, "readyState") : undefined;
  if (!sendDesc || typeof sendDesc.value !== "function" || !stateDesc || typeof stateDesc.get !== "function") {
    disable();
    return say({ __proto__: null, k: "guard_failed", why: "no send or readyState to guard" });
  }
  const nativeSend = sendDesc.value;
  const stateOf = stateDesc.get;

  // ── the allow-list (spec §2.6), compiled into the guard's own objects ──
  const exact = new Set();
  for (let i = 0; i < policy.exact.length; i++) exact.add(policy.exact[i]);
  const rules = new Map();
  for (let i = 0; i < policy.json.length; i++) {
    const rule = policy.json[i];
    const keys = [];
    for (let j = 0; j < rule.keys.length; j++) keys[j] = rule.keys[j];
    let dKeys = null;
    const fields = [];
    if (rule.d !== null) {
      dKeys = [];
      for (let j = 0; j < rule.d.length; j++) {
        const field = rule.d[j];
        dKeys[j] = field.name;
        fields[j] = hasOwn(field, "equals") ? [field.name, 1, field.equals] : [field.name, 0, field.type];
      }
    }
    rules.set(rule.t, { __proto__: null, keys: keys, dKeys: dKeys, fields: fields });
  }

  /** Exactly these own keys (JSON.parse makes only own data properties). */
  const keysAre = (object, keys) => {
    const own = ownKeys(object);
    if (own.length !== keys.length) return false;
    for (let i = 0; i < keys.length; i++) if (!hasOwn(object, keys[i])) return false;
    return true;
  };
  /** A JSON object's text, parsed; null for anything else. */
  const parseObject = (text) => {
    if (typeof text !== "string" || text.length === 0 || charCodeAt(text, 0) !== 123) return null;
    let value;
    try {
      value = parse(text);
    } catch {
      return null;
    }
    return value !== null && typeof value === "object" && !isArray(value) ? value : null;
  };
  /** Each field of `d` is of its type, or equals its value. */
  const fieldsHold = (inner, fields) => {
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      const value = inner[field[0]];
      if (field[1] === 1 ? value !== field[2] : typeof value !== field[2]) return false;
    }
    return true;
  };
  const allowed = (data) => {
    if (typeof data !== "string") return false;
    if (setHas(exact, data)) return true;
    const m = parseObject(data);
    if (m === null || !hasOwn(m, "t")) return false;
    const t = m.t;
    if (typeof t !== "number" && typeof t !== "string") return false;
    const rule = mapGet(rules, t);
    if (rule === undefined || !keysAre(m, rule.keys)) return false;
    if (rule.dKeys === null) return true;
    const inner = parseObject(m.d);
    return inner !== null && keysAre(inner, rule.dKeys) && fieldsHold(inner, rule.fields);
  };

  /** Up to 20 key names as JSON array text (names of up to 64 characters);
   *  null when there are more or longer ones. */
  const names = (keys) => {
    if (keys.length > 20) return null;
    let text = "[";
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (typeof key !== "string" || key.length > 64) return null;
      text += (i > 0 ? "," : "") + stringify(key);
    }
    return text + "]";
  };
  /** What is reported of a blocked message: its form, length, JSON type and
   *  key names — never a value. */
  const shape = (data) => {
    if (typeof data !== "string") return { __proto__: null, k: "blocked_send", form: "non-text", type: typeof data };
    const m = parseObject(data);
    if (m === null) return { __proto__: null, k: "blocked_send", form: "text", len: data.length };
    const t = hasOwn(m, "t") ? m.t : null;
    const inner = hasOwn(m, "d") ? parseObject(m.d) : null;
    return {
      __proto__: null,
      k: "blocked_send",
      form: "json",
      len: data.length,
      msgType: typeof t === "number" || (typeof t === "string" && t.length <= 64) ? t : null,
      keys: names(ownKeys(m)),
      dKeys: inner === null ? null : names(ownKeys(inner)),
    };
  };

  // ── the Proxies ─────────────────────────────────────────────────────────
  const originals = new WeakMap();
  /** The native call; an error it throws looks thrown by it: the guard's
   *  frames are cut from its stack. */
  const native = (trap, target, thisArg, args) => {
    try {
      return rApply(target, thisArg, args);
    } catch (e) {
      if (capture !== null && e !== null && typeof e === "object") {
        try {
          capture(e, trap);
        } catch {
          // a frozen error keeps its stack
        }
      }
      throw e;
    }
  };
  const sendHandler = {
    __proto__: null,
    apply(target, thisArg, args) {
      // Only an open socket sends. Anything else — not a socket, still
      // connecting, closing, no argument — is the native send's business:
      // it throws or drops the data exactly as without the guard.
      let open;
      try {
        open = rApply(stateOf, thisArg, []) === 1;
      } catch {
        open = false;
      }
      if (open && args.length > 0 && !allowed(args[0])) {
        say(shape(args[0]));
        return undefined;
      }
      return native(sendHandler.apply, target, thisArg, args);
    },
  };
  const sendProxy = new ProxyCtor(nativeSend, sendHandler);
  weakSet(originals, sendProxy, nativeSend);

  const fnToString = fnProto.toString;
  const toStringDesc = getOwnDesc(fnProto, "toString");
  let toStringProxy = null;
  const toStringHandler = {
    __proto__: null,
    apply(target, thisArg, args) {
      const original = weakGet(originals, thisArg);
      if (original !== undefined) return native(toStringHandler.apply, target, original, args);
      // A function of another realm (a frame's): that realm's toString
      // knows its own guard.
      if (typeof thisArg === "function") {
        let other;
        try {
          other = getProto(thisArg);
        } catch {
          other = null;
        }
        if (other !== null && other !== fnProto) {
          let desc;
          try {
            desc = getOwnDesc(other, "toString");
          } catch {
            desc = undefined;
          }
          if (desc && typeof desc.value === "function" && desc.value !== toStringProxy) return native(toStringHandler.apply, desc.value, thisArg, args);
        }
      }
      return native(toStringHandler.apply, target, thisArg, args);
    },
  };
  toStringProxy = new ProxyCtor(fnToString, toStringHandler);
  weakSet(originals, toStringProxy, fnToString);

  // ── in place ────────────────────────────────────────────────────────────
  try {
    defineProp(proto, "send", { __proto__: null, value: sendProxy, writable: sendDesc.writable, enumerable: sendDesc.enumerable, configurable: sendDesc.configurable });
  } catch {
    disable();
    return say({ __proto__: null, k: "guard_failed", why: "send could not be replaced" });
  }
  if (toStringDesc) {
    try {
      defineProp(fnProto, "toString", { __proto__: null, value: toStringProxy, writable: toStringDesc.writable, enumerable: toStringDesc.enumerable, configurable: toStringDesc.configurable });
    } catch {
      // send is guarded; only its disguise is missing
    }
  }
  if (!removeStream()) {
    disable();
    return say({ __proto__: null, k: "guard_failed", why: "WebSocketStream stays" });
  }
  say({ __proto__: null, k: "installed", ws: true });
}
