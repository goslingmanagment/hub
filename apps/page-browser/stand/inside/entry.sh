#!/bin/sh
# The stand's entry in front of the page image's /init (page.stand.yml). The
# image is production's, untouched; this only prepares its container for
# the stand, as root, before s6 starts anything:
#
#  1. An on-link default route over the egress network. The stand's networks
#     are internal: they give no default route, so every destination outside
#     them would fail with ENETUNREACH before the page's own egress rules
#     (init-net) see it, and net-selftest rightly takes that for no proof
#     (stage 2 finding 2). With the route the rules refuse it themselves;
#     whatever they let through stays on the internal segment, where only
#     the stand's SOCKS5 answers. Production's pb-egress has a gateway.
#  2. Chrome trusts the stand's CA: the NSS database the stand's Fansly made
#     (fansly/certs.ts) goes to pb-chrome's ~/.pki/nssdb, where Chrome on
#     Linux takes extra roots from. The stand serves Fansly's own names
#     (fansly.com, apiv3, wsv3, cdn*) with a certificate of that CA.
#  3. The operator's Node trusts it too, for its exit-IP check (TLS to
#     api.ipify.org through the SOCKS5): NODE_EXTRA_CA_CERTS is added to the
#     operator's run script, which starts it with `env -i`. Nothing else of
#     the script changes; if its line is not there, the stand stops here.
#
# busybox (`ip`, `awk`) comes from the stand's tools volume: the page image
# has no iproute2, and must not get it for the stand.
set -eu
B=/stand/tools/busybox
CA=/stand/ca
fail() {
  echo "stand-entry: $*" >&2
  exit 1
}

i=0
while [ ! -s "$CA/ca.crt" ] || [ ! -s "$CA/nssdb/cert9.db" ] || [ ! -x "$B" ]; do
  i=$((i + 1))
  [ "$i" -le 120 ] || fail "no stand CA or tools after 60 s"
  sleep 0.5
done

# shellcheck disable=SC2016
dev="$("$B" ip -o -4 addr show | "$B" awk -v ip="${STAND_EGRESS_IP:?}" 'index($4, ip "/") == 1 { print $2 }')"
[ -n "$dev" ] || fail "no interface with $STAND_EGRESS_IP"
"$B" ip route replace default dev "$dev"

install -d -o pb-chrome -g pb-chrome -m 700 /home/pb-chrome/.pki
rm -rf /home/pb-chrome/.pki/nssdb
cp -R "$CA/nssdb" /home/pb-chrome/.pki/nssdb
chown -R pb-chrome:pb-chrome /home/pb-chrome/.pki/nssdb
chmod 700 /home/pb-chrome/.pki/nssdb
chmod 600 /home/pb-chrome/.pki/nssdb/*

RUN=/etc/s6-overlay/s6-rc.d/operator/run
LINE='exec env -i HOME=/home/pb-operator '
if ! grep -q "NODE_EXTRA_CA_CERTS=$CA/ca.crt" "$RUN"; then
  grep -q "^$LINE" "$RUN" || fail "the operator's run script has no '$LINE' line any more"
  sed -i "s|^$LINE|exec env -i NODE_EXTRA_CA_CERTS=$CA/ca.crt HOME=/home/pb-operator |" "$RUN"
fi
grep -q "NODE_EXTRA_CA_CERTS=$CA/ca.crt HOME=/home/pb-operator" "$RUN" || fail "the operator's run script did not take the stand's CA"

echo "stand-entry: default route on $dev; the stand's CA for Chrome and the operator" >&2
exec /init
