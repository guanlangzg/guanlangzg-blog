#!/bin/sh
# Update the image without modifying the deployment environment or persistent host data.
set -eu

APP_DIR="${APP_DIR:-/opt/guanlangzg-blog}"
COMPOSE_FILE="${COMPOSE_FILE:-${APP_DIR}/compose.prod.yaml}"
PREVIOUS_TAG="guanlangzg-blog:previous"
ACTION="${1:-update}"

cd "${APP_DIR}"

if [ ! -f "${COMPOSE_FILE}" ]; then
    echo "Missing ${COMPOSE_FILE}; refusing to continue." >&2
    exit 1
fi

rollback() {
    if ! docker image inspect "${PREVIOUS_TAG}" >/dev/null 2>&1; then
        echo "[update] rollback unavailable: no previous image tag was recorded" >&2
        return 1
    fi

    echo "[update] rollback: starting ${PREVIOUS_TAG}"
    DEPLOY_IMAGE="${PREVIOUS_TAG}" docker compose -f "${COMPOSE_FILE}" up -d app
    echo "[update] rollback finished. Persistent data, secrets and .env were not modified."
}

if [ "${ACTION}" = "rollback" ]; then
    rollback
    exit $?
fi
if [ "${ACTION}" != "update" ] || [ "$#" -gt 1 ]; then
    echo "Usage: $0 [update|rollback]" >&2
    exit 2
fi

DEPLOY_IMAGE="${DEPLOY_IMAGE:?Set DEPLOY_IMAGE to the reviewed image reference}"

# Keep the currently deployed image locally before pulling or replacing it.
CURRENT_IMAGE="$(docker compose -f "${COMPOSE_FILE}" images -q app 2>/dev/null || true)"
if [ -n "${CURRENT_IMAGE}" ]; then
    echo "[update] tagging current image as ${PREVIOUS_TAG}"
    docker tag "${CURRENT_IMAGE}" "${PREVIOUS_TAG}"
fi

echo "[update] pulling ${DEPLOY_IMAGE}"
if ! DEPLOY_IMAGE="${DEPLOY_IMAGE}" docker compose -f "${COMPOSE_FILE}" pull app; then
    echo "[update] pull failed; the running container and persistent data were left unchanged" >&2
    exit 1
fi

if ! DEPLOY_IMAGE="${DEPLOY_IMAGE}" docker compose -f "${COMPOSE_FILE}" up -d app; then
    echo "[update] starting the new image failed; attempting rollback" >&2
    rollback || true
    exit 1
fi

# Check only process liveness. Remote GitHub/R2 outages are readiness issues and
# must not trigger an image rollback or restart loop.
HEALTHY=0
for attempt in 1 2 3 4 5 6; do
    if docker compose -f "${COMPOSE_FILE}" exec -T app curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
        HEALTHY=1
        break
    fi
    echo "[update] health check attempt ${attempt} failed; retrying in 5s"
    sleep 5
done

if [ "${HEALTHY}" -ne 1 ]; then
    echo "[update] new image is unhealthy; rolling back" >&2
    rollback || true
    exit 1
fi

# A degraded readiness response may be caused by a transient upstream outage.
docker compose -f "${COMPOSE_FILE}" exec -T app curl -fsS http://127.0.0.1:3000/api/ready >/dev/null 2>&1 \
    || echo "[update] readiness is degraded; inspect local storage/config and remote backup connectivity"

echo "[update] done. Previous image retained as ${PREVIOUS_TAG}; run '$0 rollback' to restore it."
