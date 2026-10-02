#!/bin/sh
set -e

DATA_ROOT="${BLOG_DATA_ROOT:-/var/lib/guanlan/data}"
SECRET_ROOT="${BLOG_SECRET_ROOT:-/var/lib/guanlan/secrets}"
BUILD_ROOT="${BLOG_BUILD_ROOT:-/var/lib/guanlan/build}"

mkdir -p "$DATA_ROOT" "$SECRET_ROOT" "$BUILD_ROOT"

# Host bind mounts may arrive with root ownership. Fix only mount-root ownership;
# never recursively rewrite production contents or delete/recreate the data root.
for root in "$DATA_ROOT" "$SECRET_ROOT" "$BUILD_ROOT"; do
    if ! su-exec nextjs test -w "$root" 2>/dev/null; then
        chown nextjs:nodejs "$root"
    fi
    chmod 700 "$root"
done

# Container-owned storage children are created only after dropping root privileges.
su-exec nextjs mkdir -p \
    "$DATA_ROOT/articles" "$DATA_ROOT/navigation" "$DATA_ROOT/settings" "$DATA_ROOT/media"

chmod 700 "$SECRET_ROOT"
exec su-exec nextjs "$@"
