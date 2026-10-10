#!/bin/sh
# Self-test of the stand server, run inside its container:
#   docker exec <container> sh /stand/server/selftest.sh
# One PASS/FAIL line per check, then a summary; exits non-zero on any FAIL.
# It arms and clears faults, changes and restores /config, and clears the
# journal at the very end — do not run it while a scenario is using the stand.
set -u
cd "$(dirname "$0")"

CA_DIR=${STAND_CA_DIR:-/stand/ca}
CA=$CA_DIR/ca.pem
CTL=http://127.0.0.1:${STAND_CONTROL_PORT:-8080}
PAGES=${STAND_PAGES_DIR:-/stand/pages}
SOCKS_ADDR=127.0.0.1:${STAND_SOCKS_PORT:-1080}
SOCKS_CREDS=${STAND_SOCKS_USER:-pb}:${STAND_SOCKS_PASS:-pb-secret}
NODE="node --experimental-strip-types --no-warnings ./selftest-client.ts"
TMP=$(mktemp -d)
LOG=$TMP/log
: > "$LOG"
trap 'rm -rf "$TMP" "$PAGES/.selftest"' EXIT

RESOLVE=""
for h in site api ws cdn foo; do RESOLVE="$RESOLVE --resolve $h.stand.test:443:127.0.0.1 --resolve $h.stand.test:80:127.0.0.1"; done
RESOLVE="$RESOLVE --resolve api.ipify.org:443:127.0.0.1"
CURL="curl -sS --max-time 15 --cacert $CA $RESOLVE"
# Through the SOCKS5 server: names are resolved by the proxy (socks5h).
SCURL="curl -sS --max-time 15 --cacert $CA --socks5-hostname $SOCKS_ADDR"
API=https://api.stand.test

# ---------------------------------------------------------------- helpers
pass() { echo "PASS $1" | tee -a "$LOG"; }
fail() { echo "FAIL $1${2:+ — $2}" | tee -a "$LOG"; }
# ok NAME CMD…: PASS when CMD succeeds.
ok() { name=$1; shift; if "$@"; then pass "$name"; else fail "$name"; fi; }
# eq NAME GOT WANT
eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "got '$2', want '$3'"; fi; }
# contains NAME HAYSTACK NEEDLE
contains() { case $2 in *"$3"*) pass "$1" ;; *) fail "$1" "$(printf %s "$2" | head -c 300)" ;; esac; }
quiet() { "$@" >/dev/null 2>&1; }
ge() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a + 0 >= b + 0) }'; }
lt() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a + 0 < b + 0) }'; }
# hdr FILE NAME: value of the last header NAME in a curl -D dump.
hdr() { tr -d '\r' < "$1" | awk -v n="$2" 'BEGIN { n = tolower(n) } { i = index($0, ":"); if (i > 0 && tolower(substr($0, 1, i - 1)) == n) { v = substr($0, i + 1); sub(/^ +/, "", v); last = v } } END { print last }'; }
ctl() {
  if [ $# -ge 3 ]; then curl -sS -X "$1" -H 'content-type: application/json' --data "$3" "$CTL$2"
  else curl -sS -X "$1" "$CTL$2"; fi
}
fault() { ctl POST /faults "$1" >/dev/null; }
mark() { M=$($NODE mark); }
# expect NAME JS-EXPR: a predicate over the journal since the last mark
# (helpers: evs, find(type, fields), all(type, fields), has(type, fields)).
expect() { $NODE expect "$M" "$1" "$2" | tee -a "$LOG"; }
node_check() { $NODE "$@" | tee -a "$LOG"; }
section() { echo "== $1"; }

START=$($NODE mark)
ctl DELETE /faults >/dev/null
ctl POST /config '{"corsMaxAge":0,"exitIp":"203.0.113.7","h1Hosts":[]}' >/dev/null

# ---------------------------------------------------------------- control + certs
section "control API and certificates"
contains "control: GET /health" "$(ctl GET /health)" '"ok":true'
ok "certs: leaf chains to the stand CA" quiet openssl verify -CAfile "$CA" "$CA_DIR/leaf.pem"
sans=$(openssl x509 -in "$CA_DIR/leaf.pem" -noout -ext subjectAltName)
contains "certs: leaf SAN *.stand.test" "$sans" "DNS:*.stand.test"
contains "certs: leaf SAN api.ipify.org" "$sans" "DNS:api.ipify.org"
contains "certs: leaf EKU serverAuth" "$(openssl x509 -in "$CA_DIR/leaf.pem" -noout -ext extendedKeyUsage)" "TLS Web Server Authentication"
from=$(openssl x509 -in "$CA_DIR/leaf.pem" -noout -startdate | cut -d= -f2)
to=$(openssl x509 -in "$CA_DIR/leaf.pem" -noout -enddate | cut -d= -f2)
days=$(( ($(date -d "$to" +%s) - $(date -d "$from" +%s)) / 86400 ))
ok "certs: leaf validity $days ≤ 397 days" [ "$days" -le 397 ]
contains "certs: CA is CA:TRUE" "$(openssl x509 -in "$CA" -noout -ext basicConstraints)" "CA:TRUE"
eq "certs: ca.pem is world-readable" "$(stat -c %a "$CA")" "644"

# ---------------------------------------------------------------- HTTP basics
section "HTTP/1.1 and HTTP/2 basics"
mark
contains "h1 GET (TLS, ALPN http/1.1)" "$($CURL --http1.1 "$API/api/x?rid=t-h1")" '"proto":"h1"'
contains "h2 GET (TLS, ALPN h2)" "$($CURL --http2 "$API/api/x?rid=t-h2")" '"proto":"h2"'
expect "journal: h1 req — streamId null, not reused, raw headers in order" \
  'has("req",{rid:"t-h1",proto:"h1",streamId:null,reused:false,nthOnConn:1,method:"GET",authority:"api.stand.test",path:"/api/x?rid=t-h1"}) && find("req",{rid:"t-h1"}).headers[0][0]==="Host"'
expect "journal: h2 req — stream 1, pseudo-headers first" \
  'has("req",{rid:"t-h2",proto:"h2",streamId:1,reused:false}) && find("req",{rid:"t-h2"}).headers[0][0]===":method"'
expect "journal: tcp.accept → tls.hello(SNI) → tls.secure(h2) → req → res → tcp.close(bytes)" '(() => {
  const r = find("req",{rid:"t-h2"}); const c = r.connId;
  const a = find("tcp.accept",{connId:c,port:443,tls:true}), h = find("tls.hello",{connId:c}), s = find("tls.secure",{connId:c});
  const x = find("res",{rid:"t-h2"}), z = find("tcp.close",{connId:c});
  return a && h && s && x && z && h.servername==="api.stand.test" && s.alpn==="h2" && s.version==="TLSv1.3"
    && a.seq<h.seq && h.seq<s.seq && s.seq<r.seq && r.seq<x.seq && x.seq<z.seq
    && x.status===200 && x.complete===true && z.bytesIn>0 && z.bytesOut>0 && typeof r.mono==="number" && typeof r.wall==="string"; })()'

mark
$CURL --http1.1 -o /dev/null -o /dev/null "$API/api/x?rid=t-ra" "$API/api/x?rid=t-rb"
expect "h1 keep-alive: 2nd request on the same connId, reused, nthOnConn 2" \
  'find("req",{rid:"t-rb"}).connId===find("req",{rid:"t-ra"}).connId && has("req",{rid:"t-ra",reused:false,nthOnConn:1}) && has("req",{rid:"t-rb",reused:true,nthOnConn:2})'
$CURL --http2 -o /dev/null -o /dev/null "$API/api/x?rid=t-rc" "$API/api/x?rid=t-rd"
expect "h2 session: streams 1 and 3 on one connId, 2nd reused" \
  'find("req",{rid:"t-rd"}).connId===find("req",{rid:"t-rc"}).connId && has("req",{rid:"t-rc",streamId:1,reused:false}) && has("req",{rid:"t-rd",streamId:3,reused:true,nthOnConn:2})'

mark
contains "plain HTTP :80" "$(curl -sS --max-time 15 $RESOLVE "http://api.stand.test/api/x?rid=t-80")" '"proto":"h1"'
expect "journal: :80 connection is tls:false" 'has("tcp.accept",{connId:find("req",{rid:"t-80"}).connId,port:80,tls:false})'
eq "unknown host → 421" "$($CURL -o /dev/null -w '%{http_code}' https://foo.stand.test/)" "421"
ctl POST /config '{"h1Hosts":["api.stand.test"]}' >/dev/null
eq "config h1Hosts: api.stand.test offers only http/1.1 (curl --http2 gets 1.1)" \
  "$($CURL --http2 -o /dev/null -w '%{http_version}' "$API/api/x?rid=t-h1only") $($CURL --http2 -o /dev/null -w '%{http_version}' https://site.stand.test/no-such-page)" "1.1 2"
ctl POST /config '{"h1Hosts":[]}' >/dev/null

# ---------------------------------------------------------------- CORS
section "CORS (api.stand.test)"
mark
pre() { $CURL --http2 -X OPTIONS -D "$TMP/h" -o /dev/null -w '%{http_code}' -H "Origin: $1" -H 'Access-Control-Request-Method: PUT' \
  -H 'Access-Control-Request-Headers: authorization, fansly-client-id' "$API/api/x?rid=$2"; }
eq "preflight OPTIONS → 204" "$(pre https://site.stand.test t-pre1)" "204"
eq "preflight: Allow-Origin echoes the origin" "$(hdr "$TMP/h" access-control-allow-origin)" "https://site.stand.test"
eq "preflight: Allow-Credentials true" "$(hdr "$TMP/h" access-control-allow-credentials)" "true"
eq "preflight: Allow-Methods" "$(hdr "$TMP/h" access-control-allow-methods)" "GET, POST, PUT, PATCH, DELETE, OPTIONS"
eq "preflight: Allow-Headers echoes the request" "$(hdr "$TMP/h" access-control-allow-headers)" "authorization, fansly-client-id"
eq "preflight: Max-Age 0 by default" "$(hdr "$TMP/h" access-control-max-age)" "0"
eq "preflight: Vary Origin" "$(hdr "$TMP/h" vary)" "Origin"
ctl POST /config '{"corsMaxAge":600}' >/dev/null
pre https://site.stand.test t-pre2 >/dev/null
eq "config corsMaxAge 600 → Max-Age 600" "$(hdr "$TMP/h" access-control-max-age)" "600"
ctl POST /config '{"corsMaxAge":0}' >/dev/null
pre https://evil.example t-pre3 >/dev/null
eq "foreign origin gets no Allow-Origin" "$(hdr "$TMP/h" access-control-allow-origin)" ""
$CURL --http2 -o /dev/null -D "$TMP/h" -H 'Origin: https://site.stand.test' "$API/api/x?rid=t-cors"
eq "simple GET: Allow-Origin echoed" "$(hdr "$TMP/h" access-control-allow-origin)" "https://site.stand.test"
expect "journal: preflight OPTIONS journaled as an h2 stream" 'has("req",{rid:"t-pre1",method:"OPTIONS",proto:"h2"}) && has("res",{rid:"t-pre1",status:204})'

# ---------------------------------------------------------------- response shaping
section "api.stand.test response options"
$CURL --http2 --compressed -D "$TMP/h" -o "$TMP/b" "$API/api/x?rid=t-gz&enc=gzip&size=5000" -w '%{size_download}' > "$TMP/n"
ok "enc=gzip: Content-Encoding gzip, 5000 B decoded, fewer on the wire" sh -c "[ \"$(hdr "$TMP/h" content-encoding)\" = gzip ] && [ \$(wc -c < '$TMP/b') -eq 5000 ] && [ \$(cat '$TMP/n') -lt 5000 ]"
$CURL --http2 --compressed -D "$TMP/h" -o "$TMP/b" "$API/api/x?rid=t-br&enc=br&size=5000"
ok "enc=br: Content-Encoding br, 5000 B decoded" sh -c "[ \"$(hdr "$TMP/h" content-encoding)\" = br ] && [ \$(wc -c < '$TMP/b') -eq 5000 ]"
$CURL --http1.1 -D "$TMP/h" -o "$TMP/b" "$API/api/x?rid=t-ch1&chunked=1&size=3000"
ok "chunked=1 (h1): Transfer-Encoding chunked, no Content-Length" sh -c "[ \"$(hdr "$TMP/h" transfer-encoding)\" = chunked ] && [ -z \"$(hdr "$TMP/h" content-length)\" ] && [ \$(wc -c < '$TMP/b') -eq 3000 ]"
$CURL --http2 -D "$TMP/h" -o "$TMP/b" "$API/api/x?rid=t-ch2&chunked=1&size=3000"
ok "chunked=1 (h2): no Content-Length, body complete" sh -c "[ -z \"$(hdr "$TMP/h" content-length)\" ] && [ \$(wc -c < '$TMP/b') -eq 3000 ]"
set -- $($CURL --http2 -o /dev/null -w '%{time_starttransfer} %{time_total}' "$API/api/x?rid=t-slow&slow=600&size=2000")
ok "slow=600: headers early ($1 s), body done after ≥ 0.55 s ($2 s)" sh -c "$(command -v awk) -v a=$1 -v b=$2 'BEGIN { exit !(a < 0.3 && b >= 0.55) }'"
ttfb=$($CURL --http2 -o /dev/null -w '%{time_starttransfer}' "$API/api/x?rid=t-delay&delay=500")
ok "delay=500: first byte after ≥ 0.5 s ($ttfb s)" ge "$ttfb" 0.5
eq "status=503" "$($CURL -o /dev/null -w '%{http_code}' "$API/api/x?rid=t-st&status=503")" "503"
eq "size=10000: body is exactly 10000 B" "$($CURL -o /dev/null -w '%{size_download}' "$API/api/x?rid=t-size&size=10000")" "10000"
code=$($CURL --http2 -D "$TMP/h" -o /dev/null -w '%{http_code}' "$API/api/x?rid=t-etag&etag=v1")
ok "etag=v1: 200, ETag \"v1\", Cache-Control no-cache" sh -c "[ $code = 200 ] && [ '$(hdr "$TMP/h" etag)' = '\"v1\"' ] && [ '$(hdr "$TMP/h" cache-control)' = no-cache ]"
set -- $($CURL --http2 -o /dev/null -w '%{http_code} %{size_download}' -H 'If-None-Match: "v1"' "$API/api/x?rid=t-etag&etag=v1")
ok "etag: If-None-Match → 304 without a body" sh -c "[ $1 = 304 ] && [ $2 = 0 ]"
$CURL --http2 -D "$TMP/h" -o /dev/null "$API/api/x?rid=t-cache&etag=v2&cache=60"
eq "etag + cache=60 → Cache-Control max-age=60" "$(hdr "$TMP/h" cache-control)" "max-age=60"
mark
head -c 3000 /dev/zero > "$TMP/b3k"
contains "POST body (h2): bodyBytes 3000 in the reply" "$($CURL --http2 --data-binary @"$TMP/b3k" "$API/api/x?rid=t-post2")" '"bodyBytes":3000'
contains "POST body (h1): bodyBytes 3000 in the reply" "$($CURL --http1.1 --data-binary @"$TMP/b3k" "$API/api/x?rid=t-post1")" '"bodyBytes":3000'
expect "journal: req.body bytes 3000 (h1 and h2)" 'has("req.body",{rid:"t-post2",bytes:3000}) && has("req.body",{rid:"t-post1",bytes:3000,streamId:null})'
eq "POST /beacon → 204" "$($CURL --http2 -o /dev/null -w '%{http_code}' --data x "$API/beacon?rid=t-beacon")" "204"
set -- $($CURL --http2 -I -o /dev/null -w '%{http_code} %{size_download}' "$API/api/x?rid=t-head")
ok "HEAD → 200 without a body" sh -c "[ $1 = 200 ] && [ $2 = 0 ]"

# ---------------------------------------------------------------- static site
section "site.stand.test (static pages)"
if mkdir -p "$PAGES/.selftest" 2>/dev/null && printf '<!doctype html><title>t</title>\n' > "$PAGES/.selftest/index.html" 2>/dev/null; then
  printf 'self.addEventListener("fetch", () => {});\n' > "$PAGES/.selftest/sw.js"
  code=$($CURL --http2 -D "$TMP/h" -o /dev/null -w '%{http_code}' https://site.stand.test/.selftest/)
  ok "dir/ → index.html, text/html, no-store" sh -c "[ $code = 200 ] && [ '$(hdr "$TMP/h" content-type)' = 'text/html; charset=utf-8' ] && [ '$(hdr "$TMP/h" cache-control)' = no-store ]"
  $CURL --http2 -D "$TMP/h" -o /dev/null https://site.stand.test/.selftest/sw.js
  ok ".js: text/javascript + Service-Worker-Allowed: /" sh -c "[ '$(hdr "$TMP/h" content-type)' = 'text/javascript; charset=utf-8' ] && [ '$(hdr "$TMP/h" service-worker-allowed)' = / ]"
  eq "directory without slash → 301" "$($CURL -o /dev/null -w '%{http_code}' https://site.stand.test/.selftest)" "301"
else
  echo "SKIP static checks: $PAGES is not writable"
fi
eq "missing page → 404" "$($CURL -o /dev/null -w '%{http_code}' https://site.stand.test/no-such-page.html)" "404"
eq "path traversal → 404" "$($CURL --path-as-is -o /dev/null -w '%{http_code}' https://site.stand.test/../../etc/passwd)" "404"

# ---------------------------------------------------------------- cdn + ipify
section "cdn.stand.test and api.ipify.org"
code=$($CURL --http2 -D "$TMP/h" -o "$TMP/png" -w '%{http_code}' "https://cdn.stand.test/img/a.png?size=5000&rid=t-png")
ok "img .png?size=5000: 200 image/png, 5000 B, PNG signature" sh -c "[ $code = 200 ] && [ '$(hdr "$TMP/h" content-type)' = image/png ] && [ \$(wc -c < '$TMP/png') -eq 5000 ] && [ \"\$(od -An -tx1 -N8 '$TMP/png' | tr -d ' \n')\" = 89504e470d0a1a0a ]"
ok "cdn: Access-Control-Allow-Origin * and Timing-Allow-Origin *" sh -c "[ '$(hdr "$TMP/h" access-control-allow-origin)' = '*' ] && [ '$(hdr "$TMP/h" timing-allow-origin)' = '*' ]"
code=$($CURL --http2 -D "$TMP/h" -o "$TMP/full" -w '%{http_code}' "https://cdn.stand.test/video/v.mp4?size=100000")
ok "video .mp4?size=100000: 200 video/mp4, 100000 B, Accept-Ranges" sh -c "[ $code = 200 ] && [ '$(hdr "$TMP/h" content-type)' = video/mp4 ] && [ \$(wc -c < '$TMP/full') -eq 100000 ] && [ '$(hdr "$TMP/h" accept-ranges)' = bytes ]"
code=$($CURL --http2 -D "$TMP/h" -o "$TMP/part" -w '%{http_code}' -H 'Range: bytes=100-199' "https://cdn.stand.test/video/v.mp4?size=100000")
dd if="$TMP/full" of="$TMP/slice" bs=1 skip=100 count=100 2>/dev/null
ok "Range bytes=100-199 → 206, Content-Range, same bytes as the full file" sh -c "[ $code = 206 ] && [ '$(hdr "$TMP/h" content-range)' = 'bytes 100-199/100000' ] && cmp -s '$TMP/part' '$TMP/slice'"
$CURL --http2 -D "$TMP/h" -o "$TMP/part" -H 'Range: bytes=-10' "https://cdn.stand.test/video/v.mp4?size=100000"
eq "Range bytes=-10 → last 10 bytes" "$(hdr "$TMP/h" content-range) $(wc -c < "$TMP/part")" "bytes 99990-99999/100000 10"
eq "Range past the end → 416" "$($CURL -o /dev/null -w '%{http_code}' -H 'Range: bytes=200000-' "https://cdn.stand.test/video/v.mp4?size=100000")" "416"
eq "api.ipify.org → exit IP" "$($CURL https://api.ipify.org/)" "203.0.113.7"
eq "api.ipify.org ?format=json" "$($CURL 'https://api.ipify.org/?format=json')" '{"ip":"203.0.113.7"}'
ctl POST /config '{"exitIp":"198.51.100.9"}' >/dev/null
eq "config exitIp → api.ipify.org follows" "$($CURL https://api.ipify.org/)" "198.51.100.9"
ctl POST /config '{"exitIp":"203.0.113.7"}' >/dev/null

# ---------------------------------------------------------------- SOCKS5
section "SOCKS5 (:1080, username/password)"
mark
contains "SOCKS5 → https://api.stand.test (h2)" "$($SCURL --proxy-user "$SOCKS_CREDS" "$API/api/x?rid=t-sk1")" '"rid":"t-sk1"'
expect "journal: socks.accept/auth/connect, tcp.accept.socksId, socks.close bytes = tcp.close bytes" '(() => {
  const r = find("req",{rid:"t-sk1"}); const a = find("tcp.accept",{connId:r.connId}); const id = a.socksId;
  const c = find("socks.connect",{socksId:id}); const t = find("tcp.close",{connId:r.connId}); const z = find("socks.close",{socksId:id});
  return id !== null && has("socks.accept",{socksId:id}) && has("socks.auth",{socksId:id,ok:true,user:"pb"})
    && c && c.host==="api.stand.test" && c.port===443 && c.atyp==="domain" && c.result==="ok" && c.rep===0 && c.upstreamPort===Number(a.remote.split(":")[1])
    && t && z && z.bytesUp===t.bytesIn && z.bytesDown===t.bytesOut; })()'
contains "SOCKS5 → http://api.stand.test (port 80 route)" "$($SCURL --proxy-user "$SOCKS_CREDS" "http://api.stand.test/api/x?rid=t-sk80")" '"rid":"t-sk80"'
eq "SOCKS5 → https://api.ipify.org" "$($SCURL --proxy-user "$SOCKS_CREDS" https://api.ipify.org/)" "203.0.113.7"
mark
$SCURL --proxy-user pb:wrong -o /dev/null "$API/api/x?rid=t-skbad" 2>/dev/null; rc=$?
eq "wrong password → curl fails (97)" "$rc" "97"
fault '{"kind":"socksAuthFail"}'
$SCURL --proxy-user "$SOCKS_CREDS" -o /dev/null "$API/api/x?rid=t-skaf" 2>/dev/null; rc=$?
eq "fault socksAuthFail → correct password rejected (97)" "$rc" "97"
expect "journal: socks.auth ok:false for both (bad credentials, fault)" \
  'has("socks.auth",{ok:false,user:"pb",reason:"bad credentials"}) && has("socks.auth",{ok:false,reason:"fault socksAuthFail"}) && has("fault",{kind:"socksAuthFail"}) && !has("req",{rid:"t-skaf"})'
$SCURL --proxy-user "$SOCKS_CREDS" -o /dev/null https://example.com/ 2>/dev/null; rc=$?
eq "other host → refused by ruleset (97)" "$rc" "97"
$SCURL --proxy-user "$SOCKS_CREDS" -o /dev/null https://10.1.2.3/ 2>/dev/null; rc=$?
eq "IP literal → refused by ruleset (97)" "$rc" "97"
$SCURL --proxy-user "$SOCKS_CREDS" -o /dev/null https://api.stand.test:8443/ 2>/dev/null; rc=$?
eq "stand host on port 8443 → refused by ruleset (97)" "$rc" "97"
expect "journal: socks.connect notAllowed REP 2 (name, IPv4 literal, port)" \
  'has("socks.connect",{host:"example.com",result:"notAllowed",rep:2}) && has("socks.connect",{host:"10.1.2.3",atyp:"ipv4",result:"notAllowed",rep:2}) && has("socks.connect",{host:"api.stand.test",port:8443,result:"notAllowed"})'
mark
fault '{"kind":"socksRefuse","match":{"host":"api.stand.test"}}'
$SCURL --proxy-user "$SOCKS_CREDS" -o /dev/null "$API/api/x?rid=t-skref" 2>/dev/null; rc=$?
eq "fault socksRefuse → CONNECT refused (97)" "$rc" "97"
expect "journal: socks.connect refused REP 5, nothing reached the front" 'has("socks.connect",{host:"api.stand.test",result:"refused",rep:5}) && !has("req",{rid:"t-skref"})'
fault '{"kind":"socksConnectDelay","ms":700}'
set -- $($SCURL --proxy-user "$SOCKS_CREDS" -o /dev/null -w '%{http_code} %{time_appconnect}' "$API/api/x?rid=t-skdelay")
ok "fault socksConnectDelay 700 → 200 after ≥ 0.7 s ($2 s)" sh -c "[ $1 = 200 ] && $(command -v awk) -v t=$2 'BEGIN { exit !(t >= 0.7) }'"
expect "journal: socks.connect delayMs 700" 'has("socks.connect",{result:"ok",delayMs:700})'
mark
($SCURL --proxy-user "$SOCKS_CREDS" -o /dev/null "$API/api/x?rid=t-skdown&slow=4000&size=4000" 2>/dev/null; echo $? > "$TMP/bg") &
sleep 1
fault '{"kind":"socksDown"}'
wait
ok "socksDown: an open tunnel is destroyed (curl exit $(cat "$TMP/bg"))" [ "$(cat "$TMP/bg")" != 0 ]
$SCURL --proxy-user "$SOCKS_CREDS" -o /dev/null "$API/api/x?rid=t-skdown2" 2>/dev/null; rc=$?
eq "socksDown: new connections refused (curl 7)" "$rc" "7"
fault '{"kind":"socksUp"}'
contains "socksUp: SOCKS5 works again" "$($SCURL --proxy-user "$SOCKS_CREDS" "$API/api/x?rid=t-skup")" '"rid":"t-skup"'
expect "journal: socksDown destroyed ≥ 1 tunnel; the slow response did not complete" \
  'all("fault",{kind:"socksDown"}).some(f => f.destroyed >= 1) && has("fault",{kind:"socksUp"}) && has("res",{rid:"t-skdown",complete:false}) && !has("req",{rid:"t-skdown2"})'

# ---------------------------------------------------------------- WebSocket
section "WebSocket (ws.stand.test)"
mark
node_check ws-h1 t-ws1
expect "journal: ws over h1 — req ws:true, ws.open, text/ping frames, ws.send echo, ws.close by client 1000" '(() => {
  const o = find("ws.open",{rid:"t-ws1",proto:"h1",streamId:null,protocol:"chat"}); if (!o) return false; const id = o.wsId;
  return has("req",{rid:"t-ws1",ws:true,proto:"h1"}) && has("res",{rid:"t-ws1",status:101})
    && has("ws.frame",{wsId:id,opcode:1,enc:"utf8",text:"hello",fin:true}) && has("ws.frame",{wsId:id,opcode:1,text:"fr",fin:false})
    && has("ws.frame",{wsId:id,opcode:0,text:"ag",fin:true}) && has("ws.frame",{wsId:id,opcode:9})
    && has("ws.send",{wsId:id,opcode:1,text:"echo:hello"}) && has("ws.send",{wsId:id,text:"pushed-t-ws1"})
    && has("ws.frame",{wsId:id,opcode:8,code:1000}) && has("ws.close",{wsId:id,by:"client",code:1000}); })()'
mark
node_check ws-h2 t-ws2
expect "journal: ws over h2 extended CONNECT — stream id, :protocol header, ws.close by server 4001" '(() => {
  const o = find("ws.open",{rid:"t-ws2",proto:"h2"}); if (!o) return false; const id = o.wsId; const r = find("req",{rid:"t-ws2"});
  return r.ws===true && r.method==="CONNECT" && r.streamId===o.streamId && r.headers.some(([k,v]) => k===":protocol" && v==="websocket")
    && has("res",{rid:"t-ws2",status:200}) && has("ws.frame",{wsId:id,opcode:1,text:"hello-h2"}) && has("ws.close",{wsId:id,by:"server",code:4001}); })()'
eq "plain GET to ws.stand.test → 426" "$($CURL --http2 -o /dev/null -w '%{http_code}' "https://ws.stand.test/plain?rid=t-wsplain")" "426"

# ---------------------------------------------------------------- faults
section "faults"
mark
fault '{"kind":"h2RefusedStream","match":{"rid":"t-refused"}}'
node_check h2-refused t-refused
expect "journal: fault + h2.rst code 7 by server; res incomplete" \
  'has("fault",{kind:"h2RefusedStream",rid:"t-refused"}) && has("h2.rst",{rid:"t-refused",code:7,by:"server"}) && has("res",{rid:"t-refused",complete:false,status:null})'
fault '{"kind":"h2Goaway","match":{"rid":"t-goaway3"}}'
node_check h2-goaway t-goaway3 warm
expect "journal: h2.goaway lastStreamId 1 for stream 3 (not emulated)" \
  'has("req",{rid:"t-goaway3",streamId:3}) && all("h2.goaway",{by:"server",lastStreamId:1,reason:"h2Goaway"}).some(g => g.connId===find("req",{rid:"t-goaway3"}).connId && !g.emulated)'
fault '{"kind":"h2Goaway","match":{"rid":"t-goaway1"}}'
node_check h2-goaway t-goaway1 cold
expect "journal: stream 1 GOAWAY emulated (h2.rst 7 + h2.goaway last 1)" \
  'has("req",{rid:"t-goaway1",streamId:1}) && has("h2.rst",{rid:"t-goaway1",code:7,emulated:true}) && has("h2.goaway",{connId:find("req",{rid:"t-goaway1"}).connId,lastStreamId:1,emulated:true})'
node_check h2-cancel t-cancel
expect "journal: client RST_STREAM CANCEL → h2.rst by client, res incomplete" \
  'has("h2.rst",{rid:"t-cancel",code:8,by:"client"}) && has("res",{rid:"t-cancel",complete:false,status:200})'

mark
fault '{"kind":"h1_408_on_reuse","match":{"pathPrefix":"/api/r408"}}'
eq "h1_408_on_reuse: 1st request 200, 2nd (reused) 408" \
  "$($CURL --http1.1 -o /dev/null -o /dev/null -w '%{http_code} ' "$API/api/r408?rid=t-408a" "$API/api/r408?rid=t-408b")" "200 408 "
expect "journal: 408 only on the reused request, then the connection closes" '(() => {
  const b = find("req",{rid:"t-408b"});
  return b.reused===true && has("fault",{kind:"h1_408_on_reuse",rid:"t-408b"}) && !has("fault",{rid:"t-408a"})
    && has("res",{rid:"t-408b",status:408,complete:true}) && has("tcp.close",{connId:b.connId}); })()'

mark
fault '{"kind":"resetAfterHeaders","match":{"rid":"t-reset1"}}'
$CURL --http1.1 -o /dev/null "$API/api/x?rid=t-reset1" 2>/dev/null; rc=$?
ok "resetAfterHeaders (h1): no response, connection reset (curl $rc)" [ "$rc" = 56 ]
fault '{"kind":"resetAfterHeaders","match":{"rid":"t-reset2"}}'
$CURL --http2 -o /dev/null "$API/api/x?rid=t-reset2" 2>/dev/null; rc=$?
ok "resetAfterHeaders (h2): no response (curl $rc)" [ "$rc" != 0 ]
expect "journal: req journaled before the reset; res incomplete; tcp.close follows" '(() => {
  const r = find("req",{rid:"t-reset1"}); const f = find("fault",{kind:"resetAfterHeaders",rid:"t-reset1"});
  return r && f && r.seq < f.seq && has("res",{rid:"t-reset1",complete:false,status:null,fault:"resetAfterHeaders"}) && has("tcp.close",{connId:r.connId}) && has("req",{rid:"t-reset2",proto:"h2"}); })()'

fault '{"kind":"delayResponse","ms":700,"match":{"rid":"t-delayf"}}'
ttfb=$($CURL --http2 -o /dev/null -w '%{time_starttransfer}' "$API/api/x?rid=t-delayf")
ok "delayResponse 700: first byte after ≥ 0.7 s ($ttfb s)" ge "$ttfb" 0.7

mark
fault '{"kind":"closeAfterResponse","match":{"rid":"t-close1"}}'
eq "closeAfterResponse (h1): next request needs a new connection" \
  "$($CURL --http1.1 -o /dev/null -o /dev/null -w '%{num_connects} ' "$API/api/x?rid=t-close1" "$API/api/x?rid=t-close2")" "1 1 "
fault '{"kind":"closeAfterResponse","match":{"rid":"t-close3"}}'
# One URL only: a client that reuses the session before it reads the GOAWAY
# loses that request (curl 7.88 reports a framing error) — Chrome retries it.
$CURL --http2 -o /dev/null "$API/api/x?rid=t-close3"
expect "journal: closeAfterResponse — h1 follow-up on a new connection; h2 GOAWAY right after the response" '(() => {
  const c = (rid) => find("req",{rid}).connId; const res = find("res",{rid:"t-close3"});
  const g = find("h2.goaway",{connId:c("t-close3"),by:"server",reason:"closeAfterResponse",lastStreamId:1});
  return c("t-close1")!==c("t-close2") && res && res.complete && g && g.seq > res.seq; })()'
expect "journal: a resumed TLS handshake still gets tls.hello with SNI" '(() => {
  const c = find("req",{rid:"t-close2"}).connId; const s = find("tls.secure",{connId:c});
  return s && s.resumed===true && has("tls.hello",{connId:c,servername:"api.stand.test"}); })()'

mark
fault '{"kind":"tcpDelay","ms":800}'
set -- $($CURL --http2 -o /dev/null -w '%{time_connect} %{time_appconnect}' "$API/api/x?rid=t-tcpdelay")
ok "tcpDelay 800: TCP connects at once ($1 s), TLS done after ≥ 0.75 s ($2 s)" sh -c "$(command -v awk) -v c=$1 -v a=$2 'BEGIN { exit !(c < 0.2 && a - c >= 0.75) }'"
expect "journal: tcpDelay — tls.hello ≥ 800 ms after tcp.accept" '(() => {
  const c = find("req",{rid:"t-tcpdelay"}).connId;
  return has("fault",{kind:"tcpDelay",connId:c,ms:800}) && find("tls.hello",{connId:c}).mono - find("tcp.accept",{connId:c}).mono >= 790; })()'
mark
fault '{"kind":"tlsStall","ms":800,"match":{"host":"api.stand.test"}}'
fast=$($CURL --http2 -o /dev/null -w '%{time_appconnect}' "https://site.stand.test/no-such-page?rid=t-nostall")
ok "tlsStall matches by SNI: site.stand.test not stalled ($fast s)" lt "$fast" 0.3
set -- $($CURL --http2 -o /dev/null -w '%{time_connect} %{time_appconnect}' "$API/api/x?rid=t-tlsstall")
ok "tlsStall 800 on api.stand.test: TLS done after ≥ 0.75 s ($2 s)" sh -c "$(command -v awk) -v c=$1 -v a=$2 'BEGIN { exit !(a - c >= 0.75) }'"
expect "journal: tlsStall — ClientHello journaled at once, tls.secure ≥ 800 ms later" '(() => {
  const c = find("req",{rid:"t-tlsstall"}).connId; const h = find("tls.hello",{connId:c}); const s = find("tls.secure",{connId:c});
  return has("fault",{kind:"tlsStall",connId:c,servername:"api.stand.test"}) && h.mono - find("tcp.accept",{connId:c}).mono < 100 && s.mono - h.mono >= 790; })()'

mark
fault '{"kind":"delayResponse","ms":1,"count":2,"match":{"rid":"t-count"}}'
for i in 1 2 3; do $CURL -o /dev/null "$API/api/x?rid=t-count"; done
expect "count 2: applied to exactly two requests" 'all("fault",{kind:"delayResponse",rid:"t-count"}).length===2 && all("req",{rid:"t-count"}).length===3'
id=$(ctl POST /faults '{"kind":"delayResponse","ms":1,"count":-1,"match":{"rid":"t-forever"}}' | sed 's/.*"id":"\([^"]*\)".*/\1/')
for i in 1 2 3; do $CURL -o /dev/null "$API/api/x?rid=t-forever"; done
contains "count -1: still armed after 3 uses" "$(ctl GET /faults)" "\"id\":\"$id\""
contains "DELETE /faults/<id>" "$(ctl DELETE "/faults/$id")" '"deleted":true'
contains "DELETE /faults/<unknown> → error" "$(ctl DELETE /faults/f999999)" '"error"'
contains "POST /faults with an unknown kind → error" "$(ctl POST /faults '{"kind":"nope"}')" '"error"'
contains "POST /faults delay kind without ms → error" "$(ctl POST /faults '{"kind":"tcpDelay"}')" '"error"'
contains "POST /faults tcpDelay with a match → error (nothing to match before TLS)" "$(ctl POST /faults '{"kind":"tcpDelay","ms":1,"match":{"host":"api.stand.test"}}')" '"error"'
mark
printf 'GET / HTTP/1.1\r\nHost: api.stand.test\r\n\r\n' | curl -sS --max-time 3 -o /dev/null telnet://127.0.0.1:443 2>/dev/null
expect "journal: plain HTTP bytes on :443 → tls.error, no tls.hello" '(() => {
  const e = find("tls.error"); return e && !has("tls.hello",{connId:e.connId}) && has("tcp.close",{connId:e.connId}); })()'
ctl DELETE /faults >/dev/null

# ---------------------------------------------------------------- journal API, errors
section "journal API"
contains "GET /conns lists connections, WebSockets, tunnels" "$(ctl GET /conns)" '"socks":['
M=$START
expect "no server.error during the self-test" '!has("server.error") && !has("h2.error")'
expect "journal: seq strictly increasing, mono non-decreasing" 'evs.every((e, i) => i === 0 || (e.seq === evs[i-1].seq + 1 && e.mono >= evs[i-1].mono))'
page=$(ctl GET "/journal?since=$START&limit=1")
contains "GET /journal?since&limit=1 returns one event and its seq as next" "$page" "\"next\":$((START + 1))"
last=$($NODE mark)
ctl POST /journal/clear >/dev/null
mark
contains "after POST /journal/clear: old events are gone" "$(ctl GET /journal?since=0)" '"events":[]'
ok "after clear: next stays at the last seq ($M = $last)" [ "$M" = "$last" ]

# ---------------------------------------------------------------- summary
passed=$(grep -c '^PASS' "$LOG")
failed=$(grep -c '^FAIL' "$LOG")
echo "== $passed passed, $failed failed"
[ "$failed" -eq 0 ]
