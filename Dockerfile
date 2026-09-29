# Production Dockerfile — aligned with Strapi docs
# https://docs.strapi.io/cms/installation/docker

# ---------------------------------------------------------------------------
# Build stage
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

RUN apk update && apk add --no-cache \
  build-base gcc autoconf automake zlib-dev libpng-dev vips-dev git

ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}
ENV STRAPI_TELEMETRY_DISABLED=true

WORKDIR /opt/app

# `patches/` MUST be copied alongside the manifest: the `postinstall` script is
# `patch-package`, which runs as part of the install below and needs the patch
# files to already be on disk. Without this the install silently no-ops, `yarn
# build` compiles the admin from unpatched sources, and the fix in
# patches/@strapi+content-manager+*.patch never reaches production.
COPY package.json yarn.lock ./
COPY patches ./patches
RUN corepack enable && corepack prepare yarn@1.22.22 --activate
RUN yarn config set network-timeout 600000 -g && yarn install --frozen-lockfile --production=false

COPY . .
# The build stage otherwise inherits NODE_ENV=production, which intentionally
# enables runtime throttles. Tests must run in their normal test environment so
# catalogue-scan fixtures do not wait on the production documents-per-second
# limiter. This override applies only to this layer; the build and final image
# remain production.
RUN apk add --no-cache bash && NODE_ENV=test yarn test --maxWorkers=2
RUN yarn build

# Yarn pruning can restore pristine dependency files. Keep patch-package in
# production dependencies and reapply explicitly after the final install.
RUN yarn install --production --frozen-lockfile --ignore-scripts && yarn postinstall

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM node:22-alpine

# postgresql18-client provides pg_dump / pg_restore for the database-backup
# runner (src/database-backup/). The image is country-neutral, so the client
# major MUST be >= the newest PostgreSQL server of ANY country stack (India is
# PG 18; a newer client can dump an older server, never the reverse). The
# version assertion below fails the build if the floating alpine base ever
# drops or downgrades the package.
RUN apk add --no-cache vips postgresql18-client ca-certificates \
  && pg_dump --version | grep -q 'PostgreSQL) 18\.'

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=1337
ENV STRAPI_TELEMETRY_DISABLED=true
ENV HOME=/opt/app

WORKDIR /opt/app

RUN addgroup -g 1001 -S strapi && adduser -u 1001 -S strapi -G strapi

COPY --from=build --chown=strapi:strapi /opt/app ./
RUN mkdir -p .tmp .cache .config \
  && chown strapi:strapi .tmp .cache .config

USER strapi

# Fail the image build if a deployment preflight dependency was excluded.
RUN node deploy/scripts/check-country.cjs --verify-package

EXPOSE 1337

CMD ["node", "node_modules/@strapi/strapi/bin/strapi.js", "start"]
