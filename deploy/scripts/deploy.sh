#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# deploy.sh — pull and deploy Strapi on the droplet
#
# Usage:
#   ./deploy.sh                          # deploy latest tag
#   ./deploy.sh v1.2.0                   # deploy a specific release tag
#   ./deploy.sh sha-abc123               # deploy a specific commit
#
# Prerequisites:
#   - docker and docker compose installed
#   - logged into ghcr.io (docker login ghcr.io)
#   - docker.compose.yml in the current directory
#   - .env.production in the current directory
###############################################################################

COMPOSE_FILE="${COMPOSE_FILE:-docker.compose.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
HEALTH_ATTEMPTS=24
HEALTH_INTERVAL=5

log() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; }

# ── Preflight checks ────────────────────────────────────────────────────────

if [ ! -f "${COMPOSE_FILE}" ]; then
  err "${COMPOSE_FILE} not found in $(pwd)"
  exit 1
fi

if [ ! -f "${ENV_FILE}" ]; then
  err "${ENV_FILE} not found in $(pwd)"
  exit 1
fi

read_env() {
  local key="$1"
  # Strip CR (CRLF files) and surrounding quotes so values like
  # APP_IMAGE="ghcr.io/..." or Windows-edited env files don't corrupt the
  # compose image ref / health-check URL.
  grep -E "^${key}=" "${ENV_FILE}" | tail -n 1 | cut -d= -f2- \
    | tr -d '\r' | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" || true
}

compose() {
  docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

# ── Read image name from env file or shell ───────────────────────────────────

if [ -z "${APP_IMAGE:-}" ]; then
  APP_IMAGE=$(read_env APP_IMAGE)
fi

if [ -z "${APP_IMAGE:-}" ]; then
  err "APP_IMAGE is not set. Export it or add it to ${ENV_FILE}"
  err "  export APP_IMAGE=ghcr.io/owner/repo"
  exit 1
fi

# ── Determine tag ────────────────────────────────────────────────────────────

if [ -z "${APP_IMAGE_TAG:-}" ]; then
  APP_IMAGE_TAG=$(read_env APP_IMAGE_TAG)
fi

TAG="${1:-${APP_IMAGE_TAG:-latest}}"
APP_PORT="${APP_PORT:-$(read_env APP_PORT)}"
APP_PORT="${APP_PORT:-1337}"

log "Image:  ${APP_IMAGE}"
log "Tag:    ${TAG}"
log "Env:    ${ENV_FILE}"

export APP_IMAGE
export APP_IMAGE_TAG="${TAG}"
export ENV_FILE

compose config -q
log "Compose config valid"

# ── Pull ─────────────────────────────────────────────────────────────────────

log "Pulling ${APP_IMAGE}:${TAG} ..."
compose pull strapi

# ── Deploy ───────────────────────────────────────────────────────────────────

log "Starting container ..."
compose up -d --remove-orphans strapi

# ── Health check ─────────────────────────────────────────────────────────────

log "Waiting for healthy (max $(( HEALTH_ATTEMPTS * HEALTH_INTERVAL ))s) ..."

ATTEMPTS=${HEALTH_ATTEMPTS}
while [ "${ATTEMPTS}" -gt 0 ]; do
  CONTAINER_ID=$(compose ps -q strapi 2>/dev/null || true)

  if [ -n "${CONTAINER_ID}" ]; then
    STATUS=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${CONTAINER_ID}" 2>/dev/null || echo "unknown")
    if [ "${STATUS}" = "healthy" ]; then
      log "Container is healthy"
      break
    fi
    log "Status: ${STATUS}  (${ATTEMPTS} attempts left)"
  fi

  ATTEMPTS=$(( ATTEMPTS - 1 ))
  sleep "${HEALTH_INTERVAL}"
done

# ── Final check ──────────────────────────────────────────────────────────────

CONTAINER_ID=$(compose ps -q strapi)
FINAL=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${CONTAINER_ID}")

if [ "${FINAL}" != "healthy" ]; then
  err "Container did not become healthy. Last status: ${FINAL}"
  err "Recent logs:"
  compose logs --tail=100 strapi
  exit 1
fi

# ── Verify health endpoint ──────────────────────────────────────────────────

HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${APP_PORT}/_health" 2>/dev/null || echo "000")
if [ "${HTTP_CODE}" = "204" ]; then
  log "Health endpoint returned 204"
else
  err "Health endpoint returned ${HTTP_CODE} (expected 204)"
fi

# ── Cleanup ──────────────────────────────────────────────────────────────────

docker image prune -af --filter "until=168h" 2>/dev/null || true

# ── Done ─────────────────────────────────────────────────────────────────────

log "Deployed ${APP_IMAGE}:${TAG} successfully"
compose ps
