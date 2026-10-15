#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || { printf 'Run this script with sudo.\n' >&2; exit 1; }
target=/etc/resolver/aria.yoyo.io
expected='nameserver 20.0.0.3
port 53
search_order 1'
if [ -e "$target" ]; then
  [ "$(cat "$target")" = "$expected" ] || {
    printf 'The resolver rule differs from the one we installed; leaving it unchanged.\n' >&2
    exit 1
  }
  /bin/rm "$target"
fi
/usr/bin/dscacheutil -flushcache
/usr/bin/killall -HUP mDNSResponder
printf 'Removed the CV preview override. The router can resolve your Aria machine again.\n'
