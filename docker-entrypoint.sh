#!/bin/sh
# Make the data directory the server's, then run the server without root.
# /data is usually a bind mount owned by whoever created it on the host, which
# the unprivileged user couldn't write to.
set -eu
if [ "$(id -u)" = "0" ]; then
    mkdir -p /data/run
    # Everything except the seed (which may be mounted read-only).
    find /data -path /data/seed -prune -o ! -user yogos -exec chown yogos:yogos {} +
    exec setpriv --reuid=yogos --regid=yogos --init-groups "$@"
fi
exec "$@"
