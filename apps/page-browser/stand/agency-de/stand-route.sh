#!/stand/busybox sh
# The stand's entry in front of PR 2's /init (stand.sh image-check). The
# stand's networks are internal: they give a container no default route, so
# every destination outside them fails with ENETUNREACH before the page's
# egress rules see it, and net-selftest rightly takes that for no proof. An
# on-link default route over the egress network gives the rules something
# to refuse; whatever they let through stays on that internal segment,
# where nothing answers. Production's pb-egress has a gateway instead.
set -eu
B=/stand/busybox
dev="$($B ip -o -4 addr show | $B awk -v ip="$STAND_EGRESS_IP" 'index($4, ip "/") == 1 { print $2 }')"
[ -n "$dev" ] || { echo "stand-route: no interface with $STAND_EGRESS_IP" >&2; exit 1; }
$B ip route add default dev "$dev"
echo "stand-route: default dev $dev" >&2
exec /init
