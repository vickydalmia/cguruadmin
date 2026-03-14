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
#   - compose.prod.yml in the current directory
#   - .env.production in the current directory
###############################################################################

COMPOSE_FILE="compose.prod.yml"
HEALTH_ATTEMPTS=24
HEALTH_INTERVAL=5

log() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; }

# ── Read image name from compose or env ──────────────────────────────────────

if [ -z "${APP_IMAGE:-}" ]; then
  if [ -f ".env.production" ]; then
    APP_IMAGE=$(grep -E '^APP_IMAGE=' .env.production | cut -d= -f2- || true)
  fi
fi

if [ -z "${APP_IMAGE:-}" ]; then
  err "APP_IMAGE is not set. Export it or add it to .env.production"
  err "  export APP_IMAGE=ghcr.io/owner/repo"
  exit 1
fi

# ── Determine tag ────────────────────────────────────────────────────────────

TAG="${1:-${APP_IMAGE_TAG:-latest}}"

log "Image:  ${APP_IMAGE}"
log "Tag:    ${TAG}"

# ── Preflight checks ────────────────────────────────────────────────────────

if [ ! -f "${COMPOSE_FILE}" ]; then
  err "${COMPOSE_FILE} not found in $(pwd)"
  exit 1
fi

if [ ! -f ".env.production" ]; then
  err ".env.production not found in $(pwd)"
  exit 1
fi

export APP_IMAGE
export APP_IMAGE_TAG="${TAG}"

docker compose -f "${COMPOSE_FILE}" config -q
log "Compose config valid"

# ── Pull ─────────────────────────────────────────────────────────────────────

log "Pulling ${APP_IMAGE}:${TAG} ..."
docker compose -f "${COMPOSE_FILE}" pull strapi

# ── Deploy ───────────────────────────────────────────────────────────────────

log "Starting container ..."
docker compose -f "${COMPOSE_FILE}" up -d --remove-orphans strapi

# ── Health check ─────────────────────────────────────────────────────────────

log "Waiting for healthy (max $(( HEALTH_ATTEMPTS * HEALTH_INTERVAL ))s) ..."

ATTEMPTS=${HEALTH_ATTEMPTS}
while [ "${ATTEMPTS}" -gt 0 ]; do
  CONTAINER_ID=$(docker compose -f "${COMPOSE_FILE}" ps -q strapi 2>/dev/null || true)

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

CONTAINER_ID=$(docker compose -f "${COMPOSE_FILE}" ps -q strapi)
FINAL=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${CONTAINER_ID}")

if [ "${FINAL}" != "healthy" ]; then
  err "Container did not become healthy. Last status: ${FINAL}"
  err "Recent logs:"
  docker compose -f "${COMPOSE_FILE}" logs --tail=100 strapi
  exit 1
fi

# ── Verify health endpoint ──────────────────────────────────────────────────

HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:1337/_health 2>/dev/null || echo "000")
if [ "${HTTP_CODE}" = "204" ]; then
  log "Health endpoint returned 204"
else
  err "Health endpoint returned ${HTTP_CODE} (expected 204)"
fi

# ── Cleanup ──────────────────────────────────────────────────────────────────

docker image prune -af --filter "until=168h" 2>/dev/null || true

# ── Done ─────────────────────────────────────────────────────────────────────

log "Deployed ${APP_IMAGE}:${TAG} successfully"
docker compose -f "${COMPOSE_FILE}" ps
