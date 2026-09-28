#!/usr/bin/env bash
# TEMPORARY measurement aid (removed before merge): whole-VM CPU busy %, load,
# runner memory slice and pressure every 2 s.
cg="/sys/fs/cgroup/user.slice/user-$(id -u).slice"
read -r _ u n s i w x y z _ < /proc/stat
pt=$((u+n+s+i+w+x+y+z)); pi=$((i+w))
while :; do
  sleep 2
  read -r _ u n s i w x y z _ < /proc/stat
  t=$((u+n+s+i+w+x+y+z)); id=$((i+w))
  busy=$(( 100 * ((t-pt) - (id-pi)) / (t-pt) )); pt=$t; pi=$id
  printf '%s busy=%s%% load=%s mem=%sM cpu_psi=%s mem_psi=%s\n' "$(date +%T)" "$busy" \
    "$(cut -d' ' -f1,4 /proc/loadavg | tr ' ' ,)" "$(( $(cat "$cg/memory.current" 2>/dev/null || echo 0) / 1048576 ))" \
    "$(awk 'NR==1{print $2}' /proc/pressure/cpu 2>/dev/null)" "$(awk 'NR==1{print $2}' /proc/pressure/memory 2>/dev/null)"
done
