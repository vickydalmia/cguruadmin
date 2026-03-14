FROM node:24-bookworm-slim AS base

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /opt/app

RUN corepack enable && corepack prepare yarn@1.22.22 --activate

# ---------------------------------------------------------------------------
# Build stage — install all deps (including dev), compile native addons, build
# ---------------------------------------------------------------------------
FROM base AS build

ENV NODE_ENV=development
ENV STRAPI_TELEMETRY_DISABLED=true

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .
RUN NODE_ENV=production yarn build

# Prune dev dependencies — native addons are already compiled above
RUN yarn install --production --frozen-lockfile --ignore-scripts

# ---------------------------------------------------------------------------
# Runtime stage — lean image, custom non-root user, production deps only
# ---------------------------------------------------------------------------
FROM base AS runtime

ARG STRAPI_UID=1001
ARG STRAPI_GID=1001

RUN groupadd -g "${STRAPI_GID}" strapi \
  && useradd -u "${STRAPI_UID}" -g strapi -m -s /bin/sh strapi

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=1337
ENV STRAPI_TELEMETRY_DISABLED=true

COPY --from=build --chown=strapi:strapi /opt/app/package.json ./
COPY --from=build --chown=strapi:strapi /opt/app/yarn.lock ./
COPY --from=build --chown=strapi:strapi /opt/app/node_modules ./node_modules
COPY --from=build --chown=strapi:strapi /opt/app/dist ./dist
COPY --from=build --chown=strapi:strapi /opt/app/build ./build
COPY --from=build --chown=strapi:strapi /opt/app/config ./config
COPY --from=build --chown=strapi:strapi /opt/app/database ./database
COPY --from=build --chown=strapi:strapi /opt/app/public ./public
COPY --from=build --chown=strapi:strapi /opt/app/src ./src
COPY --from=build --chown=strapi:strapi /opt/app/favicon.png ./favicon.png
COPY --from=build --chown=strapi:strapi /opt/app/types ./types

RUN mkdir -p /opt/app/.tmp /opt/app/.cache \
  && chown -R strapi:strapi /opt/app

USER strapi

EXPOSE 1337

CMD ["yarn", "start"]
