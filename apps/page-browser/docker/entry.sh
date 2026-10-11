#!/bin/sh
# Root init of the page container (plan §3.1 `init-net`), PROTOTYPE:
#  1. egress rules: Chrome may reach only the operator's local proxy, the
#     operator only the page's SOCKS5; everything else is dropped by the
#     kernel (plan §4.5). They are in place before any process starts.
#  2. the stand's test CA in pb-chrome's NSS database (stand only).
#  3. the supervisor.
set -eu

SOCKS_HOST="${PB_SOCKS_HOST:?PB_SOCKS_HOST is required}"
SOCKS_PORT="${PB_SOCKS_PORT:-1080}"
RPC_PORT="${PB_RPC_PORT:-7700}"
RPC_FROM="${PB_RPC_FROM:-127.0.0.1}"
SOCKS_IP=$(getent ahostsv4 "$SOCKS_HOST" | awk 'NR==1{print $1}')
[ -n "$SOCKS_IP" ] || { echo "cannot resolve $SOCKS_HOST" >&2; exit 1; }
echo "$SOCKS_IP" > /run/socks-ip

nft -f - <<EOF
flush ruleset
table inet pb {
  chain output {
    type filter hook output priority 0; policy drop;
    ct state established,related accept
    oif lo meta skuid pb-chrome tcp dport 3128 accept
    oif lo meta skuid pb-operator tcp dport ${PB_CDP_PORT:-9222} accept
    meta skuid pb-operator ip daddr $SOCKS_IP tcp dport $SOCKS_PORT accept
    oif lo meta skuid root accept
  }
  chain input {
    type filter hook input priority 0; policy drop;
    iif lo accept
    ct state established,related accept
    ip saddr $RPC_FROM tcp dport $RPC_PORT accept
    ip saddr ${PB_VNC_FROM:-127.0.0.1} tcp dport ${PB_VNC_PORT:-6901} accept
  }
}
EOF

# The page's languages (plan §4.1 step 2): a policy of this page, next to the
# image's own policy file.
if [ -n "${PB_LANG:-}" ]; then
  base="${PB_LANG%%-*}"
  if [ "$base" = "$PB_LANG" ]; then langs="\"$PB_LANG\""; else langs="\"$PB_LANG\", \"$base\""; fi
  printf '{ "ForcedLanguages": [%s] }\n' "$langs" > /etc/opt/chrome/policies/managed/page.json
fi

# Stand: the stand server writes its CA on first start.
if [ "${PB_WAIT_CA:-0}" = "1" ]; then
  i=0; while [ ! -s /stand/ca/ca.pem ] && [ $i -lt 60 ]; do sleep 0.5; i=$((i+1)); done
fi
if [ -f /stand/ca/ca.pem ]; then
  install -d -o pb-chrome -g pb-chrome -m 700 /home/pb-chrome/.pki /home/pb-chrome/.pki/nssdb
  # A restarted container keeps the database: create it only once (on an
  # existing one `certutil -N` waits for a password on stdin).
  HOME=/home/pb-chrome setpriv --reuid=pb-chrome --regid=pb-chrome --init-groups sh -c '
    [ -f $HOME/.pki/nssdb/cert9.db ] || certutil -d sql:$HOME/.pki/nssdb -N --empty-password </dev/null
    certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n pb-stand-ca -i /stand/ca/ca.pem </dev/null' </dev/null
  export NODE_EXTRA_CA_CERTS=/stand/ca/ca.pem
fi

# A restarted container keeps /tmp: drop the old display's lock and socket.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 /run/pb/*.sock /run/pb/operator.alive
exec node --no-warnings /opt/page-browser/src/supervisor/main.ts
