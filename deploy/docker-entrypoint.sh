#!/bin/sh
set -e

DATA_ROOT="${BLOG_DATA_ROOT:-/var/lib/guanlan/data}"
SECRET_ROOT="${BLOG_SECRET_ROOT:-/var/lib/guanlan/secrets}"
BUILD_ROOT="${BLOG_BUILD_ROOT:-/var/lib/guanlan/build}"

mkdir -p "$DATA_ROOT" "$SECRET_ROOT" "$BUILD_ROOT"

# Host bind mounts may arrive root-owned. Only the mount root is touched (never the
# contents), and it is restricted BEFORE the write probe: a root-owned mount that is
# merely group-writable passes the probe, and restricting it afterwards would take
# that access away again, so the app user could not create its storage children.
for root in "$DATA_ROOT" "$SECRET_ROOT" "$BUILD_ROOT"; do
    chmod 700 "$root"
    if ! su-exec nextjs test -w "$root" 2>/dev/null; then
        chown nextjs:nodejs "$root"
    fi
done

# Container-owned storage children are created only after dropping root privileges.
su-exec nextjs mkdir -p \
    "$DATA_ROOT/articles" "$DATA_ROOT/navigation" "$DATA_ROOT/settings" "$DATA_ROOT/media"

exec su-exec nextjs "$@"
