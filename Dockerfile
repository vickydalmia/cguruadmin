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
RUN yarn test

# Compiled into the admin bundle by `strapi build` (STRAPI_ADMIN_* vars are
# inlined), so it MUST be a build argument — setting it on the running
# container is too late and leaves the "view public offer" action pointing at
# nothing. One value per country stack; empty by default so an unset build
# behaves exactly as before. The runtime stage receives the same non-secret
# value as an image default so rich-text classification cannot silently lose
# its first-party domain; an env_file value can still override it.
ARG STRAPI_ADMIN_PUBLIC_SITE_URL=
ENV STRAPI_ADMIN_PUBLIC_SITE_URL=${STRAPI_ADMIN_PUBLIC_SITE_URL}
RUN yarn build

RUN yarn install --production --frozen-lockfile --ignore-scripts

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM node:22-alpine

# `--build-arg` applies to every stage that declares this name. Keeping the
# public URL in the runtime image protects existing India links even when an
# older env file has not yet gained the variable. It is public deployment
# identity, not a secret, and Compose env_file values still take precedence.
ARG STRAPI_ADMIN_PUBLIC_SITE_URL=
ENV STRAPI_ADMIN_PUBLIC_SITE_URL=${STRAPI_ADMIN_PUBLIC_SITE_URL}

RUN apk add --no-cache vips

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

EXPOSE 1337

CMD ["node", "node_modules/@strapi/strapi/bin/strapi.js", "start"]
