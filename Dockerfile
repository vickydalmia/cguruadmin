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

COPY package.json yarn.lock ./
RUN corepack enable && corepack prepare yarn@1.22.22 --activate
RUN yarn config set network-timeout 600000 -g && yarn install --frozen-lockfile

COPY . .
RUN yarn build

RUN yarn install --production --frozen-lockfile --ignore-scripts

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM node:22-alpine

RUN apk add --no-cache vips

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=1337
ENV STRAPI_TELEMETRY_DISABLED=true
ENV HOME=/opt/app

WORKDIR /opt/app

RUN addgroup -g 1001 -S strapi && adduser -u 1001 -S strapi -G strapi

COPY --from=build --chown=strapi:strapi /opt/app/package.json ./
COPY --from=build --chown=strapi:strapi /opt/app/yarn.lock ./
COPY --from=build --chown=strapi:strapi /opt/app/node_modules ./node_modules
COPY --from=build --chown=strapi:strapi /opt/app/dist ./dist
COPY --from=build --chown=strapi:strapi /opt/app/dist/config ./config
COPY --from=build --chown=strapi:strapi /opt/app/database ./database
COPY --from=build --chown=strapi:strapi /opt/app/public ./public
COPY --from=build --chown=strapi:strapi /opt/app/src ./src
COPY --from=build --chown=strapi:strapi /opt/app/favicon.png ./
COPY --from=build --chown=strapi:strapi /opt/app/types ./types

RUN mkdir -p .tmp .cache .config && chown -R strapi:strapi /opt/app

USER strapi

EXPOSE 1337

CMD ["node", "node_modules/@strapi/strapi/bin/strapi.js", "start"]
