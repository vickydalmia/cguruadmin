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
RENDER_PORT="${RENDER_PORT:-$(read_env RENDER_PORT)}"
RENDER_PORT="${RENDER_PORT:-1338}"
# All Strapi roles share one image and env file: `strapi` keeps the admin
# panel + dispatchers, `strapi-render` serves render traffic, and the
# CPU-limited `strapi-maintenance` process claims catalogue scans. Order
# matters at startup — see the deploy section below.
ADMIN_SERVICE="strapi"
RENDER_SERVICE="strapi-render"
MAINTENANCE_SERVICE="strapi-maintenance"
SERVICES="${ADMIN_SERVICE} ${RENDER_SERVICE} ${MAINTENANCE_SERVICE}"
# APP_BIND (the extra VPC-private-IP publish) is read straight from ${ENV_FILE}
# by `docker compose --env-file` interpolation — the compose `:?` guard aborts
# the deploy if it is missing — so deploy.sh does not need to handle it here.

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
compose pull ${SERVICES}

# ── Health helpers ───────────────────────────────────────────────────────────

container_status() {
  local service="$1"
  local container_id
  container_id=$(compose ps -q "${service}" 2>/dev/null || true)
  if [ -z "${container_id}" ]; then
    echo "missing"
    return
  fi
  docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${container_id}" 2>/dev/null || echo "unknown"
}

wait_for_healthy() {
  local service="$1"
  local attempts=${HEALTH_ATTEMPTS}
  local status

  log "Waiting for ${service} (max $(( HEALTH_ATTEMPTS * HEALTH_INTERVAL ))s) ..."
  while [ "${attempts}" -gt 0 ]; do
    status=$(container_status "${service}")
    if [ "${status}" = "healthy" ]; then
      log "${service} is healthy"
      return 0
    fi
    log "${service}: ${status}  (${attempts} attempts left)"
    attempts=$(( attempts - 1 ))
    sleep "${HEALTH_INTERVAL}"
  done

  status=$(container_status "${service}")
  err "${service} did not become healthy. Last status: ${status}"
  err "Recent logs:"
  compose logs --tail=100 "${service}"
  exit 1
}

# ── Deploy ───────────────────────────────────────────────────────────────────

# Start SEQUENTIALLY, admin first. Every Strapi boot runs schema sync plus the
# reconciliation steps in src/index.ts bootstrap; two processes doing that at
# once race on DDL that is not all lock-guarded (e.g. the check-then-
# createTable in database/site-selection-reconciliation.js). Letting the admin
# container finish first means the other roles boot against an already
# reconciled schema and their own reconcilers become no-ops.
# No --remove-orphans here: combined with a single-service `up` its scope has
# differed across Compose versions, and removing the sibling container mid
# deploy is not worth the hygiene. Run `docker compose ... down
# --remove-orphans` by hand if a service is ever renamed or dropped.
# All retained callback state must die before replacement workers start.
# Compose bounds graceful shutdown and then stops only these worker roles.
# Durable rows/checkpoints survive; the old read role remains available.
log "Pausing background roles (at most 60s graceful shutdown) ..."
compose stop --timeout 60 "${MAINTENANCE_SERVICE}" "${ADMIN_SERVICE}"

log "Starting ${ADMIN_SERVICE} ..."
compose up -d --force-recreate --timeout 60 "${ADMIN_SERVICE}"
wait_for_healthy "${ADMIN_SERVICE}"

log "Starting ${RENDER_SERVICE} ..."
compose up -d --force-recreate --timeout 60 "${RENDER_SERVICE}"
wait_for_healthy "${RENDER_SERVICE}"

log "Starting ${MAINTENANCE_SERVICE} ..."
compose up -d --force-recreate --timeout 60 "${MAINTENANCE_SERVICE}"
wait_for_healthy "${MAINTENANCE_SERVICE}"

# ── Verify health endpoints ─────────────────────────────────────────────────

for PORT in "${APP_PORT}" "${RENDER_PORT}"; do
  HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/_health" 2>/dev/null || echo "000")
  if [ "${HTTP_CODE}" = "204" ]; then
    log "Health endpoint on :${PORT} returned 204"
  else
    err "Health endpoint on :${PORT} returned ${HTTP_CODE} (expected 204)"
  fi
done

ISR_SECRET=$(read_env ISR_ADMIN_SECRET)
ISR_STATUS_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${ISR_SECRET}" \
  "http://127.0.0.1:${APP_PORT}/api/isr/status" 2>/dev/null || echo "000")
if [ "${ISR_STATUS_CODE}" = "200" ]; then
  log "ISR outbox status is healthy"
else
  err "ISR outbox status returned ${ISR_STATUS_CODE} (expected 200)"
  compose logs --tail=100 strapi
  exit 1
fi

# ── Cleanup ──────────────────────────────────────────────────────────────────

docker image prune -af --filter "until=168h" 2>/dev/null || true

# ── Done ─────────────────────────────────────────────────────────────────────

log "Deployed ${APP_IMAGE}:${TAG} successfully"
compose ps
