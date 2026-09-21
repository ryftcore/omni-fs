#!/bin/sh
# Three listeners, one container, started as siblings of this shell.
#
# The obvious shape — background two instances and `exec` the third — segfaults.
# vsftpd's listener dies with SIGSEGV a moment after its first TLS session if it
# has a child process it did not fork itself, and backgrounding the other two
# makes them exactly that; one unrelated `sleep` is enough to reproduce it, so
# it is the foreign child rather than anything about running vsftpd three times.
# Keeping this shell as pid 1 keeps each instance's children its own. The trap
# and the watch loop below are what `exec` would otherwise have bought: a
# `docker compose down` that is prompt, and a container that stops rather than
# quietly serving two listeners out of three.
set -e

mkdir -p /var/run/vsftpd/empty

# All three instances append to one log file; tailing it is what puts their
# output in `docker compose logs ftp` (see vsftpd-common.conf for why the log
# cannot simply be /dev/stdout).
: > /var/log/vsftpd.log
tail -F /var/log/vsftpd.log &
logger=$!

vsftpd /etc/vsftpd/explicit.conf &
explicit=$!
vsftpd /etc/vsftpd/implicit.conf &
implicit=$!
OPENSSL_CONF=/etc/vsftpd/openssl-legacy.cnf vsftpd /etc/vsftpd/legacy.conf &
legacy=$!

stop() {
  kill "$logger" "$explicit" "$implicit" "$legacy" 2>/dev/null || true
}

trap 'stop; exit 0' TERM INT

# busybox ash's `wait -n` returns 129 immediately here rather than blocking, so
# liveness is polled instead. The sleep runs in the background and is waited on
# so that a TERM interrupts it at once instead of up to two seconds later.
while kill -0 "$explicit" "$implicit" "$legacy" 2>/dev/null; do
  sleep 2 &
  wait "$!"
done

echo 'a vsftpd instance exited; stopping the container' >&2
stop
exit 1
