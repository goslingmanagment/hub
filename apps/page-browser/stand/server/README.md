# Stand server

The stand's whole "internet": the SOCKS5 proxy that is Chrome's only exit
(behind the operator's CONNECT proxy), the TLS/HTTP origins behind it, and a
**journal of everything that physically reached its sockets**. Scenarios
compare that journal with the operator's admission journal. Node 22 built-ins
only; Node runs the TypeScript directly (type stripping).

```sh
docker build -t pb-stand-server -f apps/page-browser/stand/server/Dockerfile apps/page-browser/stand
docker run -d --name pb-stand -v pb-stand-ca:/stand/ca pb-stand-server
docker exec pb-stand sh /stand/server/selftest.sh     # PASS/FAIL per check
```

## Ports and environment

| Port | What |
|---|---|
| 443 | TLS front: ALPN `h2` / `http/1.1`, one leaf for all hosts |
| 80 | the same over plain HTTP/1.1 |
| 1080 | SOCKS5, CONNECT only, username/password required (RFC 1928/1929) |
| 8080 | control API (plain HTTP JSON, **not** journaled) |

| Env | Default |
|---|---|
| `STAND_CA_DIR` | `/stand/ca` — `ca.pem` (0644, for Chrome's NSS), `ca.key`, `leaf.pem`, `leaf.key`; made with `openssl` when missing (CA: P-256, 10 years; leaf: P-256, 397 days, SANs `stand.test *.stand.test site/api/ws/cdn.stand.test api.ipify.org`) |
| `STAND_PAGES_DIR` | `/stand/pages` — static files of `site.stand.test` |
| `STAND_SOCKS_USER` / `STAND_SOCKS_PASS` | `pb` / `pb-secret` |
| `STAND_TLS_PORT`, `STAND_HTTP_PORT`, `STAND_SOCKS_PORT`, `STAND_CONTROL_PORT` | 443, 80, 1080, 8080 |
| `STAND_H1_KEEPALIVE_MS` | 75000 — idle keep-alive before the server closes an HTTP/1.1 connection |
| `STAND_JOURNAL_MAX` | 250000 events kept; on overflow the oldest tenth is dropped (a reader sees a seq gap) |
| `STAND_JOURNAL_STDOUT` | `1` = also print every event as a JSON line |

SOCKS5 routes names only: `stand.test`, `*.stand.test`, `api.ipify.org` on port
443 → the TLS front, on 80 → plain HTTP; anything else (other names, any IP
literal, other ports) gets REP 0x02 "not allowed by ruleset".

## Hosts

- `site.stand.test` — files from `STAND_PAGES_DIR`, `/` → `index.html`,
  `Cache-Control: no-store`, `Service-Worker-Allowed: /` on `.js`/`.mjs`.
- `api.stand.test` — CORS for `https://*.stand.test` (Origin echoed, credentials,
  `Vary: Origin`); `OPTIONS` → 204 (Allow-Headers echoes the request,
  Max-Age = `corsMaxAge`); `/beacon` → 204; `/api/*` → JSON
  `{ok, rid, method, path, connId, streamId, proto, reused, nthOnConn, mono, seq, bodyBytes}`
  (`mono`/`seq` are those of its `req` event). Query options: `size=<B>` (padded
  to exactly B uncompressed), `delay=<ms>` (before headers), `status=<code>`,
  `enc=gzip|br`, `chunked=1` (no Content-Length; h1 chunked TE, h2 4 DATA
  pieces), `slow=<ms>` (10 pieces over ms), `etag=<v>` (+ `If-None-Match` → 304;
  `Cache-Control: max-age=<cache>` or `no-cache`), `cache=<s>`.
- `ws.stand.test` — WebSocket on any path via HTTP/1.1 Upgrade or HTTP/2
  extended CONNECT (RFC 8441, `SETTINGS_ENABLE_CONNECT_PROTOCOL=1`). First offered
  subprotocol echoed, no extensions. Text → `echo:<text>`, binary echoed,
  ping → pong. Plain requests → 426.
- `cdn.stand.test` — `/img/*.png?size=` (1×1 PNG, zero-padded after IEND),
  `/video/*.mp4?size=` (default 1 MiB of fixed noise; single `Range` → 206/416);
  `Access-Control-Allow-Origin: *`, `Timing-Allow-Origin: *`.
- `api.ipify.org` — `GET /` → `exitIp` as text, `?format=json` → `{"ip": …}`.
- anything else → 421.

## Control API (:8080)

| Request | Reply |
|---|---|
| `GET /health` | `{ok: true}` |
| `GET /journal?since=<seq>[&limit=<n>]` | `{events, next}` — events with seq > since; pass `next` back. `since` past the end → `next` = last seq |
| `POST /journal/clear` | drops events; seq keeps counting |
| `POST /faults` `{kind, match?: {host?, pathPrefix?, rid?, method?}, count?: 1 \| n \| -1, ms?, code?}` | `{id}` (`{id: null, socksDown}` for the toggles) |
| `GET /faults` / `DELETE /faults` / `DELETE /faults/<id>` | list / clear all / remove one |
| `POST /ws/push` `{wsId?, text}` | `{sent}` — text frame to one or all open WebSockets |
| `POST /ws/close` `{wsId?, code?}` | `{closed}` — server-initiated close (default 1000) |
| `GET /config`, `POST /config` `{corsMaxAge?, exitIp?, h1Hosts?}` | the config (defaults `0`, `"203.0.113.7"`, `[]`); `h1Hosts` = SNI hosts offered only ALPN `http/1.1`, so Chrome talks HTTP/1.1 to them (needed for `h1_408_on_reuse`; Chrome picks h2 otherwise) |
| `GET /conns` | open TCP connections, WebSockets, SOCKS tunnels |

## Faults

Applied to the next matching event(s); `count` (default 1, -1 = until
cleared) is decremented per application and a `fault` event is journaled each
time. Match fields a kind cannot see are rejected (400).

| kind | match | effect |
|---|---|---|
| `tcpDelay` `{ms}` | — | next :443 connection: the ClientHello stays unread in the kernel for ms |
| `tlsStall` `{ms}` | host = SNI | ClientHello read and journaled (`tls.hello`), then held ms before TLS sees it — no ServerHello meanwhile |
| `h1_408_on_reuse` `{code?}` | request | only an HTTP/1.1 request on a reused connection: 408 (or `code`) + `Connection: close` |
| `h2RefusedStream` `{code?}` | request | HTTP/2: RST_STREAM REFUSED_STREAM (7, or `code`), no answer |
| `h2Goaway` `{code?}` | request | HTTP/2: GOAWAY with last-stream-id = stream − 2, no answer, graceful close after 200 ms (stream 1: see below) |
| `resetAfterHeaders` | request | TCP RST right after the request headers (no response, no TLS alert) |
| `delayResponse` `{ms}` | request | response headers delayed by ms |
| `closeAfterResponse` | request | after the response: h1 `Connection: close`; h2 GOAWAY + close |
| `socksConnectDelay` `{ms}` | host | delay before the CONNECT reply |
| `socksAuthFail` | — | RFC 1929 sub-negotiation fails even with good credentials |
| `socksRefuse` `{code?}` | host | CONNECT reply REP 0x05 (or `code`) |
| `socksDown` / `socksUp` | — | toggles: close the :1080 listener (new connects get ECONNREFUSED) and destroy every open tunnel / listen again |

"request" = `host` (`:authority`/`Host` without port), `pathPrefix` (of path +
query), `rid` (query parameter), `method`. Request faults are checked in this
order, and the first terminal one wins: `resetAfterHeaders`, `h2RefusedStream`,
`h2Goaway`, `h1_408_on_reuse`. Then `closeAfterResponse` and `delayResponse`
are applied. They also apply to WebSocket handshakes.

## Journal

`mono` = `Number(process.hrtime.bigint()) / 1e6` — CLOCK_MONOTONIC in ms,
comparable across the containers of one Docker VM. Every request is journaled
(`req`) before any fault or answer; every exchange ends with exactly one `res`.

```ts
type Base = { seq: number; mono: number; wall: string };
type Proto = "h1" | "h2";
type JournalEvent = Base & (
  // HTTP front, per TCP connection (:443 and :80)
  | { type: "tcp.accept"; connId: number; port: number; tls: boolean; remote: string; socksId: number | null }
  | { type: "tls.hello"; connId: number; servername: string | null; alpn: string[] }            // ClientHello, incl. resumptions
  | { type: "tls.secure"; connId: number; alpn: string | null; servername: string | null; version: string; resumed: boolean }
  | { type: "tls.error"; connId: number; error: string }                                        // handshake failed
  | { type: "tcp.close"; connId: number; bytesIn: number; bytesOut: number; requests: number; ms: number; error: string | null } // raw TCP bytes
  // HTTP, per HTTP/1.1 request or HTTP/2 stream
  | { type: "req"; connId: number; proto: Proto; streamId: number | null; method: string; authority: string; path: string;
      rid: string | null; headers: [string, string][]; reused: boolean; nthOnConn: number; ws: boolean }
  | { type: "req.body"; connId: number; streamId: number | null; rid: string | null; bytes: number }
  | { type: "res"; connId: number; proto: Proto; streamId: number | null; rid: string | null; status: number | null;
      bodyBytes: number; complete: boolean; ms: number; rstCode?: number; fault?: string }
  | { type: "fault"; faultId: string | null; kind: string; connId?: number; streamId?: number | null; rid?: string | null;
      socksId?: number; host?: string | null; servername?: string; ms?: number; code?: number; destroyed?: number }
  | { type: "h2.rst"; connId: number; streamId: number; rid: string | null; code: number; by: "server" | "client"; emulated?: true }
  | { type: "h2.goaway"; connId: number; lastStreamId: number; code: number; by: "server" | "client";
      reason?: "h2Goaway" | "closeAfterResponse"; emulated?: true }
  | { type: "h2.frameError"; connId: number; frameType: number; code: number; streamId: number }
  | { type: "h2.error"; connId: number; error: string }
  | { type: "h1.error"; connId: number | null; code: string | null; error: string }             // unparsable request
  // WebSocket (frames in both directions)
  | { type: "ws.open"; wsId: string; connId: number; proto: Proto; streamId: number | null; path: string; rid: string | null; protocol: string | null }
  | { type: "ws.frame"; wsId: string; opcode: number; fin: boolean; len: number; enc: "utf8" | "base64"; text: string;  // client → server
      truncated: boolean; code?: number | null; reason?: string }                                // text: ≤ 2000 chars
  | { type: "ws.send"; wsId: string; opcode: number; len: number; enc: "utf8" | "base64"; text: string; truncated: boolean } // server → client
  | { type: "ws.error"; wsId: string; error: string; code: number }
  | { type: "ws.close"; wsId: string; code: number; by: "client" | "server" | "reset"; framesIn: number; framesOut: number } // reset → 1006
  // SOCKS5 (:1080)
  | { type: "socks.accept"; socksId: number; remote: string }
  | { type: "socks.auth"; socksId: number; user: string | null; ok: boolean; reason?: string; methods?: number[] }
  | { type: "socks.connect"; socksId: number; host: string | null; port: number | null; atyp: "ipv4" | "domain" | "ipv6" | number;
      result: "ok" | "notAllowed" | "refused" | "upstreamError" | "unsupportedCommand" | "badAddressType" | "clientGone";
      rep: number | null; delayMs: number; upstreamPort?: number | null; ms?: number; error?: string }
  | { type: "socks.close"; socksId: number; bytesUp: number; bytesDown: number; ms: number; error: string | null }
  | { type: "socks.error"; socksId: number; error: string }
  // process
  | { type: "server.start"; ports: Record<string, number>; caDir: string; pagesDir: string; certs: { ca: boolean; leaf: boolean } }
  | { type: "server.error"; where: string; error: string }                                      // should never appear
);
```

A tunnel and its front connection are linked by `tcp.accept.socksId` (and
`socks.connect.upstreamPort` = the port in `tcp.accept.remote`); their byte
counts match (`socks.close.bytesUp/Down` = `tcp.close.bytesIn/Out`).

## Implementation notes

- **TLS hand-off.** Each :443 socket is wrapped in `new tls.TLSSocket(raw, {isServer})`.
  After `secure` it is passed to `http.Server` or `http2.Server` with
  `emit("connection", tlsSocket)`. h1 works as is. The h2 session never starts
  unless the front first sets `tlsSocket.secureConnecting = false`, because
  Node's Http2Session waits for `secureConnect` while that flag is true, and only
  `tls.Server` clears it.
- **ClientHello peek.** The front reads and parses the ClientHello itself
  (`tls-hello.ts`) and then `unshift`s it for TLS. This gives `tls.hello` and
  SNI-matched `tlsStall` on resumed handshakes too, where OpenSSL skips the
  SNI/cert callback.
- **`h2Goaway` on stream 1.** Node cannot send last-stream-id 0, because
  `Http2Session::Goaway` replaces any value ≤ 0 with the last processed stream.
  So stream 1 gets GOAWAY(last=1) and then RST_STREAM REFUSED_STREAM, and
  Chrome retries it on a new connection. Journaled with `emulated: true`. The
  order matters: with the RST first, Chrome 155 retries on the same,
  still-listed session, which then closes, and the request fails with
  `ERR_CONNECTION_CLOSED` (seen in a NetLog).
- **Not journaled.** HEADERS that nghttp2 discards after the server's GOAWAY
  (streams above last-stream-id) never reach JS. Nor do bytes that arrive after a
  graceful h2 close stops reading. Count them as "reached the network, never
  processed".
- `ws-codec.ts` (FrameParser / MessageAssembler / encodeFrame) has no stand
  dependencies and works for both client and server.
