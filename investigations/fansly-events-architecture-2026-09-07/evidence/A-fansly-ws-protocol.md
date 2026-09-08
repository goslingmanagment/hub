# A — Fansly real-time event protocol (`wss://wsv3.fansly.com?v=3`)

Read-only reverse-engineering report. **No request was made to any Fansly host for this report.**
All bundle citations are `analysis/main.pretty.js:LINE` inside
`/Users/dmitriy/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/`
(prettified capture of `raw/main.ac7fcc376bc818b0.js`, captured 2026-08-20).
HAR citations are the captures under `/Users/dmitriy/code/goose/hub/artifacts/`.

Confidence tags used throughout: **bundle-proven** (the shipped client code says so),
**HAR-observed** (seen on the wire in a stored capture), **vendor-doc** (OnlyFansAPI docs),
**public-repo**, **inferred**, **unknown**.

**Contents:** 1 TL;DR · 2 transport spec · 3 outbound messages · 4 event catalogue ·
5 presence · 6 gaps/ordering/reconnect · 7 vendor cross-check · 8 public-repo findings ·
9 `chatws.fansly.com` · 10 multi-connection & identity · **11 UNKNOWNS — live-test checklist** ·
Appendix A evidence index.

---

## 1. TL;DR (10 lines)

1. Fansly's web client holds exactly **one** app-wide WebSocket, `wss://wsv3.fansly.com?v=3`, plain-JSON text frames, no subprotocol, no binary. `chatws.fansly.com` is a *second, separate, per-live-stream-chat* socket and is irrelevant to DMs/money.
2. The socket is **receive-only in practice**: the client sends exactly two things ever — one `SessionVerifyRequest` (`{"t":1,"d":"{\"token\":…,\"v\":3}"}`) on open and the literal text `p` every 20–25 s. There is **no subscribe/unsubscribe/filter message on wsv3 at all** (`main.pretty.js:20838`, `20712`; the only subscribe request in the whole bundle is `ChatRoomSubscribeRequest` on the *chat* socket, `254183`).
3. Consequence: after a single `SessionVerifyRequest`, the server pushes **everything for that account**, across ~17 services, unfiltered. One connection = the whole account firehose.
4. Auth uses the **same opaque session token as the REST `authorization` header** (`22710`, `13572`). Cookies are sent by the browser but carry no session token; `fansly-client-id/-ts/-session-id/-check` are **REST-only** headers (`36366-36391`) and are absent from the WS handshake (HAR-observed).
5. Frame envelope: `{"t":<code>,"d":<string>}`. `t=0` ErrorEvent (401 ⇒ client logs out), `t=1` SessionVerified, `t=2` PingResponse, `t=10000` ServiceEvent `{serviceId, event}` where `event` is a **doubly-encoded JSON string**, `t=10001` batch (array of wrapper strings, recursively handled) (`20810-20831`).
6. Payload completeness is **per-service and uneven**: DMs (`MessageService=5`) carry the *full* message object but attachments are `{contentType, contentId}` id-refs only; `NotificationService=9` type 1 carries the full notification record (which is itself id-refs + metadata); `GroupService=4` type 8 (new conversation) carries **only an id** and forces a REST `GET /group/{id}`; `PostService=1` type 1 makes the client re-fetch via `GET /post?ids=`.
7. **There are no sequence numbers, no event ids, no resume token, no backlog/replay API.** Nothing in the client tracks a cursor. The official catch-up recipe is: on `SessionVerified` re-fetch the *active* conversation only (`35018`); on tab-visible-after-30 s re-fetch unread + wallets + notification counters (`34883`, `163128-163145`).
8. **Holding the socket does NOT make the account appear online.** Presence is a separate REST heartbeat `POST /api/v1/status {statusId}` every 90–120 s, gated on real UI activity in the last 5 min (`38077-38105`, `38046`); HAR shows it at +5.9 s and +112.7 s after connect. A headless consumer that never POSTs `/status` stays offline.
9. Multi-connection with one token is **supported and routine**: the live-chat socket verifies with the same token while wsv3 is open (`254180-254190`); every browser tab opens its own wsv3. No client-side single-connection guard exists.
10. Biggest operational unknown: the socket is **not observed to be long-lived** — 17 handshakes in 84 min in the UI-walk HAR, gaps 30 s–26 min, with no page reloads. Whether that is the server, the client's own 24–30 s ping-timeout reset, or the capture environment is **unknown** and is the #1 thing a live test must settle. **No public implementation of the wsv3 event stream exists** (§8) — we would be the first non-browser consumer, so nobody has published connection caps, idle timeouts or ban reports for us to lean on.

---

## 2. Transport spec

### 2.1 Endpoint & handshake

| Item | Value | Confidence | Evidence |
|---|---|---|---|
| URL (constant in code) | `wss://wsv3.fansly.com?v=3` | bundle-proven | `main.pretty.js:20022` |
| URL (as sent by Firefox) | `wss://wsv3.fansly.com/?v=3` | HAR-observed | `fansly-ui-walk-2026-08-21.har` entry 33 |
| Query params | only `v=3` | bundle-proven | `20022` |
| Subprotocol (`Sec-WebSocket-Protocol`) | **none** — `new WebSocket(uri)` with a single argument | bundle-proven | `19981` |
| `binaryType` | `"arraybuffer"` (set, but never used — see §2.5) | bundle-proven | `19982` |
| Handshake status | `101 Switching Protocols` | HAR-observed | all 17 wsv3 entries |
| `Origin` | `https://fansly.com` (browser-set) | HAR-observed | entry 33 |
| `Sec-WebSocket-Extensions` | `permessage-deflate` offered by Firefox; **server response carries no `Sec-WebSocket-Extensions`**, i.e. compression was declined | HAR-observed | entry 33 resp headers = `Date, Connection, Upgrade, Sec-WebSocket-Accept` only |
| `Cookie` | 13 cookies sent (`_ga`, `amp_4fb08e`, `f-s-c`, `f-v-v`, `f-v-d`, `f-d`, `fansly-d`, `_twpid`, `_ga_BZSVNWD5W8`, `intercom-*`, `ly-a`, `fansly-ts-info`) | HAR-observed | entry 33 |
| Custom `fansly-*` headers on the WS | **none** | HAR-observed | entry 33 request headers |

> **Correction to the brief:** the handshake Cookie is *not* just `_ga`. It carries the full first-party cookie jar including the device cookies `f-d` / `fansly-d`. None of them is the session token (the token travels in the first frame).
>
> **Are cookies / `Origin` load-bearing? Probably not.** `agnosto/fansly-scraper` (Go) dials `wss://wsv3.fansly.com/` with `websocket.DefaultDialer.Dial(url, nil)` — **no Origin, no User-Agent, no cookies** — and gets a successful `SessionVerifyRequest` round-trip (public-repo, §8.2). Treat as *probably not gated*, confirm from our own egress (live-test T5).

**Note on the URL form.** The bundle constant is `wss://wsv3.fansly.com?v=3` — **no slash before `?`** (`20022`; still true in the 2026-09-06 bundle, §8.4). Browsers normalise it to `/?v=3` (HAR). Public clients variously use `/`, `/?v=3` or no query at all and all succeed, so the path/query form appears not to matter.

### 2.2 Auth message (exact bytes)

`onConnect` reads the active session; if there is one it sends:

```js
// main.pretty.js:20765-20772
onConnect() {
  const e = this.sessionService_.getActiveSession();
  this.pendingActiveSession_ = null;
  this.lastPingResponse_ = Date.now();
  null !== e
    ? (this.authSession_ = e,
       this.setConnectionState(o.CONNECTION_STATES.AUTHORIZING),
       this.sendSessionVerifyRequest({ token: e.token, v: 3 }))
    : this.setConnectionState(o.CONNECTION_STATES.CONNECTED);
}
```

```js
// main.pretty.js:20832-20845 — note the DOUBLE JSON encoding of `d`
wrapRequest(e, t)            { return this.encodeMessage("RequestWrapper", { t: e, d: t }); }
sendSessionVerifyRequest(e)  { this.websocketService_.sendText(
                                 this.wrapRequest(1, this.encodeMessage("SessionVerifyRequest", e))); }
// encodeMessage === JSON.stringify (main.pretty.js:20662)
```

Literal text frame on the wire:

```
{"t":1,"d":"{\"token\":\"<SESSION_TOKEN>\",\"v\":3}"}
```

`<SESSION_TOKEN>` is byte-identical to the value of the REST `authorization` header — the interceptor sets `authorization: session.token` with **no `Bearer` prefix** (`main.pretty.js:22703-22715`, and the logout path `13572`). **bundle-proven.**

**Is `"v":3` required?** Almost certainly not. Public clients send it in the payload, in the query, in neither, or in the chat-room join instead — and every variant completes a verify (public-repo, §8.2/8.3). Keep sending both anyway; it costs nothing and it is what the shipped client does.

**The `SessionVerified` reply body.** The official client discards it (`20785-20789` never reads the argument). Public wsv3 clients show it is `{"session":{"id":"<snowflake>"}}` — that id is the same `session.id` that goes into the REST `fansly-session-id` header (public-repo). We do **not** need the socket for it: our session record from `POST /login` already carries `{id, accountId, deviceId, token, metadata}` (`13008-13018`). One caveat from `agnosto/fansly-scraper`: it accepts **`t=1` *or* `t=2`** as a successful auth reply, so a decoder should not fail closed if the first frame back is a PingResponse-shaped wrapper.

### 2.3 Anonymous connection

Yes, the client connects **without any session**. At bootstrap:

```js
// main.pretty.js:39003-39004
e.eventService_.initialize();
e.eventService_.onSessionChange(w);   // w === getActiveSession(), may be null
```

`onSessionChange(null)` falls through to `connectWebsocket(null)` (`20757-20763`), and `onConnect` with a null session goes straight to `CONNECTED` **without sending any frame** (`20771`). So an anonymous socket is opened and simply never verified. **bundle-proven.** What the server pushes to an unverified socket is **unknown** (almost certainly nothing account-scoped; possibly nothing at all).

### 2.4 Ping / pong

```js
// main.pretty.js:20688-20689
this.pingInterval_ = re.randomIntFromInterval(2e4, 25e3);   // 20000..25000 ms, randomised per instance
this.pingTimeout_  = 1.2 * this.pingInterval_;              // 24000..30000 ms

// main.pretty.js:20706-20713 — the single interval that both pings and self-heals
this.pingIntervalRef_ = setInterval(function () {
  let t = Date.now();
  t - e.lastPingResponse_ > e.pingTimeout_
    ? (t - e.lastConnectionReset_ > 15e3 && (e.lastConnectionReset_ = t, e.resetWebsocket()))
    : e.websocketService_.isConnected() && e.websocketService_.sendText("p");
}, this.pingInterval_);
```

- Client ping = the **1-byte text frame `p`** (not a WS control ping). `bundle-proven`.
- Server pong = wrapper `t=2` → `handlePingResponseEvent` sets `lastPingResponse_ = Date.now()` (`20790-20792`, `20820-20823`). The pong payload content is never read.
- `lastPingResponse_` is also seeded at connect time (`20767`), so the first timeout can only fire ~24–30 s after open.
- Dead-peer detection: **24–30 s** without any `t=2`, rate-limited to one reset per 15 s.
- There is a second, unused `Q4.sendPing()` that writes `"p"` (`19935`) — no call site.

### 2.5 Binary frames

**The client never sends and never reads a binary frame.**
- `WebsocketService.sendBytes` exists (`20063`) but has **zero call sites** in the whole bundle.
- `EventService.handleBytes(e) {}` is an **empty method** (`20809`).
- `binaryType = "arraybuffer"` (`19982`) is set so that any inbound binary lands in `onBytes` → `handleBytes` → discarded.

So: JSON text only. **bundle-proven.**

### 2.6 Reconnect / backoff

Two independent supervisors, plus one visibility hook.

**(a) Transport supervisor** — a self-rearming timer inside the raw client (`19938-19962`):

```js
startReconnectTimer(o = !1) {
  if (this.reconnect_timeout_ref_) return;
  let e = function () {
    i.reconnect_timeout_ref_ = null;
    i.isConnected()
      ? (i.reconnect_timeout_ = 15e3, i.startReconnectTimer())          // healthy: re-check in 15 s
      : (i.reconnect_timeout_ *= 2,
         i.reconnect_timeout_ > 15e3 && (i.reconnect_timeout_ = 15e3),
         i.setUpConnection(), i.startReconnectTimer());                  // dead: reconnect + back off
  };
  o ? e() : (this.reconnect_timeout_ref_ = setTimeout(e, this.reconnect_timeout_));
}
```

Initial `reconnect_timeout_ = 1500` ms (`19910`), reset to 1500 on `stopReconnectTimer()` (`19961`). Effective schedule after a drop: first retry ≈ **+1.5 s**, then 3 s, 6 s, 12 s, **capped at 15 s**; once connected the timer degenerates into a 15 s liveness poll. `onerror` and `onclose` both do `onDisconnect → clearConnection → stopReconnectTimer → startReconnectTimer` (`19999-20012`), i.e. **the backoff is reset to 1.5 s on every close**. There is **no jitter** on the transport backoff and **no cap on attempts**.

**(b) Application supervisor** — the ping loop above (`resetWebsocket()` → `connectWebsocket(activeSession)` → full new socket, `20846-20849`).

**(c) Visibility hook** — when the tab becomes visible after >1 s hidden:

```js
// main.pretty.js:163132-163137
!p.hidden && p.lastVisibilityChange && p.deltaT > 1e3 &&
  (_.versioningService_.checkForPwaUpdate(null),
   _.versioningService_.checkForUpdate(null),
   _.eventService_.assertWebsocketConnection());
```

```js
// main.pretty.js:20850-20861
assertWebsocketConnection() {
  let e = Date.now();
  if (e - this.lastPingResponse_ > 3e4 && e - this.lastConnectionReset_ > 15e3)
    return this.lastConnectionReset_ = e, void this.resetWebsocket();
  this.resetWebsocketReconnectTimer();
}
```

**Close codes are never inspected.** `onclose = function () { o.onConClosed(); }` (`20005`) discards the `CloseEvent`, so a server-side 4xxx code/reason is invisible to the client and cannot be used as documentation. **bundle-proven** (and a real limitation for us: we *should* log them).

### 2.7 Batching (`t = 10001`)

```js
// main.pretty.js:20810-20831
handleText(e) {
  var t = this.decodeMessage("EventWrapper", e);
  const r = t.t;
  if (0 === r)          this.handleErrorEvent(this.decodeMessage("ErrorEvent", t.d));
  else if (1 === r)     this.handleSessionVerifiedEvent(this.decodeMessage("SessionVerifiedEvent", t.d));
  else if (2 === r)     this.handlePingResponseEvent(this.decodeMessage("PingResponseEvent", t.d));
  else if (1e4 === r)   this.handleServiceEvent(this.decodeMessage("ServiceEvent", t.d));
  else if (10001 === r) { let l = t.d || []; for (let _ = 0; _ < l.length; ++_) this.handleText(l[_]); }
}
```

`t=10001`'s `d` is an **array of complete wrapper strings**, each fed back through `handleText` — so a batch can in principle nest, and a batch member is itself a full `{"t":…,"d":…}` document. Unknown wrapper codes are silently ignored (no `else`). **bundle-proven.**

> **One public client disagrees.** `ZerGo0/fansly.streamerbot` treats `t=10001`'s `d` as an array of the *inner* `{serviceId, event}` objects rather than of full wrappers — but it only ever talks to **chatws**, so it may be describing a different server. The bundle is authoritative for wsv3. **Build the decoder to accept both shapes** (if a member parses to an object with `serviceId`, treat it as an inner event; if it parses to an object with `t`, recurse) and log which one actually arrives — live-test G4.

### 2.8 Client-side timeouts & error handling

| Timeout | Value | Evidence |
|---|---|---|
| ping interval | 20–25 s (randomised once per EventService instance) | `20688` |
| pong deadline | 1.2 × interval = 24–30 s | `20689`, `20709` |
| reset debounce | 15 s between forced resets | `20710`, `20855` |
| visibility-triggered hard reset | pong older than 30 s | `20853` |
| `assertConnection(cb)` (used once at bootstrap) | 3 s then `cb("timeout")` | `20730-20748` |
| transport retry | 1.5 s → ×2 → 15 s cap | `19910`, `19944-19947` |
| DM "possibly duplicate" window | 180 s (see §6) | `35626-35630` |

`t=0` ErrorEvent handling is minimal and only cares about one code:

```js
// main.pretty.js:20779-20784
handleErrorEvent(e) {
  401 === e.code && (this.activeSession_ = null,
                     this.sessionService_.logout(),
                     this.setConnectionState(o.CONNECTION_STATES.DISCONNECTED));
}
```

So the only documented WS error semantic is **`{"code":401}` ⇒ the token is dead ⇒ log out**. Any other `code` is swallowed. **bundle-proven.** The full error-code space on this socket is **unknown**; note that REST error codes follow the pattern `1000*serviceId + n` (e.g. `1000*WalletService+101 = 6101` = "payment method required", `22756`), and the chat socket uses the same convention for *request* types (`46001 = 1000*46+1`, `254183`), so WS error codes plausibly share it — **inferred, not proven**.

---

## 3. Outbound messages — the complete list

I enumerated every call site of `sendText` / `sendBytes` / `writeText` / `writeBytes` / `wrapRequest` in the 304 272-line bundle. Excluding `navigator.clipboard.writeText`, the complete set is:

| # | Frame | Where | Socket | Confidence |
|---|---|---|---|---|
| 1 | `{"t":1,"d":"{\"token\":…,\"v\":3}"}` | `20838-20845` (called from `onConnect`, `20770`) | wsv3 | bundle-proven |
| 2 | `p` | `20712` | wsv3 | bundle-proven |
| 3 | `{"t":1,"d":"{\"token\":…,\"v\":3}"}` | `254164-254171` | **chatws** | bundle-proven |
| 4 | `{"t":46001,"d":"{\"chatRoomId\":\"…\"}"}` (`ChatRoomSubscribeRequest`, `t = 1000*ServiceIds.ChatRoomService + 1`) | `254183-254189` | **chatws** | bundle-proven |

**There is no subscribe, unsubscribe, filter, ack, resume, cursor, presence or typing frame on wsv3.** Everything the client *writes* goes over REST:

- typing indicator → `POST /api/v1/message/typing` (`34701`), and comes **back** to other participants as a WS `MessageService` type 22;
- read/delivered receipts → `POST /api/v1/message/ack` in chunks of 25 with a 200 ms gap (`35729-35741`, `34313`), and comes back as `MessageService` type 2 / `GroupService` type 2;
- presence → `POST /api/v1/status` (`38046`);
- likes → `POST /message/like` / `/message/like/remove`;
- sending a DM → `POST /message` or `POST /message/broadcast`.

**Design consequence for the hub:** wsv3 is a pure read side-channel. It cannot be used to *do* anything, and there is no per-conversation subscription to scope down — one socket per Fansly account delivers that account's entire event stream. There is no documented way to ask for less.

---

## 4. ServiceEvent catalogue

### 4.1 Structure

`ServiceEvent` = `{ serviceId: <int>, event: "<JSON string>" }`. Every consumer does `JSON.parse(o.event)` and branches on the inner `.type`. No other field of the ServiceEvent is ever read anywhere in the bundle (checked: no `seq`, `eventId`, `ts`, `version` at the envelope level).

The service-id table (`20867-20918`) is the full 50-entry enum. The client only *subscribes* to 17 of them. Two dispatch styles coexist:

- typed consumers extending the base class `ai` (`23281-23303`), which filters `e.serviceId === this.serviceId_` — 17 subclasses, `super(j.ServiceIds.X)` at `23306, 26716, 29524, 29945, 30345, 31716, 31976, 32292, 34771, 34786, 36874, 39429, 40153, 41971, 42298, 75195, 172966`;
- inline `onServiceEvent` handlers in services/components (`24641`, `33188`, `34974`, `36154`, `36929`, `38118`, `42798`, `43229`, `43505`, `163417`, `167932`, `169081` …).

**Local (client-synthesised) events share the same bus.** `eventService_.handleServiceEvent({serviceId, event})` is called from ~30 places to fake an event after a REST call (e.g. `36129` wallets loaded → `WalletService` type 101). **Any inner `type` ≥ 100 in the table below is client-local unless marked otherwise** — do not expect it on the wire.

### 4.2 The table

`Full?` = does the frame carry the business object, or only ids.
`Client re-fetch` = what the client does over REST *because of* this event.

| Service (id) | type | Meaning | Payload key & completeness | Client re-fetch | Conf. | Evidence |
|---|---:|---|---|---|---|---|
| **PostService (1)** | 1 | post created | `post` (id + `wallIds`) — **client ignores the body** | **`GET /post?ids=<id>`** (`getPosts([t.post.id])`) | bundle-proven | `33202-33210` |
| | 8 | post updated | `post` — full post model | none | bundle-proven | `31725-31727` |
| | 9 / 10 | wall-post added / removed | `wallPost` (ids) | none | bundle-proven | `31728-31733` |
| | 101 / 102 | wall created / deleted | `wall` | none | bundle-proven | `31734-31739` |
| **MediaService (2)** | 5 | media updated (transcode/status) | `media` — full media model | none | bundle-proven | `28496-28502` |
| | 7 | **accountMedia order created (PPV media purchase)** | `order` = `{accountId (buyer), accountMediaId, correlationAccountId, …}` — ids + amounts | if buyer≠me → cache order; else flip `purchased` flag | bundle-proven | `26719-26724`, `43248-43268` |
| | 8 | media-bundle order created | `order` | same | bundle-proven | `43269-43281` |
| | 2 | (suggestions invalidation) | — | `clearSuggestionsCache()` | bundle-proven | `43249` |
| | 999 | cache clear | — (**local**) | — | bundle-proven | `26724` |
| **FollowerService (3)** | 2 | **follow created** | `follow` = `{id, accountId, followerId, accountSortOrder}` — ids only | reloads home timeline if empty; clears suggestion cache | bundle-proven | `172972-172979`, `33190-33200`, `43282-43350` |
| | 3 | **unfollow** | `follow` (ids, `createdAt` = date of the *original* follow per vendor) | none | bundle-proven | `172976-172979`, `43355-43420` |
| **GroupService (4)** | 2 | ack command (single) | `ackCommand` = `{type, userId, messageIds[]}` | none | bundle-proven | `34988-34991` |
| | 4 | group user settings | `userSettings` | none | bundle-proven | `34986-34987` |
| | 6 | user added to conversation | `groupUser` = `{groupId, userId, …}` | **`GET /group/{groupId}`** if the group is unknown | bundle-proven | `34976-34978`, `35782-35792` |
| | 7 | user removed | `groupUser` | none (removes locally; if it's me → drop the group) | bundle-proven | `34979-34980`, `35793-35800` |
| | **8** | **conversation created** | **`id` ONLY — no group object** | **always `GET /group/{id}`** | bundle-proven | `34981`, `35801-35808` |
| | 9 | conversation hidden/unhidden (`userSettings.hidden`) | `groupUserSettingsChangeEvent` = `{groupId, userId, userSettings}` | none | bundle-proven | `34982-34985`, `35809-35825` |
| **MessageService (5)** | **1** | **new DM** | **`message` — full object**: `id, groupId, correlationId, type, senderId, content, createdAt, deletedAt, inReplyTo, inReplyToRoot, inReplyToMessage, attachments[], likes[], totalTipAmount, embeds[], interactions[]` | **attachments are id-refs `{messageId, pos, contentType, contentId}`** → media/tip/story objects resolved from cache or `GET /account/media?ids=`, `/account/media/bundle?ids=`, `/tips?ids=`; conversation fetched if unknown | bundle-proven | `34795-34797`, `33529-33556`, `33449-33459`, `35396-35422` |
| | **2** | **read / delivered receipts** | `messageAckEvent.ackCommands[]` = `[{type, userId, messageIds[]}]`, `type` 1=delivered 2=read 3=both 4=**mark-unread** | none | bundle-proven | `35001`, `35649-35720` |
| | 3 / 4 | reaction added / removed | `like` = `{id, messageId, type, …}` | none | bundle-proven | `34798-34801`, `35003-35012` |
| | **10** | **message deleted** | `message` (at least `.id`, `.type`); if `type===3` also deletes everything with that `correlationId` | none | bundle-proven | `34996-35000` |
| | **22** | **typing announce** | `typingAnnounceEvent` = `{accountId, groupId, lastAnnounce}`; UI expires it after 3.1 s | none | bundle-proven | `34802-34803`, `157261-157268` |
| | — | **message edited** | **DOES NOT EXIST** — no edit branch anywhere | — | bundle-proven | `34793-34804`, `34992-35012` |
| **WalletService (6)** | 1 | transaction (unused branch) | `transaction` | none | bundle-proven | `36930-36932` |
| | **2** | **balance changed** | `wallet` = `{id, type (1=main,2=earnings), accountId, balance, walletVersion}` — applied only if `walletVersion >=` cached | none | bundle-proven | `36933-36949` |
| | **3** | **wallet transaction** | `transaction` — full ledger row (`type`, `amount`, `originWalletId`, correlated account …) | none | bundle-proven | `36878-36881`, `43236-43247` |
| | 101 | wallets loaded (**local**) | — | — | bundle-proven | `36960-36967` |
| **TippingService (7)** | **1** | **tip created** | `tip` = `{senderId, receiverId, amount, …}` | none; grants permissions locally | bundle-proven | `43441-43480` |
| | 101 | tip-goal update (**local**, emitted after `GET /tipgoals`) | `tipGoal` | — | bundle-proven | `29524-29531`, `29653-29662` |
| **OnlineStatusService (8)** | **1** | **someone's presence changed** | `status` = `{accountId, statusId}` — ids only, applied only if that account is already cached | none | bundle-proven | `24667-24675`, `38118-38130`, `43230-43235` |
| **NotificationService (9)** | **1** | **new notification** (the creator's money/social firehose) | `notification` = `{id, accountId, type, correlationId, correlationGroupId, createdAt, metadata (JSON string)}` — **id-refs + metadata, not the business object** | none automatically; the notification *list* is `GET /notifications?before&after&type`, counters `GET /notifications/unack` | bundle-proven | `36154-36180`, `29163-29175` |
| | 2 | acknowledged (n types) | `data.type` = comma-separated type list | none | bundle-proven | `36183-36199` |
| | 3 | notification revoked | `notification` (matched on type+accountId+correlationId+correlationGroupId) | none | bundle-proven | `36203-36204`, `36101-36152` |
| | 100/101/102 | list/counter/unack refresh (**local**) | — | — | bundle-proven | `30351-30361`, `35942-35947` |
| **ProfileService (10)** | 2 / 100 | post pinned | `pinnedPost` | none | bundle-proven | `41976-41981` |
| | 101 | post unpinned | `pinnedPost` | none | bundle-proven | `41982-41983` |
| | 102 | pinned posts changed | `pinnedPosts` | none | bundle-proven | `41984-41986` |
| **IgnoreService (11)** | 1 | block/mute changed | `data` = `{accountId, ignoredId, ignoreFlags}` | none | bundle-proven | `24688-24697` |
| **AccountService (12)** | 2 | **account updated** | `account` — **client only applies `displayName` and `flags`** | none | bundle-proven | `24677-24687` |
| | 100/101/999 | accounts changed / suggestions refetch / cache clear (**local**) | `accounts` | — | bundle-proven | `23305-23320`, `24655-24661` |
| **ChatBotService (13)** | — | subscribed but `handleServiceEvent(e) {}` is **empty** | — | — | bundle-proven | `143277-143281` |
| **OrderService (14)** | — | **NO consumer anywhere in the client** | — | — | bundle-proven | grep: `ServiceIds.OrderService` only appears in the enum + DI name |
| **SubscriptionService (15)** | **5** | **subscription created / changed / cancelled** | `subscription` — full object incl. `status, price, renewPrice, subscriptionTierId, subscriptionTierName, version, createdAt, updatedAt`; applied only if `version >=` cached | none | bundle-proven | `29951-29954`, `30042-30076`, `24700-24720` |
| | 100 | subscriptions fetched (**local**) | `queryResult` | — | bundle-proven | `29955-29957` |
| | 101 | gift code added | `giftCode` | none | bundle-proven | `29958-29959` |
| | 102 | normalised sub update (**local**, re-emitted from type 5) | `subscription` | — | bundle-proven | `29960-29963`, `30060-30071` |
| **PaymentService (16)** | 1 / 2 / 3 | payment transaction created / updated / create-error | `transaction` | none | bundle-proven | `39437-39449` |
| | 10 / 11 | payment method created / updated (incl. delete via `deletedAt`) | `wallet` | none | bundle-proven | `39450-39455`, `42800-42817` |
| | 20 / 21 | **payout request created / updated** | `payoutRequest` | none | bundle-proven | `39456-39461` |
| **CCBillService (17)** | 2 | CCBill transaction update | `transaction` | none | bundle-proven | `75197-75203`, `75258-75268` |
| **InovioService (26)** | 3 | 3-D Secure challenge required | `request` | opens the 3DS modal | bundle-proven | `40151-40160` |
| **StoryService (32)** | 7 | **story / locked-text order created** | `order` | caches order | bundle-proven | `31975-31984`, `43481-43497` |
| | 8 | bundle order | `order` | flips `purchased` | bundle-proven | `43488-43497` |
| **PollsService (42)** | 10 / 20 / 21 / 50 | vote / subscribe / unsubscribe / poll counts | `pollVote`, `pollSubscription`, `polls[]` | none | bundle-proven | `32291-32309`, `32324-32350` |
| **ContentDiscoveryService (44)** | any | **parsed and discarded** (`JSON.parse(e.event)` with no use) | — | — | bundle-proven | `167944-167946`, `169093-169095` |
| **StreamingService (45)** | 10 / 11 | stream updated / permissions updated | `stream` | none | bundle-proven | `42296-42309` |
| **ChatRoomService (46)** | 4, 10, 20, 30, 50, 51, 53, 54 | chat-room updated / message / ban / goal add / goal update / sub-alert / settings | see §9 (chatws only) | **not on wsv3** | bundle-proven | `254176-254306` |
| **INTERNAL (1000)** | 100 | local user-activity beat (**local**) | — | — | bundle-proven | `38493-38502`, `38119-38121` |
| | 1001 / 1002 | notification types "copy media / copy bundle" (arrive as NotificationService type 1 with `notification.type = 1000*1000+1/2`) | `correlationId` | `mediaService_.copyAccountMedia(correlationId)` | bundle-proven | `36158-36164` |

### 4.3 Notification `type` codes (the real money feed)

`NotificationService` type 1 carries `notification.type`, decoded by the renderer/filter table (`CODE-TABLES.md:317-342`, source `main.pretty.js:192151-192336`):

| Code | Meaning |
|---:|---|
| 1002 | post like |
| 1003 | (tab group only, unlabeled) |
| 1004 | post reply |
| 1005 | post quote |
| 2002 | account-media like |
| 2007 / 2008 | **account-media / media-bundle purchase** |
| 3002 / 3003 | new follower (which correlation field holds the follower id differs) |
| 5003 | message like |
| **7001** | **tip received** |
| 15006 / 15016 | subscription renew / subscription-history renew |
| 15007 | subscription expired |
| 15011 | plan promotion started |
| 32007 | locked-text purchase |
| 45012 | stream-ticket purchase |
| 24001–24999 | Fansly/admin alerts (metadata `reason` strings incl. the consent family) |

### 4.4 What is **NOT** delivered by events (must stay REST)

Bundle-proven absences — i.e. no branch exists in the client, so either the event does not exist or the client ignores it:

1. **Message edits.** No event type for it.
2. **Unread counters.** No event carries a count; the client recomputes locally from ack events, and re-derives from `GET /message/unread` only on login and on tab-visible-after-30 s (`34883-34896`, `35182-35244`).
3. **Conversation list / ordering / `lastMessage`.** No event. `GET /messaging/groups?flags&limit&offset&sortOrder` on load (HAR-observed) and `GET /group/{id}` per new group.
4. **Media/attachment bodies, prices, preview URLs, and `permissionFlags`.** Events carry `contentId` only.
5. **Fan profile data** (username, avatar, bio, tier, spend). Presence event gives `{accountId, statusId}`; account update gives only `displayName`+`flags`.
6. **Post comment bodies.** `posts.commented` is a NotificationService id-ref (vendor confirms they REST-fetch it themselves).
7. **Earnings aggregates / statistics / payout balances.** `WalletService` type 2 gives a balance snapshot; everything else (`/account/wallets/earnings/*`, `/payments/payout/*`, `/message/broadcast/stats`) is REST-only.
8. **Vault / lists / notes / settings / management-session / timeline-stats.** Service ids 38, 30, 34, 31, 39, 36 exist in the enum with **zero consumers**.
9. **Order lifecycle.** `OrderService=14` has no consumer; only the terminal "order created" surfaces via MediaService 7/8 and StoryService 7/8.
10. **Subscription *plan/tier* definitions and promos.** Only the subscription row itself arrives.
11. **Anything about *other* creators' accounts you do not already have cached** — most handlers no-op when `getAccountFromCache(id)` is null.

---

## 5. Presence — does holding the socket mark you online?

**No. Presence is REST, activity-gated, and completely decoupled from the WebSocket.** This is the cleanest result in the report.

```js
// main.pretty.js:38076-38105
(this.statusHash_ = {}),
(this.lastActivityEvent_ = 0),
(this.activityTimeout_ = 3e5),                                   // 5 minutes
(this.announceInterval_ = re.randomIntFromInterval(9e4, 12e4)),  // 90–120 s
(this.localOnlineStatusId_ = 1);
…
announceOnlineStatus() {
  Date.now() - this.lastActivityEvent_ > this.activityTimeout_ ||
    (1 === this.localOnlineStatusId_ && this.setStatus(this.localOnlineStatusId_, function () {}));
}
startOnlineStatusAnnounceInterval() {
  setInterval(() => this.announceOnlineStatus(), this.announceInterval_);
  setTimeout(() => this.announceOnlineStatus(), re.randomIntFromInterval(5e3, 2e4));  // 5–20 s after login
}
```

- `setStatus(id)` → `POST https://apiv3.fansly.com/api/v1/status {statusId}` (`38046-38058`). `GET /account/{id}/status` reads someone else's (`38030-38036`).
- `lastActivityEvent_` is bumped **only** by real UI events: `click`, `keydown`, `touchstart`, `touchmove`, and tab-becomes-visible (`38801-38855`, `38493-38502`). It is **never** bumped by socket traffic.
- `startOnlineStatusAnnounceInterval()` is called exactly once, from the post-login `verifyAuth` path (`38949`), independent of the socket.
- The WS only *reads* presence back: `OnlineStatusService` type 1 → `setLocalStatusId(statusId, false)` when it's your own account (note the `false` = "don't POST back", `43230-43235`), or updates a cached fan (`24667-24675`, `38122-38130`).

**HAR corroboration:** `POST /api/v1/status` at **+5.9 s** and **+112.7 s** relative to the WS handshake in `fansly-app-bundle-2026-08-20.har` — matching the 5–20 s initial delay and the 90–120 s interval, and with no `/status` call tied to the 17 reconnects in the UI-walk HAR.

**Conclusion for the hub:** a server-side consumer that opens wsv3, verifies, pings, and never calls `POST /status` should leave the creator's online badge untouched. Corollary risk: **if we also want the creator to appear online, we would have to POST `/status` ourselves — and if we do it unconditionally we would show the model as permanently online**, which is a behavioural change fans can see. Keep them separate.

Cross-check: OnlyFansAPI states three times that *fan* presence is not exposed on Fansly at all and recommends polling `lastSeenAt` (vendor-doc, §7). That is consistent with what we see — `OnlineStatusService` type 1 only updates accounts already in the client's cache, so it is plausibly scoped to a small set (own account + open conversations), not a global fan-presence firehose. **Which accounts service 8 actually covers is unknown** and is a live-test item.

**What a live test must check** (see §9 items P1–P4): whether opening a second wsv3 from a server changes the creator's `statusId` as seen from a *fan* account; whether `statusId` decays server-side without `/status`; the meaning of `statusId` values (only `1` is ever written by the client); and whether service 8 delivers events for fans the socket-holder has never fetched.

---

## 6. Gaps, ordering and reconnect semantics

### 6.1 What the protocol gives us

| Property | Present? | Evidence |
|---|---|---|
| Envelope sequence number | **No** | `handleText` reads only `t` and `d` (`20810-20831`); no `seq`/`eventId` anywhere in the bundle |
| Per-event id | Only the *business* object's own id (message id, notification id, …) | `33530`, `29166` |
| Timestamp | Only inside the business object (`createdAt`), **units are inconsistent** — DM `createdAt` is seconds (`35626` multiplies by 1000), notification `createdAt` is seconds (`29171`), wallet/subscription timestamps are ms | bundle-proven |
| Monotonic version field | Only on some objects: `wallet.walletVersion` (`36938`), `subscription.version` (`30046`), `stream.version` | bundle-proven |
| Server-side replay / backlog on reconnect | **No API, no request, no cursor** | bundle-proven (§3) |
| Duplicate suppression | Application-level only | see below |

### 6.2 The client's own dedup / staleness rules

```js
// main.pretty.js:35622-35632
onMessagesEvent(e) {
  const t = this.sessionService_.getSessionAccountId();
  let l = Date.now();
  for (let _ = 0; _ < e.length; ++_) {
    let p = e[_];
    if (p.createdAt && l - 1e3 * p.createdAt > 18e4) {   // 180 000 ms
      console.log("discarding possibly duplicate message");
      continue;
    }
    …
```

**This is the single most informative line in the bundle about server behaviour.** The client actively guards against receiving DMs older than **3 minutes** and labels them "possibly duplicate". That is only worth writing if the server *does* re-deliver recent messages — most plausibly a short re-send window after (re)verification. It also means the client **deliberately drops any message older than 180 s**, so if we mimic the client we would lose real messages after a >3 min outage. **Whether the server actually replays, and over what window, is unknown** (live-test item G1).

Other dedup: messages by `id` in `messageHash` (`35414-35422`), likes by `id` (`33505`), notifications by `id` (`36101`), wallet by `walletVersion >=` (`36938`), subscription by `version >=` (`30046`).

### 6.3 The official catch-up recipe

**(a) On `SessionVerified` (i.e. every reconnect):** exactly one thing happens.

```js
// main.pretty.js:35018-35023
onEventSessionVerified() {
  for (let e = 0; e < this.groups.length; ++e) this.groups[e].messagesFetchedTimestamp = 0;
  this.activeGroup && this.fetchGroupMessages(this.activeGroup.id);
}
```

Only the **currently open** conversation is re-fetched (`GET /message?groupId=&limit=25`). Every other conversation is merely *invalidated* (fetched lazily when opened). **No unread re-scan, no notification re-scan, no wallet re-read.** `GroupService` is the **only** subscriber to `onSessionVerified` in the entire bundle (grep: `20806`, `34853`).

**(b) On tab-visible after >30 s hidden:**

```js
// main.pretty.js:34883-34896  (GroupService)
onVisibilityChangeEvent(e) {
  if (!e.hidden && e.lastVisibilityChange && e.deltaT > 3e4 && sessionService_.getActiveSession()) {
    t.lastUnreadFetch_ = Date.now();
    t.getUnreadInChunks();                                   // GET /message/unread, 100 at a time, ≤500
    for (…) t.groups[_].messagesFetchedTimestamp = 0;
    t.activeGroup && t.fetchGroupMessages(t.activeGroup.id);
  }
}
```

```js
// main.pretty.js:163138-163145  (app shell)
!p.hidden && p.lastVisibilityChange && p.deltaT > 3e4 && session &&
  (_.notificationService_.checkNotifications(),                 // GET /notifications/unack, ≥60 s apart
   _.walletService_.loadWallets(h.accountId, …));               // GET /account/{id}/wallets
```

**(c) On login / bootstrap** — HAR-observed, `fansly-app-bundle-2026-08-20.har`, relative to the WS handshake:

```
 -1.4  GET  /api/v1/versioning
 -0.8  GET  /api/v1/account/me
 -0.0  GET  /api/v1/message/unread?before&limit&offset
 -0.0  GET  /api/v1/account/{id}/wallets
 -0.0  GET  /api/v1/settings?categoryIds
 +0.8  GET  /api/v1/message/unread?before&limit&offset
 +1.5  GET  /api/v1/notifications/unack
 +1.5  GET  /api/v1/subscriptions
 +1.5  GET  /api/v1/orders/products
 +1.5  GET  /api/v1/payments/wallets
 +1.5  GET  /api/v1/messaging/groups?flags&limit&offset&sortOrder
 +2.0  GET  /api/v1/account?ids=
 +5.9  POST /api/v1/status
+112.7 POST /api/v1/status
```

**So the honest reading is: Fansly's own client has no gap-recovery story worth copying.** It re-reads unread + counters only when a human comes back to the tab. Any server-side consumer we build must own its own catch-up — a periodic REST reconciliation (`/message/unread`, `/notifications`, `/messaging/groups`, wallets) is not optional, it is the *only* correctness mechanism available.

### 6.4 Observed connection stability

`fansly-ui-walk-2026-08-21.har` — 84 minutes, **one** HTML document load, **17** wsv3 handshakes, all `101`:

```
18:01:27  18:14:39 (+792s)  18:40:49 (+1570s)  18:47:18 (+372s)  18:47:48 (+30s)
18:50:49 (+182s)  18:51:46 (+56s)  18:52:39 (+54s)  18:54:50 (+131s)  18:57:31 (+160s)
19:00:16 (+165s)  19:06:21 (+366s)  19:09:55 (+214s)  19:10:51 (+56s)  19:12:41 (+35s)
19:20:58 (+497s)  19:25:26 (+268s)
```

16 of the 17 have **no REST burst afterwards** (only the last one, which follows the page load, does). Gaps of 30–56 s are exactly the shape of the client's own 24–30 s pong deadline plus the 15 s reset debounce. Median lifetime ≈ 2.7 min. **HAR-observed, cause unknown**: could be the server closing idle/aged connections, could be the capture environment (Firefox devtools + a proxy), could be the client's ping timeout firing on a throttled background tab. **This is live-test item T1 and it materially affects the design** — if a connection genuinely lives ~3 minutes, a reconnect-storm-safe consumer with REST reconciliation is mandatory, not nice-to-have.

---

## 7. Vendor cross-check — OnlyFansAPI's Fansly webhook relay

Source: `https://docs.onlyfansapi.com/webhooks/fansly-events`, `…/webhooks/delivery-and-retries`, `…/faq`, `…/introduction/essentials/{credits,rate-limits,proxies}`. **vendor-doc** throughout.

The vendor confirms the architecture in exactly one sentence: *"Delivery is driven by our Fansly websocket relay rather than polling, so events arrive in near real-time."* The word "websocket" appears **3 times in their entire documentation**; there is no page about the Fansly socket, its URL, protocol, handshake, keep-alive, reconnect, connection count, or presence side-effects. Everything below is inferred from their event catalogue, not from a protocol description.

### 7.1 Their 38 `fansly.*` events mapped to our service ids

| Vendor event | Our service / type | Payload completeness per vendor |
|---|---|---|
| `messages.received` | MessageService 5 / 1 | full message **+ vendor-added `senderData{available,…}`** — they REST-enrich the sender |
| `messages.sent` | MessageService 5 / 1 (own) | full, **no** `senderData` |
| `messages.deleted` | MessageService 5 / 10 | vendor sends the **last known body** (we only get `.id`) |
| `messages.read` | MessageService 5 / 2 (ack type 2) | `+ recipients[]`, `userReadReceiptsEnabled` — enriched |
| `messages.reaction_added/removed` | MessageService 5 / 3, 4 | matches |
| `users.typing` | MessageService 5 / 22 | matches; **"high volume, debounce on your side"** |
| `chats.visibility_updated` | GroupService 4 / 9 | matches; **"high volume"** |
| `posts.created/.updated/.deleted/.pinned/.expired` | PostService 1 / 1, 8, 9-10, ProfileService 10 / 2 | **"Fansly emits a separate frame for every wall a post lands on. We collapse them"** — i.e. **we will see N duplicate frames per post**; re-adding to a wall >24 h later re-delivers |
| `posts.commented` | NotificationService 9, `notification.type = 1004` | **"the notification behind this event carries only IDs — so we fetch the comment and its author for you… always branch on `available`"** — confirms our §4.4 item 6 |
| `posts.liked` | NotificationService 9, type 1002 | **ids only, not enriched** |
| `media.liked` | NotificationService 9, type 2002 | ids only; `metadata` left as a JSON string; **"high volume"** |
| `media.purchased` | MediaService 2 / 7 (+ notification 2007/2008) | **"bundles fire one event per item"** |
| `stories.purchased` | StoryService 32 / 7 | keyed on `transactionId`, no `orderId` |
| `subscriptions.new` | SubscriptionService 15 / 5 | full object; **"This changed in August 2026"** — it used to fire for renewals too; first sub ⇔ `subscriptionStreak==0 && subscriptionTotalDays==0` |
| `subscriptions.renewed` | SubscriptionService 15 / 5 | **"Fansly marks the subscription expired for a moment before the renewal lands. We don't deliver that intermediate state."** ⇒ **we will see a spurious expired→active flap on every rebill** |
| `subscriptions.expired` | NotificationService 9, type 15007 | ids only |
| `followers.new/.removed` | FollowerService 3 / 2, 3 | `removed.createdAt` is the **original follow date** |
| `fans.ignore_updated` | IgnoreService 11 / 1 | `state:"none"` cannot distinguish unblock from unmute |
| `wallets.updated` | WalletService 6 / 2 | **"high volume"**; `balance` and `balance64` **"do not always agree"**; order on `walletVersion` |
| `transactions.new` | WalletService 6 / 3 | full ledger row; payouts deliberately excluded |
| `tips.received` | TippingService 7 / 1 (+ notification 7001) | **deliberately double-delivered** with `transactions.new` |
| `payouts.created/.updated` | PaymentService 16 / 20, 21 | order on `version` |
| `payouts.debited` | NotificationService 9, type 16012 | kept out of `transactions.new` on purpose |
| `profiles.updated` | ProfileService 10 (not in our type list) | `avatarId`/`bannerId` are media ids, need a lookup |
| `streams.updated` | StreamingService 45 / 10, 11 | **"`status` is forwarded raw… treat as opaque"**; they collapse 10 and 11 into one |
| `accounts.updated` | AccountService 12 / 2 | vendor forwards `flags`, `version`, `modelFlagChange` — **more than our client applies** (client keeps only `displayName`+`flags`) |
| `accounts.alert` | NotificationService 9, type 24001 | vendor decodes `metadata` when parseable |
| `accounts.connected/.disconnected/.authentication_failed/.otp_code_required` | **not Fansly frames** — OFAPI's own session lifecycle | — |

**Our services with no vendor counterpart:** `OnlineStatusService (8)` and `ManagementService (39)`; also `PollsService (42)`, `InovioService (26)`, `CCBillService (17)`, `ChatBotService (13)`, `ContentDiscoveryService (44)`.
**Vendor events we cannot pin to a service id:** `profiles.updated`, `payouts.created/.updated` (probably PaymentService 16 / 20-21), `stories.purchased`, and all four `accounts.*` lifecycle events.

### 7.2 Money units — a free confirmation

The vendor states *"Money is in thousandths of a dollar"* (`15000` = $15.00). **That is exactly our mills unit** (1 mill = $0.001). Fansly amounts land in our ledger with no conversion. Timestamps, however, are *"Unix epoch, in seconds **or** milliseconds depending on the upstream field"* — and this matches the bundle (DM `createdAt` × 1000 at `35626`; notification `createdAt` × 1000 at `29171`; wallet/subscription values already ms). **Per-field unit pinning is mandatory.**

### 7.3 What they say about gaps, ordering, limits

- **"We guarantee at-least-once delivery, not exactly-once."** Dedup on `X-OFAPI-Idempotency-Key`.
- **"Events are also not ordered… sort on the timestamps inside the payload rather than on arrival order."**
- Retries: **3 attempts** (immediate, ~10 s, ~100 s) then abandoned; 5 s connect / 10 s total budget; 404/410 stops retries immediately.
- Circuit breaker after **20 consecutive failures**; **"Events fired while an endpoint is paused are lost… not available for redelivery… Backfill that window from the API instead."**
- Delivery log pruned after **7 days**.
- Rate limit is **per team**, fixed 60 s window: Free 60 / Basic 1 000 / Pro 5 000 rpm. Webhooks cost **1 credit per 100 events**; API calls 1 credit each, **charged even on upstream errors**.
- **Nothing** is documented about the relay's own reconnect, gap detection, sequence numbers, connections-per-account, Fansly proxy/egress, or a latency SLA.

**Reading for us:** the vendor's contract is strictly weaker than what the raw socket gives (at-least-once, unordered, 2-minute retry budget, silent loss during a pause, 7-day log). Going direct to wsv3 buys ordering-as-received and no third-party pause window — at the cost of owning reconnect, presence isolation, and reconciliation ourselves. Their "high volume" flags (`wallets.updated`, `chats.visibility_updated`, `media.liked`, `users.typing`) are a useful advance warning about which streams will dominate our `observations` table.

---

## 8. Public-repo findings

All **public-repo** unless noted. No Fansly host was contacted for any of this.

### 8.1 Headline

**There is no public implementation of the wsv3 *event stream*.** Every public project that touches `wsv3.fansly.com` opens it, sends one auth frame, reads one reply to harvest a session id, and closes immediately. All real event-loop code in the wild targets the *other* socket — `chatws.fansly.com` (live-stream chat) — which shares the identical envelope, so those clients are still the best public reference for framing and keep-alive.

**We would be the only known non-browser consumer of wsv3's event stream.** There is no community knowledge about bans, connection caps, idle disconnects or replay on this socket — nothing on Reddit, StackOverflow, or any blog. That absence is itself load-bearing: it means every risk item in §11 has to be settled by our own live test, not by prior art.

### 8.2 wsv3 clients (session-id bootstrap only)

| Project | Lang / activity | URL, params, headers | Auth frame (tokens redacted) | Keep-alive | Events |
|---|---|---|---|---|---|
| `prof79/fansly-downloader-ng` (452★, last push 2024-07-05) | Python, `websockets` | `wss://fansly-downloader-ng uses wsv3.fansly.com` — **no query string, no `?v=3`**; `origin=https://fansly.com`, custom UA; `extra_headers` commented out; **`ssl.CERT_NONE`, `check_hostname=False`** (`# TODO: Security`) | `{"t":1,"d":"{\"token\":\"…\"}"}` — **no `"v":3`**, hand-built string | **none** — the `send('p')` line is commented out; socket closed after one reply | none. `t=0` ⇒ raise; otherwise `d.session.id` → stored as the `fansly-session-id` REST header. Comment: *"Preflight auth — necessary for WebSocket request to succeed"* (a REST call precedes the socket) |
| `agnosto/fansly-scraper` `headers.go:GetSessionID` (142★, last push 2026-08-13) | Go, gorilla | `websocket.DefaultDialer.Dial("wss://wsv3.fansly.com/", **nil**)` — **no Origin, no User-Agent, and it works** | `{"t":1,"d":"{\"token\":\"…\"}"}` | none, `defer c.Close()` | none; `d.session.id` only |
| `Sl0thC0der/container-fansly-downloader` (3★) | Python | byte-identical derivative of prof79 | — | — | — |
| `UltimaHoarder/UltimaScraperAPI` (94★, last push 2026-08-31) | Python | declares `ws_url = "wss://wsv3.fansly.com/?v=3"` and `ws_auth_token` on the Fansly user model, **never implements them**; their own docs: *"WebSocket ❌ Planned"* | — | — | — |

Three things this gives us:

1. **`SessionVerifiedEvent`'s payload shape is `{"session":{"id":"…"}}`** — the official client never reads it (`20785-20789` discards the argument), so this is the only source for it. Note the web client does **not** need the socket for `fansly-session-id`: its session object already has `{id, accountId, deviceId, token, metadata}` from `POST /login` (`13008-13018`), and the header interceptor reads `session.id` directly (`36366-36371`). The public tools use the socket only because they scrape the token out of a browser without the surrounding session record.
2. **`Origin` is apparently not enforced on wsv3** — the Go client dials with `nil` headers. Downgrades live-test item T5 from unknown to *probably-not-gated*, but this is one library on one day; still worth confirming from our egress.
3. **`?v=3` and the inner `"v":3` look redundant.** Public clients variously send neither, one, or the other, and all of them get a successful verify. `agnosto/fansly-scraper`'s chat client additionally accepts **`t=1` *or* `t=2`** as a successful auth reply, which hints the server may answer verify with a PingResponse-shaped frame in some paths.
4. **`wsAuthToken`** — a field on the Fansly *account* object that `UltimaScraperAPI` carries but nothing uses. **It does not appear anywhere in our captured bundle** (grep: zero hits). Unknown what it is for; worth a look if we ever want a socket credential separate from the full session token.

### 8.3 chatws clients (full event loops — reference implementations for the envelope)

| Project | Lang | Auth | Join | Keep-alive | Notes |
|---|---|---|---|---|---|
| `ZerGo0/fansly.streamerbot` (7★, MIT, 2026-06-14) — **and a written protocol doc** at `docs/protocol.md` | C# / Streamer.bot | **none at all** | `{"t":46001,"d":"{\"chatRoomId\":\"…\"}"}` | raw text `p` every **10 s**, unbounded, no pong check | Handles `t=10001` as a **JSON array of the same inner objects as `t=10000`** — the only public confirmation of our §2.7 reading. Constants `EVENT_TYPE_CHAT=10`, `EVENT_TYPE_SUBSCRIPTION=53`, `ATTACHMENT_TYPE_TIP=7`. Their troubleshooting doc: the fix for "no events" is always disconnect→reconnect and re-send the join ⇒ **the server keeps no room membership across reconnects**. Recommends using a **Fansly Management Session** token rather than the creator's real session, explicitly as a takeover-risk mitigation. |
| `agnosto/fansly-scraper` `service/chat_recorder.go` (779 lines) | Go | `{"t":1,"d":"{\"token\":\"…\",\"v\":3}"}`; **`t!=1 && t!=2` ⇒ auth failed** | `t=46001` | `{"t":0,"d":"p"}` every **30 s** (JSON-wrapped variant) **plus** an RFC 6455 `SetPingHandler` | 45 s read deadline; timeouts swallowed, everything else ⇒ reconnect after 5 s, infinite; `maxRetries: 5` declared but never enforced |
| `Nyoob/TipsySync` (2★, 2025-11-13) | Go | **none** — goes straight to join | `{"t":46001,"d":"{\"chatRoomId\":\"…\",\"v\":3}"}` | raw text `p` every **22 s** | Divides tip `metadata.amount` by **1000** to get dollars — independent confirmation of the mills unit. `t=10001` left as `// TODO handle bulk events`. |
| `openglfreak/twitch-stuff/fansly_chat_client` | Python | `{'t':1,'d':json.dumps({'token':…, 'v':3})}` | `t=46001` | **no app-level `p` at all** — relies on RFC 6455 `ping_interval=20` | Counter-evidence that the transport-level ping alone holds the socket |
| `h3llo-wor1d/openFansly` (6★, 2023-03-07) | Python | `{"t":1,"d":"{\"token\":\"…\"}"}` | `t=46001` | docstring says 20 s, **nothing implemented** | Ships a captured frame from **Oct 2022** — the envelope has been stable for ≥ 4 years |

**Anonymous access:** two of the five (`TipsySync`, `ZerGo0`) send **no auth frame at all** and still receive chat/tip/subscription events after a bare `t:46001`. So *chatws* is readable anonymously. **No public project reads wsv3 anonymously** — every one sends a token, and all any of them wants is the session id.

**Keep-alive is wildly inconsistent across working clients** (raw `p` at 10/22 s, `{"t":0,"d":"p"}` at 30 s, RFC 6455 ping at 20 s, and prof79's none-at-all for a one-shot). Nobody has published an idle timeout. Our client should keep the official cadence (`p` every 20–25 s) and treat `t=2` as the pong, because that is the only combination we can point at shipped Fansly code for.

### 8.4 The bundle itself is publicly archived — take this

**`https://github.com/agnosto/fansly-data`** — a GH Actions cron that snapshots Fansly's `main.<hash>.js` **daily since 2025-05-16** (last push 2026-09-07), plus `data/metadata/latest.json` recording the app version, the `checkKeys` and the `fansly-client-*` header set.

This is a **16-month time series of the exact artifact we reverse-engineer, obtainable without touching fansly.com.** Concretely useful for: dating when a service id or an inner `type` appeared, diffing the frame shape across versions, and re-pinning our decoder after a Fansly deploy. The current head bundle was checked and still contains verbatim `wss://wsv3.fansly.com?v=3` (note: **no slash before `?`**, unlike every public client), `wss://chatws.fansly.com?v=3`, one `new WebSocket` with `binaryType='arraybuffer'` and `reconnect_timeout_=1500`, and 83 `serviceId` sites — i.e. the architecture in §2 is unchanged as of 2026-09-06.

### 8.5 Searched and found nothing (explicit absences)

| Query | Result |
|---|---|
| `"wsv3.fansly.com"` on general web search | Nothing relevant; only GitHub *code* search surfaces it |
| `SessionVerifyRequest` | ~100 hits, **none Fansly-related** (generic name in unrelated auth codebases) |
| `"ServiceEvent"` + fansly, `"MessageService"` + fansly | **Zero public hits** |
| `OnlineStatusService` / fansly presence websocket | Nothing; OnlyFansAPI states outright Fansly exposes no fan presence |
| `Avnsx/fansly-downloader` (1385★, the original) | **No websocket at all** — the wsv3 session-id trick is a `-ng` addition |
| PyPI `fansly*`, npm `fansly*` | **All 404** — no published package on either registry |
| Community wiki / OpenAPI spec / Postman collection for Fansly | **None exists.** Closest is `openFansly/frontendDocumented.json` — REST-only, 2023, 9 KB |
| `steveseguin/social_stream` (supports Fansly) | **DOM-scrapes** `fansly.com/chatroom/*`; their docs call it *"rendered page chat captures, not platform APIs"* |
| ~40 other `fansly*` GitHub repos (BetterFansly, FanslyExtension, userscripts, recorders, notifiers…) | **No websocket usage in any.** Notably `NotiFansly/BetterFansly` hooks `fetch` + `XMLHttpRequest` for ghost-mode (blocking `/message/ack`, `/mediastory/view`, `/message/typing`, `/api/v1/status`) but **does not hook `WebSocket`** |
| Reddit / StackOverflow / blogs on the Fansly WS | **Nothing** — no discussion of disconnects, caps, reconnect gaps or bans |
| WS-specific rate limits / ban reports | **None.** The only public statement is generic REST: Fansly 404s an IP for a period under too many requests (Avnsx wiki) |
| Third-party vendors other than OFAPI (`apifansly.com`, `fansly-api.com`, RapidAPI listings) | REST + outbound webhooks only; **no websocket or relay described** |

### 8.6 Where public code contradicts or extends our bundle reading

| Point | Bundle says | Public code says | Verdict |
|---|---|---|---|
| `SessionVerifiedEvent` body | never read | `{"session":{"id":"…"}}` | **complementary** — adopt it, but we don't need it (we have `session.id` from login) |
| `Origin` required? | browser always sends it | Go client dials with `nil` headers and succeeds | **probably not enforced**; confirm in T5 |
| `"v":3` required? | always sent, both in query and payload | works with neither, either, or both | **probably redundant**; keep sending both |
| Auth success frame | `t=1` only | `agnosto` accepts `t=1` **or** `t=2` | **be liberal**: accept either, don't fail closed on `t=2` |
| `t=10001` shape | array of wrapper strings, recursively re-parsed | ZerGo0 treats it as an array of the *inner* `{serviceId,event}` objects | **conflict.** The bundle (`20825-20829`) is authoritative for wsv3 — members go back through `handleText`, i.e. they are full wrappers. ZerGo0 works on chatws only. **Our decoder must handle both shapes defensively** and log which one it actually sees (live-test G4) |
| Binary path | `binaryType='arraybuffer'`, `handleBytes` empty | **no public client touches it** | still **unknown** whether the server ever sends binary; log-and-count it |

---

## 9. `chatws.fansly.com` — scoped OUT

`wss://chatws.fansly.com?v=3` is a **separate socket used only by the live-stream chat-room component** (`main.pretty.js:253422`, opened at `254155-254162`). It is **not** needed for DMs, money, notifications or anything else the hub cares about.

Distinguishing facts:

- It is created per-component (`new Q4()` directly, not through the shared `WebsocketService`) and torn down with the component.
- It uses the **same envelope and the same `SessionVerifyRequest`** with the same token (`254164-254171`), which is why it is useful evidence for §10 (multi-connection).
- Unlike wsv3, it **requires an explicit subscribe**: after `t=1` SessionVerified it sends `{"t":46001,"d":"{\"chatRoomId\":\"…\"}"}` (`254180-254190`). This proves the request-type convention `t = 1000*serviceId + opcode` and proves the server *does* implement per-topic subscription — just not on wsv3.
- It only ever handles `serviceId === ChatRoomService (46)`, inner types `4` (room updated → debounced `loadChatRoom()` after 1–3 s), `10` (chat message), `20`/`30` (ban), `50`/`51` (tip goal add/update), `53` (sub alert), `54` (room settings) (`254176-254306`).
- Anonymous use is supported the same way (no session ⇒ no verify, `254172-254175`).
- Client-side buffer: 100 messages (1000 while scroll-blocked) (`253428-253429`).

**Recommendation: ignore it** unless the hub ever needs live-stream chat capture. If it does, note it needs one socket **per chat room**, and the room list/history still comes from `GET /chatroom/messages?chatRoomId=` and `POST /chatroom/message`.

---

## 10. Multi-connection & identity

| Question | Answer | Confidence | Evidence |
|---|---|---|---|
| Does WS auth use the same bearer token as REST? | **Yes, byte-identical.** The REST interceptor sets `authorization: session.token` with no scheme prefix; the WS sends the same `session.token` in `SessionVerifyRequest`. | bundle-proven | `22703-22715`, `20770` |
| Are `fansly-client-id` / `-ts` / `-session-id` / `-check` involved in the WS? | **No.** They are injected by an HTTP interceptor gated on an allow-list of `https://api*.fansly.com/api/` bases (`38493-38524`, `36366-36391`), and the HAR shows the WS handshake carries none of them. Note `fansly-client-check` = `cyrb53(checkKey_ + "_" + pathname + "_" + deviceId).toString(16)` (`36389-36391`) — it is path-derived and meaningless for a socket. | bundle-proven + HAR-observed | `36366-36393`, `38493-38524`; HAR header set on `/api/` requests vs. WS entry 33 |
| Is a device id involved in the WS? | Only as the `f-d` / `fansly-d` **cookies** the browser attaches automatically (`38989-38994`). No frame carries it. Whether the server reads them is **unknown**. | bundle-proven (client side) | `38989-38994`, HAR entry 33 |
| Can one token hold several concurrent connections? | **Yes — the client itself does it.** Watching a live stream opens `chatws` and verifies with the *same* token while `wsv3` is open. Additionally every browser tab runs its own Angular app and its own `wsv3` (structural). There is no single-connection guard, no connection id, no "kicked" event in the client. | bundle-proven (chatws) / inferred (tabs) | `254164-254171` vs `20770` |
| Does a session support several devices? | Yes — `GET /sessions?before&limit&status`, `POST /session/close` for one or all (`ENDPOINTS.md:268-269`), plus a distinct management-session family (`/management/managementsession*`). Sessions are first-class and enumerable. | bundle-proven | `ENDPOINTS.md:253-269`, `211530-211559` |
| Does a *second wsv3* from a server displace the browser's socket? | **UNKNOWN.** Nothing in the client handles being kicked; a server-side disconnect would just look like a normal close and the client would silently reconnect in 1.5 s. If the server does enforce a cap, the symptom would be a reconnect fight between the model's browser and our consumer — invisible to both. No public source addresses it either (§8.5). **Live-test items M1/M3, highest-priority risk.** | unknown | — |
| Is there a socket-specific credential? | A field **`wsAuthToken`** exists on the Fansly account object (carried but unused by `UltimaScraperAPI`). It appears **nowhere in our captured bundle** (grep: 0 hits) and no public code uses it. Purpose unknown — but if it is a scoped socket credential it would be strictly safer than shipping a full session token to a server. Worth one probe. | public-repo + bundle-absence | §8.2 |
| Is there a lower-privilege session we could use? | Yes, plausibly: Fansly has a **management-session** family (`POST /management/managementsession`, `/claim`, `/update`, `/remove`, `GET /management/managementsessions`). `ZerGo0/fansly.streamerbot` recommends exactly this to third-party tools instead of the creator's real session, as a takeover-risk mitigation. **Whether a management-session token verifies on wsv3, and what subset of events it then receives, is unknown** — high-value probe. | bundle-proven (endpoints) + public-repo (practice) | `ENDPOINTS.md:253-257`, §8.3 |

---

## 11. UNKNOWNS — checklist for a live frame capture

Everything below is *not* answerable from the bundle or the stored HARs. Ordered by how much it changes the design. Each item is phrased so it can be ticked off with a single observation.

### Transport & stability
- **T1 — connection lifetime.** Hold one authenticated wsv3 socket for 6 h from a server (no browser open), pinging `p` every 20–25 s. Record every close: wall-clock lifetime, WS close code, close reason, whether a `t=0` preceded it. *Settles whether the 30 s–26 min churn in the UI-walk HAR is the server or the capture.*
- **T2 — is `p` actually required?** Hold a second socket that never sends `p`. Does the server close it, and after how long? Does the server send unsolicited `t=2`?
- **T3 — does the server send WS control pings?** (The client ignores them; browsers auto-pong. A non-browser client must decide whether to auto-pong.)
- **T4 — close-code vocabulary.** Collect the distinct close codes/reasons over T1. Anything in 4000–4999 is Fansly's own and worth a table.
- **T5 — handshake gating.** *Partly pre-answered:* a public Go client dials wsv3 with **no Origin, no UA, no cookies** and completes a verify (§8.2). Still confirm from our own egress with (a) no `Origin`, (b) `Origin: https://example.com`, (c) no cookies, (d) a non-browser `User-Agent`, (e) URL without `?v=3`. *Determines whether our egress needs a cookie jar and a spoofed Origin.* Run from the model's own proxy (hub egress rule), never direct-IP.
- **T6 — compression.** Server declined `permessage-deflate` in the HAR; confirm it is never negotiated, and measure raw bytes/hour on a busy creator account.

### Auth & identity
- **A1 — bad token.** Send `SessionVerifyRequest` with a garbage token. Exact frame back? (Expected `{"t":0,"d":"{\"code\":401,…}"}` — capture the real shape and the full error-code space.)
- **A2 — no verify at all.** Connect and send nothing. Does the server close after N s? Does it push anything?
- **A3 — verify twice / re-verify on a live socket.** Accepted, ignored, or fatal? *Matters if we ever rotate a token without reconnecting.*
- **A4 — `v` other than 3.** `v=2`, `v=4`, absent. *Tells us how pinned we are to the current wire format.*
- **A5 — does the socket outlive the token?** Log out via `POST /logout` from another client while a wsv3 socket is open; does the socket get a `t=0` 401, or does it keep delivering?
- **A6 — management session on wsv3.** Create a management session (`POST /management/managementsession` + `/claim`) and verify with *that* token. Does it work? Which services still arrive? *If it works, we never have to hold the model's full session token on our servers — this is the single biggest security win available and it is cheap to test.*
- **A7 — `wsAuthToken`.** Fetch the account object and check whether a `wsAuthToken` field is populated; if so, try it as the `token` in `SessionVerifyRequest`. (Field exists per `UltimaScraperAPI`, absent from our bundle, unused by all public code.)
- **A8 — is the auth reply always `t=1`?** Record whether `t=2` is ever the first frame back (one public client treats it as success).

### Multi-connection (highest risk)
- **M1 — connection cap per token.** Open 2, then 5, then 10 sockets with the same token. Do old ones get closed? Is there a `t=0` code for it? *If a cap exists, our consumer and the model's browser will fight and neither will notice.*
- **M2 — connection cap per account across tokens.** Same as M1 but with two distinct sessions of the same account.
- **M3 — fan-out semantics.** With two sockets on one token, is each event delivered to **both** (fan-out) or to **one** (load-balanced)? *If load-balanced, running our consumer would silently break the model's own web client.* This is the single most important question in the list.
- **M4 — does the *browser* notice?** With our consumer running, does the model's UI still receive DMs in real time? Watch for delivery gaps in the browser.

### Presence
- **P1 — does the socket change presence?** From a fan account, watch the creator's online badge / `GET /account/{id}/status` while: (a) nothing running, (b) our socket connected but no `/status` POSTed. Any change ⇒ the socket has a presence side effect.
- **P2 — presence decay.** After the model closes the browser, how long until `statusId` flips? *Gives the server-side TTL of the `/status` heartbeat.*
- **P3 — `statusId` value space.** The client only ever writes `1`. Enumerate what values appear in `OnlineStatusService` type 1 frames and in `GET /account/{id}/status`.
- **P4 — service 8 scope.** Does the socket receive presence for fans the socket-holder has never fetched, or only for accounts in some server-side "interest set"? *Determines whether service 8 is usable as a fan-online signal at all — the vendor says Fansly has no fan presence.*

### Gaps, replay, ordering
- **G1 — replay window.** Send a DM to the creator while our socket is **disconnected**. Reconnect after 30 s / 3 min / 10 min / 1 h. Does the message arrive on the new socket? *The `18e4` "possibly duplicate" guard (`35626`) strongly implies a replay window exists; measure it.*
- **G2 — duplicate delivery.** Over T1, count `message.id` values seen more than once, and note whether duplicates come with the original `createdAt`.
- **G3 — ordering.** Send N messages rapidly; are they delivered in `createdAt` order? Are receipts (type 2) ever delivered before the message (type 1) they refer to?
- **G4 — `t=10001` in the wild.** Does the server actually batch? Capture one. How many members, and are members ever themselves batches?
- **G5 — per-wall duplicates.** Post to a creator with multiple walls; confirm the vendor's claim that PostService type 1 fires once **per wall** (⇒ we must dedup by `post.id`, not by frame).
- **G6 — subscription rebill flap.** Observe a real renewal: does SubscriptionService type 5 deliver a transient `status=expired` before the active one, as the vendor says? *If yes, our projections must debounce it.*
- **G7 — unread truth.** After a 1 h outage, compare event-derived unread counts against `GET /message/unread`. Quantify the drift ⇒ sets the reconciliation interval.

### Payload completeness (cheap to settle, high design value)
- **C1 — PPV DM.** Capture a MessageService type 1 for a message with a paid attachment. Confirm `attachments[]` is `{messageId,pos,contentType,contentId}` only, and record exactly which REST call is needed to price/unlock it.
- **C2 — new conversation.** Confirm GroupService type 8 really carries only `id` (and therefore always costs a `GET /group/{id}`).
- **C3 — tip.** Capture TippingService type 1 and the paired NotificationService type 7001 and WalletService type 3 for the same tip. *Establishes the dedup key across the three representations of one payment.*
- **C4 — notification metadata.** Capture NotificationService type 1 for types 2007, 7001, 15006, 15007, 24001 and record the `metadata` string schema per type.
- **C5 — broadcast/mass DM.** Does a broadcast produce one frame per recipient conversation, or one aggregate? *Volume-critical for a creator with 50k fans.*
- **C6 — volume baseline.** Over 24 h on a real creator account, count frames per `serviceId`/`type`. The vendor flags `wallets.updated`, `chats.visibility_updated`, `media.liked`, `users.typing` as high volume — get our own numbers before sizing `observations`.

### Safety
- **S1 — ban/rate-limit surface.** Any evidence the server rate-limits or flags a non-browser socket: unusual close codes, `t=0` codes other than 401, degraded delivery. Run first on a low-value test account, through that page's own proxy — a direct-IP connection risks a model ban (hub egress rule).
- **S2 — reconnect storm.** Deliberately reconnect 20 times in 60 s. Is there a lockout? *Bounds our own backoff policy.*

---

## Appendix A — quick evidence index

| Topic | `main.pretty.js` lines |
|---|---|
| Raw WebSocket client `Q4` (reconnect, ping text, binaryType) | 19904–20012 |
| `WebsocketService` (`bJ`), uri constant | 20014–20081 |
| `EventService` (`j`) — ping loop, states, frame dispatch, verify | 20661–20866 |
| `ServiceIds` enum (50 entries) + `CONNECTION_STATES` | 20867–20923 |
| Base typed consumer `ai` (serviceId filter) | 23281–23303 |
| AccountService / OnlineStatus / Ignore / Subscription inline handler | 24641–24725 |
| Notification model `Cm` | 29163–29175 |
| Subscription consumer + version-gated apply | 29944–29965, 30042–30076 |
| Notification consumer + service handler | 30343–30362, 35920–36240 |
| Post consumer + `getPosts` re-fetch | 31714–31740, 33188–33215 |
| Message model `Co`, attachment model `Ri` | 33449–33590 |
| Group/Message consumers | 34769–34805 |
| **GroupService master handler (DMs)** | 34974–35012 |
| `onEventSessionVerified` (reconnect recipe) | 35018–35023 |
| `getUnreadInChunks` | 35182–35244 |
| `addGroupMessage` / `fetchGroup` / `fetchGroupMessages` | 35396–35545 |
| `onMessagesEvent` + 180 s duplicate guard | 35622–35648 |
| `onMessageAckEvent` (receipts) | 35649–35720 |
| Wallet consumer + `walletVersion` gate | 36873–36952 |
| `fansly-client-*` header injection + `cyrb53` | 36340–36393 |
| OnlineStatusService (announce interval, activity gate) | 38022–38160 |
| Payment / Inovio consumers | 39428–39462, 40151–40160 |
| Profile / Streaming consumers | 41970–41986, 42296–42309 |
| App-shell master dispatcher (17 services) | 43229–43504 |
| CCBill consumer | 75195–75270 |
| ChatBot (empty handler) | 143277–143281 |
| App-shell visibility hook (`assertWebsocketConnection`) | 163128–163152 |
| Follower consumer | 172966–172980 |
| **`chatws` live-chat socket + `ChatRoomSubscribeRequest`** | 253400–254310 |

| Topic | Other files |
|---|---|
| Notification type→label table | `CODE-TABLES.md:317–342` |
| REST endpoint inventory (messaging, notifications, sessions, status) | `ENDPOINTS.md:204–284, 524–543` |
| WS handshake headers, 17 reconnects | `fansly-ui-walk-2026-08-21/fansly-ui-walk-2026-08-21.har` entries 33, 76, 157, 185, 188, 199, 202, 205, 223, 243… |
| Bootstrap REST sequence + `POST /status` heartbeat | `fansly-app-bundle-2026-08-20/fansly-app-bundle-2026-08-20.har` |

## Appendix B — external resources worth keeping

| Resource | Why |
|---|---|
| `https://github.com/agnosto/fansly-data` | **Daily archive of Fansly's `main.<hash>.js` since 2025-05-16**, plus a metadata file tracking app version, `checkKeys` and the `fansly-client-*` header set. Lets us diff the bundle across releases and re-pin the decoder after a Fansly deploy **without touching fansly.com**. Verified 2026-09-06 head still carries the same WS architecture. |
| `https://github.com/ZerGo0/fansly.streamerbot/blob/main/docs/protocol.md` | The only written public description of the Fansly frame envelope (chatws), with captured chat/tip/subscription frames. |
| `https://github.com/agnosto/fansly-scraper/blob/main/service/chat_recorder.go` | The most complete public event loop: read deadlines, dual keep-alive (app `p` + RFC 6455 ping), reconnect discipline. Good template even though it targets chatws. |
| `https://docs.onlyfansapi.com/webhooks/fansly-events` | Vendor's 38-event catalogue with payload examples and completeness caveats — an independent map of what the socket carries. |
| `https://docs.onlyfansapi.com/webhooks/delivery-and-retries` | Vendor's delivery guarantees; the benchmark our direct consumer has to beat. |
