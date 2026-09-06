# Strapi Production Deployment

This is the Strapi-specific production runbook for CouponzGuru. It covers the
CMS container, PostgreSQL, S3 media, the persistent-ISR transactional outbox,
the production environment file, deployment verification, and rollback.

The Strapi CMS is deployed before the Astro/Fastify frontend. The existing
public UI may continue serving while Strapi is replaced. Avoid publishing
content until the Fastify gateway is available because outbox delivery will
retry, but the public HTML cannot regenerate until the gateway is running.

Do not use `yarn strapi deploy`. Production is deployed through an immutable
GHCR image and the checked-in Docker Compose deployment.

## Remove legacy environment variables

Delete the following variables from the production Strapi environment. They
belonged to the old static rebuild, build-hook, CloudFront invalidation, or
legacy redeem-invalidation architecture and are not read by the current
runtime:

```text
BUILD_HOOK_URL
CLOUDFRONT_DISTRIBUTION_ID
FRONTEND_DIR
ISR_REVALIDATE_SECRET
REBUILD_DEBOUNCE_MS
REBUILD_ENABLED
REBUILD_FULL_THRESHOLD
REBUILD_HTML_TTL
REBUILD_MAX_RETRIES
REBUILD_MAX_WAIT_MS
REBUILD_MODE
REBUILD_POST_TIMEOUT_MS
REDEEM_INVALIDATE_TIMEOUT_MS
SITE_BUCKET
STRAPI_MEDIA_URL
STRAPI_ADMIN_PUBLIC_SITE_URL
```

These old S3 options are also unsupported by the current upload-provider
configuration and should be removed:

```text
S3_ACL
S3_ENCRYPTION_TYPE
S3_ENDPOINT
S3_KMS_KEY_ID
S3_OBJECT_TAG_APPLICATION
S3_SIGNED_URL_EXPIRES
```

Do not copy any old rebuild or deployment environment file into the new
deployment. Start from the current `.env.example` or the complete production
file in this document.

`DATABASE_FILENAME` is supported only for disposable local SQLite development.
Remove it from production.

`COMPOSE_FILE` and `ENV_FILE` are optional shell variables accepted by
`deploy.sh`. They are not Strapi runtime variables and normally should not be
stored in `.env.production`.

## Deployment order

1. Publish an immutable CMS image.
2. Back up PostgreSQL and verify that the backup is readable.
3. Prepare the CMS host and production environment.
4. Validate the Compose configuration.
5. Replace Strapi.
6. Verify migrations, health, S3, admin, APIs, and the ISR outbox.
7. Deploy the frontend gateway using the same `ISR_ADMIN_SECRET`.
8. Resume publishing after the gateway and outbox delivery are healthy.

If an old and a new Strapi instance share PostgreSQL, enable
`CRON_ENABLED=true` on exactly one instance. Prefer an in-place replacement
instead of running two production schedulers.

### Multi-country/Country Setup release note

The Site Configuration table and entity `page_template` columns are additive.
For India, the migration defaults existing entities to `default` and backfills
the two legacy campaign owners. Older application images ignore these columns,
so rollback does not require dropping them.

Deploying the CMS contract before the matching UI remains the preferred order.
The reverse overlap is nevertheless tolerated: the new UI falls back to
India-compatible settings if an old CMS lacks `/api/site-settings`, and retries
route projections without `pageTemplate`. This protection keeps the site up;
it does not remove the requirement to verify Country Setup before completing
the release. See [Country Setup and Multi-Country Sites](./country-setup.md).

### Localization and UI Text release note

The translation outbox/state/usage tables and the UI catalogue/translation
tables are additive. Deploy this CMS image before the localized storefront so
`GET /api/ui-dictionary`, `POST /api/ui-dictionary/catalogue`, Settings → UI
Text, the language registry and localized read middleware all exist when the
frontend activates.

After the CMS is healthy, create a dedicated **Custom** Strapi API token with
only **Ui-dictionary → syncCatalogue**. Give that token only to the frontend
host's `env/catalogue-sync.env`; it is not a CMS runtime variable and must not
be shared with the SSR read token. The first frontend deployment performs the
catalogue sync. Normal page traffic never writes the catalogue.

## 1. Publish an immutable image

Run the CMS checks before creating the GitHub Release:

```bash
yarn install --frozen-lockfile
yarn test
yarn tsc --noEmit
yarn build
docker build -t couponzguru-cms:verify .
```

Create a GitHub Release and wait for its GHCR workflow to finish. Record the
immutable `v*` or `sha-*` tag. Never deploy `latest`.

Publishing the GitHub Release is the only automatic image trigger. A raw `v*`
tag push does not start a second build; `workflow_dispatch` remains available
for an intentional manual rebuild.

The CMS image is country-neutral. Do not supply a public-site build argument:
the running container exposes its non-secret `PUBLIC_SITE_URL` through an
authenticated admin runtime-config endpoint. Coupon/Deal public-link actions
therefore follow the deployment environment without rebuilding the admin
bundle, and one immutable image may be promoted to every country stack.

## 2. Back up PostgreSQL

Once the Database Backups feature is configured (`BACKUP_S3_*`, runbook
`deployment/docs/16-database-backups.md`), the pre-deploy backup is one click:
Settings → Database Backups → **Back up now**, wait for the row to show
**Stored**, and press **Verify**. The steps below still apply.

Before replacing Strapi:

- create a complete PostgreSQL backup;
- verify that the backup can be read;
- record the current image tag;
- record the current migration state;
- preserve the existing Strapi secrets;
- verify the current S3 bucket and media CDN.

Do not rotate existing `APP_KEYS`, JWT secrets, token salts, or
`ENCRYPTION_KEY` during an ordinary deployment. Rotation may invalidate
sessions and tokens or make encrypted data unreadable.

## 3. Prepare the CMS host

Use `/opt/couponzguru` as the production runtime directory:

```bash
sudo mkdir -p /opt/couponzguru
sudo chown "$USER":"$USER" /opt/couponzguru
```

Install these checked-in files:

```text
cguruadmin/deploy/docker.compose.yml
    -> /opt/couponzguru/docker.compose.yml

cguruadmin/deploy/scripts/deploy.sh
    -> /opt/couponzguru/deploy.sh
```

Then:

```bash
cd /opt/couponzguru
chmod 700 deploy.sh
docker login ghcr.io
```

The host requires Docker Engine and the Docker Compose plugin.

## 4. Generate new secrets only when needed

For a genuinely new production installation, generate an independent value
for every secret:

```bash
openssl rand -hex 32
```

Run the command separately for:

- four different `APP_KEYS`;
- `API_TOKEN_SALT`;
- `ADMIN_JWT_SECRET`;
- `TRANSFER_TOKEN_SALT`;
- `JWT_SECRET`;
- `ENCRYPTION_KEY`;
- `ISR_ADMIN_SECRET`.

The same `ISR_ADMIN_SECRET` must later be installed in the Fastify gateway.
Use at least 32 random bytes. Store all secrets in the production secret
manager; never commit them.

For an upgrade of an existing production CMS, retain the existing Strapi
secrets.

## 5. Create `.env.production`

Create `/opt/couponzguru/.env.production` from the following template and
replace every angle-bracket placeholder.

```dotenv
# Container image
APP_IMAGE=ghcr.io/vickydalmia/cguruadmin
APP_IMAGE_TAG=<IMMUTABLE_CMS_TAG>

# This host's country (IN, US or AE). Must equal the persisted Country Setup
# and the storefront's DEPLOYMENT_COUNTRY_CODE; deploy.sh refuses to run
# without it. Optional role/rollout knobs are listed in the table below.
DEPLOYMENT_COUNTRY_CODE=<IN|US|AE>
MAINTENANCE_SERVICE_ENABLED=true
DATABASE_CONNECTION_BUDGET=22

# Strapi runtime
NODE_ENV=production
HOST=0.0.0.0
PORT=1337
APP_PORT=1337

# CMS host VPC/private IP. Never use 0.0.0.0.
APP_BIND=<CMS_PRIVATE_IP>

# Frontend host VPC/private IP. An exact IP is preferred.
RATE_LIMIT_TRUSTED_IPS=<FRONTEND_PRIVATE_IP>

PUBLIC_URL=https://cms.couponzguru.com
TRUST_PROXY=true
TRANSFER_REMOTE_ENABLED=false

# Enable on exactly one production CMS scheduler.
CRON_ENABLED=true

FLAG_NPS=false
FLAG_PROMOTE_EE=false
SEARCH_SLOW_LOG_MS=500

# Strapi secrets: retain existing production values during an upgrade.
APP_KEYS=<KEY_1>,<KEY_2>,<KEY_3>,<KEY_4>
API_TOKEN_SALT=<RANDOM_SECRET>
ADMIN_JWT_SECRET=<RANDOM_SECRET>
TRANSFER_TOKEN_SALT=<RANDOM_SECRET>
JWT_SECRET=<RANDOM_SECRET>
ENCRYPTION_KEY=<RANDOM_SECRET>

# PostgreSQL
DATABASE_CLIENT=postgres
DATABASE_URL=postgres://<USER>:<URL_ENCODED_PASSWORD>@<DB_HOST>:5432/<DB_NAME>
DATABASE_SCHEMA=public
DATABASE_SSL=true

# Select one CA method when a private database CA is required.
DATABASE_SSL_CA_PATH=
DATABASE_SSL_CA=<BASE64_ENCODED_CA_OR_EMPTY>

# Advanced mutual-TLS/cipher settings; normally empty.
DATABASE_SSL_KEY=
DATABASE_SSL_CERT=
DATABASE_SSL_CAPATH=
DATABASE_SSL_CIPHER=

DATABASE_SSL_REJECT_UNAUTHORIZED=true
DATABASE_POOL_MIN=2
DATABASE_POOL_MAX=10
DATABASE_CONNECTION_TIMEOUT=60000

# S3 media
S3_UPLOAD_ENABLED=true
S3_ACCESS_KEY_ID=<S3_ACCESS_KEY>
S3_ACCESS_SECRET=<S3_SECRET_KEY>
S3_BUCKET=<S3_BUCKET_NAME>
S3_REGION=ap-south-1
S3_FORCE_PATH_STYLE=false
S3_BASE_URL=https://media.couponzguru.com
S3_ROOT_PATH=uploads
S3_PREVENT_OVERWRITE=true
S3_CHECKSUM_ALGORITHM=CRC64NVME
S3_MULTIPART_PART_SIZE=10485760
S3_MULTIPART_QUEUE_SIZE=4

# Database backups → S3 (Settings → Database Backups). REQUIRED on every host:
# deploy.sh refuses empty or change-me values. Separate bucket + IAM user from
# the media bucket, one per country; see deployment/docs/16-database-backups.md.
# BACKUP_RUNNER_ENABLED: docker.compose.yml pins it per service (true on
# strapi-maintenance, or on strapi when MAINTENANCE_SERVICE_ENABLED=false) and
# Compose `environment` overrides this file, so a value here only matters for
# `yarn develop` outside Compose.
BACKUP_S3_BUCKET=changeme-backup-bucket
BACKUP_S3_REGION=ap-south-1
BACKUP_S3_ACCESS_KEY_ID=changeme-backup-access-key
BACKUP_S3_ACCESS_SECRET=changeme-backup-secret-key
BACKUP_S3_PREFIX=db-backups
BACKUP_S3_SSE=AES256
BACKUP_TIMEOUT_MINUTES=60
BACKUP_PG_DUMP_COMPRESSION=zstd:3

# Required for Product Deal image uploads.
FAL_KEY=<FAL_API_KEY>
FAL_BACKGROUND_REMOVAL_CONCURRENCY=2
FAL_BACKGROUND_REMOVAL_TIMEOUT_MS=120000
FAL_BACKGROUND_REMOVAL_MAX_ATTEMPTS=3

# Media origins permitted by the Strapi admin Content Security Policy.
UPLOAD_CSP_SOURCES=https://media.couponzguru.com,https://<BUCKET>.s3.ap-south-1.amazonaws.com

# Keep empty when public browser requests use Fastify instead of Strapi.
CORS_ORIGINS=

# Runtime storefront origin. The authenticated admin config endpoint supplies
# it to Coupon/Deal public-link actions; rich-text sanitization derives the
# first-party registrable domain from the same value.
PUBLIC_SITE_URL=https://www.couponzguru.com

# Conditional AI translation. Leave provider/key/model empty when Country
# Setup translation is disabled. A partial block never starts the dispatcher.
TRANSLATION_PROVIDER=
TRANSLATION_API_KEY=
TRANSLATION_BASE_URL=
TRANSLATION_MODEL=
TRANSLATION_REASONING_EFFORT=none
TRANSLATION_CONCURRENCY=2
TRANSLATION_TIMEOUT_MS=120000
TRANSLATION_MAX_ATTEMPTS=3
TRANSLATION_MAX_OUTPUT_TOKENS=8192
TRANSLATION_CHUNK_CHARS=12000
TRANSLATION_DAILY_BUDGET_USD=0
TRANSLATION_INPUT_COST_PER_MTOK=0
TRANSLATION_OUTPUT_COST_PER_MTOK=0
TRANSLATION_OUTBOX_DISPATCHER_ENABLED=true
TRANSLATION_OUTBOX_POLL_MS=5000
TRANSLATION_OUTBOX_BATCH_SIZE=5
TRANSLATION_OUTBOX_LEASE_MS=900000
TRANSLATION_OUTBOX_MAX_BACKOFF_MS=21600000
TRANSLATION_OUTBOX_RETENTION_DAYS=30
TRANSLATION_OUTBOX_ALERT_AFTER_ATTEMPTS=5
TRANSLATION_OUTBOX_BACKLOG_ALERT_MS=3600000
TRANSLATION_BACKFILL_RUNNER_ENABLED=true
TRANSLATION_BACKFILL_MAX_DOCS_PER_SECOND=20
TRANSLATION_NIGHTLY_CONSISTENCY_ENABLED=false

# Persistent-ISR transactional outbox
# The dispatcher safely retries while the gateway is unavailable. Enable it on
# the admin process only; docker.compose.yml disables it on strapi-render.
ISR_GATEWAY_URL=http://<FRONTEND_PRIVATE_IP>:3010
ISR_ADMIN_SECRET=<SHARED_ISR_SECRET>
ISR_OUTBOX_DISPATCHER_ENABLED=true
ISR_OUTBOX_POLL_MS=2000
ISR_OUTBOX_BATCH_SIZE=25
ISR_OUTBOX_REQUEST_TIMEOUT_MS=330000
ISR_OUTBOX_LEASE_MS=360000
ISR_OUTBOX_MAX_BACKOFF_MS=300000
ISR_OUTBOX_ALERT_AFTER_ATTEMPTS=5
ISR_OUTBOX_BACKLOG_ALERT_MS=1800000
ISR_OUTBOX_RETENTION_DAYS=30
ISR_REVALIDATE_MAX_PATHS=5000
ISR_OUTBOX_MAX_PAYLOAD_BYTES=900000
```

Protect the file:

```bash
chmod 600 /opt/couponzguru/.env.production
```

### What each Strapi environment variable does

#### Image and runtime

| Variable | Requirement | Purpose |
| --- | --- | --- |
| `APP_IMAGE` | Required | GHCR Strapi image name without its tag. Compose uses it to construct the immutable image reference. |
| `APP_IMAGE_TAG` | Required | Immutable `v*` or `sha-*` image tag. A tag passed to `deploy.sh` overrides this value for that deployment. |
| `NODE_ENV` | Managed | Must be `production`; enables production validation, the S3 provider, and production error behavior. |
| `HOST` | Managed | Strapi listener inside the container. Use `0.0.0.0` so Docker can reach it. |
| `PORT` | Managed | Strapi container port, normally `1337`. |
| `APP_PORT` | Optional | Host-side port mapped to container port `1337`; defaults to `1337`. |
| `APP_BIND` | Required | CMS host VPC/private address for the additional private publish. Never use `0.0.0.0`. |
| `RATE_LIMIT_TRUSTED_IPS` | Required for warming and fresh ISR reads | Comma-separated exact socket IPs or prefixes allowed to bypass CMS per-IP limits and present the signed ISR response-cache credential. Use the frontend private source IP. The render container needs no entry: it sets `RATE_LIMIT_TRUST_PRIVATE_SOCKETS=true` in the compose file, trusting every private socket — required on single-server deployments, where the frontend's requests hairpin through Docker NAT and arrive as a per-host bridge-gateway address no fixed allowlist entry can name. Never set that flag on the admin container: proxied visitor traffic reaches it from the same private gateway and would bypass the public limiter. |
| `PUBLIC_URL` | Required | External HTTPS CMS/admin origin used by Strapi-generated URLs. |
| `TRUST_PROXY` | Required behind a proxy | Enables Koa proxy awareness when Nginx or another trusted proxy terminates HTTPS. |
| `TRANSFER_REMOTE_ENABLED` | Optional | Enables Strapi remote transfer. Keep `false` unless a controlled transfer is in progress. |
| `CRON_ENABLED` | Optional | Enables scheduled offer state changes and cleanup. Set `true` on exactly one production instance. |
| `FLAG_NPS` | Optional | Shows or hides Strapi's NPS prompt in the admin UI. |
| `FLAG_PROMOTE_EE` | Optional | Shows or hides Strapi Enterprise promotion in the admin UI. |
| `SEARCH_SLOW_LOG_MS` | Optional | Emits structured slow-search timing at or above this duration. Set `0` to disable it. |

#### Country, deploy roles and upgrade migrations

| Variable | Requirement | Purpose |
| --- | --- | --- |
| `DEPLOYMENT_COUNTRY_CODE` | Required | Two-letter ISO code of THIS host (`IN`, `US`, `AE`). `deploy.sh` refuses to run without it, the preflight compares it with the persisted Country Setup, and every configuration read asserts it at runtime. The example file ships it blank on purpose. Must match the storefront's `DEPLOYMENT_COUNTRY_CODE`. |
| `MAINTENANCE_SERVICE_ENABLED` | Optional | `true` (default) starts `strapi-maintenance` (translation dispatcher + backfill + database backups). `false` omits it on an English-only host: no translation work; the admin container then takes the database backups, and a maintenance container left by an earlier release is still stopped. Any other value fails `deploy.sh`. |
| `DATABASE_CONNECTION_BUDGET` | Optional | Managed-DB backend connection ceiling the deploy checks the per-service pools (5 + 5 + 4) plus rollout headroom against. Default `22`; values below `18` are rejected. |
| `MIGRATION_LOCK_TIMEOUT_MS` | Optional | Transaction-local `lock_timeout` applied to every September 2026 upgrade migration so a long read on the old render container cannot block the rollout indefinitely; the migration fails safely and the deploy stops. Default `15000`. |
| `WRITE_SERIALIZATION_TIMEOUT_MS` | Optional | How long an editor's save waits for the per-domain advisory lock before failing with "Another editor is saving related content". Default `8000`. |
| `COUNTRY_SETUP_BOOTSTRAP_JSON` | Fresh databases only | Temporary identity that lets a Super Admin open Country Setup on an empty database. Remove after the first save. |

#### Strapi secrets

| Variable | Requirement | Purpose |
| --- | --- | --- |
| `APP_KEYS` | Required | Comma-separated signing keys used by the Strapi application. |
| `API_TOKEN_SALT` | Required | Salt used to hash Strapi API tokens. |
| `ADMIN_JWT_SECRET` | Required | Signs administrator JWTs. |
| `TRANSFER_TOKEN_SALT` | Required | Salt used for Strapi transfer tokens. |
| `JWT_SECRET` | Required | Signs Users & Permissions JWTs. |
| `ENCRYPTION_KEY` | Required | Encrypts sensitive values stored by the Strapi admin. |

Every value must be independent. Retain existing production values during
normal deployments.

#### AI translation

The `TRANSLATION_*` block is conditional on Country Setup's translation switch
and target-language list. Provider, API key and model must be configured
together. Choose `openai` for the official Responses API, `openai-compatible`
for a Chat-Completions gateway, or `anthropic` for native Messages;
`openai-compatible` also requires a base URL. Official OpenAI accepts
`TRANSLATION_REASONING_EFFORT=none|low|medium|high|xhigh|max` and defaults to
`none`; the setting is ignored by other providers. A positive daily budget
requires positive input/output per-million-token prices. An incomplete block
stays safely disabled and logs the configuration problem.
Run the paid dispatcher on exactly one CMS process. Current Compose forces
`TRANSLATION_OUTBOX_DISPATCHER_ENABLED=true` on `strapi-maintenance` and `false` on
`strapi` and `strapi-render`; when the dedicated variable is absent it inherits
`CRON_ENABLED`, so older Compose files retain the same single-process role.

For AE with Luna, the provider-specific portion is:

```dotenv
TRANSLATION_PROVIDER=openai
TRANSLATION_API_KEY=<SERVER_SIDE_OPENAI_KEY>
TRANSLATION_BASE_URL=
TRANSLATION_MODEL=gpt-5.6-luna
TRANSLATION_REASONING_EFFORT=none
```

Use the current official Luna per-million-token rates for the two cost
variables at deployment time. Do not run a paid backfill with stale rates:
they drive both the dry-run estimate and the concurrency-safe daily stop.
The adapter uses OpenAI Responses with `store: false`, omits temperature, and
disables AI SDK retries; the existing dispatcher remains the sole owner of
timeouts, retries, attempt accounting and budget enforcement.

Translation-generated ISR work is locale-scoped: ordinary Arabic content
writes refresh only `/ar/...` consumers and do not rebuild the default-only
sitemap. Route inventory refreshes only when a localized row is created or
removed. A repeated hash-current backfill first compares the full persisted
locale plan and emits no CMS write or ISR event when it is already current.
The nightly durable repair scan is opt-in with
`TRANSLATION_NIGHTLY_CONSISTENCY_ENABLED=true`; when enabled, it does not retry
a terminally failed unchanged source. Edit the English source or run an
explicit manual backfill when a deliberate retry is required. This is
load-bearing for large catalogues; if a deployment
shows repeated `routes` refreshes for every translated Coupon or steadily
advancing versions after the translation queue is empty, the CMS image is
older than this contract.

Catalogue backfills and dry-run estimates are database-backed background runs,
not request-bound scans. Only one `translation_backfill_runs` row may be active
for the shared database. Production Compose runs the scanner only in the
CPU-limited `strapi-maintenance` service; `strapi` and `strapi-render` explicitly
disable it. The scanner reads 50-document pages with a translation-only
population graph, caps its default pace at 20 documents/second and resumes from
the last committed cursor after restart. A `202` means the scan was accepted,
while progress and the final selection/cost result are read from
`/translation/outbox-status`. Super Admins can stop only the scan with
`POST /translation/backfill/:id/cancel`; jobs committed by earlier pages remain
queued.

Defaults and every queue/cost control are defined in the cross-system
[environment guide](https://github.com/vickydalmia/cguru-ui/blob/main/docs/environment.md#cms-translation-engine).
The operating workflow is in [AI content translation](./ai-translation.md).

#### PostgreSQL and TLS

| Variable | Requirement | Purpose |
| --- | --- | --- |
| `DATABASE_CLIENT` | Required | Database driver. Production must use `postgres`. |
| `DATABASE_URL` | Required in URL mode | Complete PostgreSQL URL. It takes precedence over the discrete connection fields. |
| `DATABASE_HOST` | Conditional | PostgreSQL host when `DATABASE_URL` is not used. |
| `DATABASE_PORT` | Conditional | PostgreSQL port when `DATABASE_URL` is not used; normally `5432`. |
| `DATABASE_NAME` | Conditional | PostgreSQL database name when `DATABASE_URL` is not used. |
| `DATABASE_USERNAME` | Conditional | PostgreSQL username when `DATABASE_URL` is not used. |
| `DATABASE_PASSWORD` | Conditional | PostgreSQL password when `DATABASE_URL` is not used. |
| `DATABASE_SCHEMA` | Optional | PostgreSQL schema containing the Strapi tables; normally `public`. |
| `DATABASE_SSL` | Required for managed production DBs | Enables TLS configuration for the database connection. |
| `DATABASE_SSL_CA_PATH` | Conditional | Path inside the container to a mounted CA certificate. It takes precedence over `DATABASE_SSL_CA`. |
| `DATABASE_SSL_CA` | Conditional | CA certificate supplied as base64 or raw PEM with escaped newlines. |
| `DATABASE_SSL_KEY` | Optional | Client private key for mutual TLS. |
| `DATABASE_SSL_CERT` | Optional | Client certificate for mutual TLS. |
| `DATABASE_SSL_CAPATH` | Optional | Directory of trusted CA certificates. |
| `DATABASE_SSL_CIPHER` | Optional | Explicit TLS cipher selection. |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | Optional | Verifies the database certificate. Keep `true` with the correct CA. |
| `DATABASE_POOL_MIN` | Managed | Minimum PostgreSQL pool size per Strapi process. `docker.compose.yml` pins `0` on every service; the env-file value only applies outside Compose. |
| `DATABASE_POOL_MAX` | Managed | Maximum PostgreSQL pool size per Strapi process. `docker.compose.yml` pins `5` (admin), `5` (render) and `4` (maintenance); the env-file value only applies outside Compose. |
| `DATABASE_CONNECTION_TIMEOUT` | Optional | Maximum time in milliseconds to acquire a database connection. |

#### S3 media and browser policy

| Variable | Requirement | Purpose |
| --- | --- | --- |
| `S3_UPLOAD_ENABLED` | Required | Production safety switch confirming that durable S3 uploads are enabled. |
| `S3_ACCESS_KEY_ID` | Required with S3 | S3 access key. |
| `S3_ACCESS_SECRET` | Required with S3 | S3 secret key. |
| `S3_BUCKET` | Required with S3 | Destination media bucket. |
| `S3_REGION` | Required with S3 | Bucket region. |
| `S3_FORCE_PATH_STYLE` | Optional | Enables path-style addressing for S3-compatible providers that require it. |
| `S3_BASE_URL` | Required | Public media/CDN origin returned for uploaded objects. |
| `S3_ROOT_PATH` | Optional | Object-key prefix inside the bucket. |
| `S3_PREVENT_OVERWRITE` | Optional | Prevents an upload from replacing an existing object key. |
| `S3_CHECKSUM_ALGORITHM` | Optional | Checksum algorithm attached to S3 upload requests. |
| `S3_MULTIPART_PART_SIZE` | Optional | Multipart upload part size in bytes. |
| `S3_MULTIPART_QUEUE_SIZE` | Optional | Number of concurrently uploaded multipart sections. |
| `FAL_KEY` | Required for Deal images | Server-only FAL credential used to remove Product Deal image backgrounds before AWS persistence. |
| `FAL_BACKGROUND_REMOVAL_CONCURRENCY` | Optional | Maximum concurrent FAL removals per process. Defaults to `2`. |
| `FAL_BACKGROUND_REMOVAL_TIMEOUT_MS` | Optional | Per-attempt timeout. Defaults to `120000`. |
| `FAL_BACKGROUND_REMOVAL_MAX_ATTEMPTS` | Optional | Attempts for transient provider failures. Defaults to `3`; credit/auth errors are not retried. |
| `UPLOAD_CSP_SOURCES` | Required for external media | Comma-separated media origins added to the Strapi admin `img-src` and `media-src` policy. |
| `CORS_ORIGINS` | Optional | Browser origins permitted to call Strapi directly. Keep empty when all public browser requests use Fastify. |
| `PUBLIC_SITE_URL` | Required runtime | Storefront origin returned by the authenticated admin runtime-config endpoint for Coupon/Deal public-link actions and used server-side to derive the registrable first-party domain for rich-text links. It is not compiled into the image, so the same image serves every country. There is no separate `INTERNAL_HOSTS` list. |

#### Database backups to S3

| Variable | Required | Description |
|---|---|---|
| `BACKUP_RUNNER_ENABLED` | Per service | `true` on exactly ONE container: compose sets it on `strapi-maintenance`, or on `strapi` through `ADMIN_BACKUP_RUNNER_ENABLED` when the maintenance service is disabled. That process takes every scheduled and on-demand backup; every other container only queues rows. Defaults to `false`. |
| `BACKUP_S3_BUCKET` | Required | Dedicated backup bucket — never the media bucket, never behind the CDN. `deploy.sh` refuses an empty or `change-me` value on every host. |
| `BACKUP_S3_REGION` | Required | Bucket region. Optional only with `BACKUP_S3_ENDPOINT`. |
| `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_ACCESS_SECRET` | Required | Dedicated IAM user with the least-privilege policy in `deployment/docs/16-database-backups.md`. Never stored in the database. `deploy.sh` refuses empty or `change-me` values. |
| `BACKUP_S3_PREFIX` | Optional | Key prefix; `<CC>/<YYYY>/<MM>/<DD>/` and the file name are appended. Defaults to `db-backups`. |
| `BACKUP_S3_SSE` | Optional | `AES256` (default, SSE-S3), `aws:kms` (needs `BACKUP_S3_KMS_KEY_ID`), or `none` (local MinIO only). |
| `BACKUP_S3_KMS_KEY_ID` | Required with `aws:kms` | KMS key the IAM user may `GenerateDataKey`/`Decrypt` with. |
| `BACKUP_S3_ENDPOINT` / `BACKUP_S3_FORCE_PATH_STYLE` | Local dev only | Point at MinIO; leave unset on AWS. |
| `BACKUP_TIMEOUT_MINUTES` | Optional | Kill a dump that runs longer than this. Defaults to `60`. |
| `BACKUP_PG_DUMP_PATH` / `BACKUP_PG_RESTORE_PATH` | Optional | Binaries; the image ships PostgreSQL 18 clients on `PATH`. |
| `BACKUP_PG_DUMP_COMPRESSION` | Optional | `pg_dump --compress` value. Defaults to `zstd:3`. |
| `DEPLOYMENT_COUNTRY_CODE` | Required | Already required by deploy.sh; also names the backup folder and file. |

#### Persistent-ISR outbox

| Variable | Requirement | Purpose |
| --- | --- | --- |
| `ISR_GATEWAY_URL` | Required | Private Fastify origin receiving durable content invalidations. |
| `ISR_ADMIN_SECRET` | Required | Shared bearer secret for outbox delivery and protected ISR/search operations. It must exactly match Fastify. |
| `ISR_OUTBOX_DISPATCHER_ENABLED` | Optional | Starts the durable delivery loop. When omitted, it inherits `CRON_ENABLED`, preserving the existing single-process role on older host Compose files. Keep it enabled on exactly one production process; current Compose also forces `false` on `strapi-render`, while content writes on either process may continue inserting rows into the shared table. |
| `ISR_OUTBOX_POLL_MS` | Optional | Time between outbox dispatcher polls. |
| `ISR_OUTBOX_BATCH_SIZE` | Optional | Maximum rows leased in one dispatcher poll. |
| `ISR_OUTBOX_REQUEST_TIMEOUT_MS` | Optional | HTTP timeout for one delivery attempt to Fastify. Defaults to 330 seconds. |
| `ISR_OUTBOX_LEASE_MS` | Optional | Row lease duration before another dispatcher can reclaim an interrupted delivery. It must exceed the request timeout by at least 30 seconds. |
| `ISR_OUTBOX_MAX_BACKOFF_MS` | Optional | Maximum exponential retry delay. |
| `ISR_OUTBOX_ALERT_AFTER_ATTEMPTS` | Optional | Attempt count at which failures become alert-level logs. |
| `ISR_OUTBOX_BACKLOG_ALERT_MS` | Optional | Age of the oldest undelivered event past which `/api/isr/status` reports unhealthy (HTTP 503) and the dispatcher emits `isr.outbox.backlog_stale` alerts. Default 30 minutes. |
| `ISR_OUTBOX_RETENTION_DAYS` | Optional | Age after which successfully delivered rows may be cleaned up. |
| `ISR_REVALIDATE_MAX_PATHS` | Optional | Maximum targeted paths in one durable event before it is promoted to a full invalidation. Must match the gateway; default `5000`. |
| `ISR_OUTBOX_MAX_PAYLOAD_BYTES` | Optional | Maximum serialized durable payload size before path events are promoted to a full invalidation. Default `900000`. |

### PostgreSQL without `DATABASE_URL`

Use either `DATABASE_URL` or the discrete connection fields. When using the
discrete form, remove `DATABASE_URL` and set:

```dotenv
DATABASE_HOST=<DB_HOST>
DATABASE_PORT=5432
DATABASE_NAME=<DB_NAME>
DATABASE_USERNAME=<DB_USER>
DATABASE_PASSWORD=<DB_PASSWORD>
```

If `DATABASE_SSL_CA_PATH` is used, mount the CA certificate into the container
by enabling the certificate volume in `docker.compose.yml`. Otherwise use
`DATABASE_SSL_CA` with the base64-encoded CA. Do not configure both.

## 6. Configure networking

The Compose deployment publishes Strapi on:

```text
127.0.0.1:1337
<CMS_PRIVATE_IP>:1337
```

Requirements:

- `APP_BIND` must be the CMS host's VPC/private IP;
- never set `APP_BIND=0.0.0.0`;
- allow private port `1337` only from the frontend host;
- expose the admin through the configured HTTPS Nginx/reverse-proxy origin;
- allow the CMS host to call the frontend private address on port `3010`;
- keep PostgreSQL and S3 reachable from the CMS host.

Docker-published ports can bypass host-only firewall assumptions. Apply the
restriction at the cloud firewall/network layer as well.

## 7. Validate before deployment

```bash
cd /opt/couponzguru

docker compose \
  --env-file .env.production \
  -f docker.compose.yml \
  config -q
```

Do not deploy if validation fails.

Confirm the immutable image exists and the host can pull it:

```bash
docker pull ghcr.io/vickydalmia/cguruadmin:<IMMUTABLE_CMS_TAG>
```

## 8. Deploy Strapi

```bash
cd /opt/couponzguru
./deploy.sh <IMMUTABLE_CMS_TAG>
```

Examples:

```bash
./deploy.sh v1.2.0
./deploy.sh sha-abc1234
```

The script validates Compose, pulls the image, replaces the Strapi container,
waits for its health check, verifies `/_health`, and prints the final service
state.

Database migrations run during Strapi startup. The ISR outbox creation
migration, translation tables, UI dictionary tables and the legacy
optional-path reconciliation migration must complete before production content
writes resume. The reconciliation changes only the payload of matching
pending/processing legacy rows; it preserves their lease, attempt counter, and
next-attempt schedule so a rolling deploy cannot steal work from the previous
container.

## 9. Verify the deployment

Check the container:

```bash
cd /opt/couponzguru

docker compose \
  --env-file .env.production \
  -f docker.compose.yml \
  ps
```

The health endpoint must return `204`:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:1337/_health
```

Inspect the logs:

```bash
docker compose \
  --env-file .env.production \
  -f docker.compose.yml \
  logs --tail=300 strapi
```

There must be no startup error involving:

- production configuration;
- PostgreSQL or its TLS configuration;
- database migrations;
- S3 initialization;
- cron task registration;
- the ISR outbox configuration.

Also confirm the startup migration added `page_template` to Store, Brand,
Category and Bank without removing existing fields, and that the hidden Site
Configuration single type is available through the Country Setup service.
Confirm `ui_catalogue`, `ui_translations`, `translation_outbox`,
`translation_state` and `translation_usage` exist before enabling translation
or deploying the localized storefront.
Country Setup, migration profiles and runtime settings no longer use campaign
booleans: campaign activation is the selected entity `pageTemplate`. The two
old columns remain private and ignored for rollback compatibility with the
previous India image; do not edit or use them for new deployments.

The same startup also removes the two retired Homepage component attachments,
`exploreDeals` and `dealsByBrand`. Rebuild and restart both Strapi containers
so Content Manager reads the new Homepage schema; after that it exposes only
the Coupon-backed **Explore Offers** and **Offers by Brand** sections. The
shared Deal component tables remain because campaign single types still use
those components.

Before the frontend gateway starts, outbox delivery failures are expected and
remain retryable. Strapi itself must remain healthy.

## 10. Verify PostgreSQL and the outbox

Run against the production database:

```sql
select to_regclass('public.isr_outbox');
```

Expected:

```text
isr_outbox
```

Inspect delivery state:

```sql
select status, count(*)
from isr_outbox
group by status;
```

To investigate pending or failed delivery:

```sql
select id, event_key, reason, status, attempt_count,
       next_attempt_at, locked_at, lock_token, invalid_at,
       last_error, created_at
from isr_outbox
where status <> 'delivered'
order by id;
```

Do not manually recreate outbox rows. The dispatcher delivers each row under
`<event_key>#<row id>` — stable across that row's retries, so the gateway's
idempotency window de-duplicates a redelivery, and unique per row, so the
coalesced keys (`translation-isr:<locale>`, the sweep reasons) are not
mistaken for an already-accepted event — and retries failures automatically.

Targeted payloads may include `optionalPaths`, always as a subset of `paths`.
These are conditionally generated entity Deal pages. The gateway still
invalidates them when admitted, but after refreshing route inventory it treats
their authoritative absence as successful convergence. Missing required paths
remain delivery failures.

## 11. Functional verification

Verify:

- Strapi admin login;
- Coupon and Deal list/edit pages;
- Store, Brand, Category, and Bank relationships;
- S3 media upload and public CDN delivery;
- a representative public Coupon API response;
- a representative public Deal API response;
- route-inventory APIs used by Astro;
- search status and indexes;
- scheduled Coupon/Deal state processing.
- `GET /api/site-settings` identity, localization and feature readiness;
- **Settings → UI Text** loads and shows “no catalogue synced yet” before the
  first frontend sync, rather than failing the page;
- a dedicated Custom token can call `POST /api/ui-dictionary/catalogue` while
  a Read-only token receives `403`;
- `GET /api/ui-dictionary?locale=en` returns the dictionary envelope with
  `Cache-Control: public, max-age=60`;
- the expected `dealTemplate` and `independenceDayTemplate` owner paths;
- the Content Manager sidebar omits disabled country features and campaign
  singletons without a template owner;
- disabled features are absent from public route metadata, search and sitemap
  sources, while the India deployment reports every intended feature live.

For India, stop the rollout if an intended feature is not simultaneously
`enabled`, `ready` and `live`, or if either campaign path differs from the
existing public URL. Do not bypass readiness with a direct database edit.

```bash
curl -fsS http://127.0.0.1:1337/api/site-settings | jq
curl -fsS http://127.0.0.1:1337/api/public-route-metadata | jq '.data | length'
```

With `ISR_ADMIN_SECRET` exported from the secret manager:

```bash
curl -fsS \
  -H "Authorization: Bearer ${ISR_ADMIN_SECRET}" \
  http://127.0.0.1:1337/api/search/status

curl -fsS \
  -H "Authorization: Bearer ${ISR_ADMIN_SECRET}" \
  http://127.0.0.1:1337/api/isr/status
```

Once Fastify is deployed, perform one controlled Coupon or Deal update and
verify:

1. the content transaction commits;
2. an `isr_outbox` row is created;
3. the dispatcher marks it `delivered`;
4. the singular page and all associated Homepage, Deal of the Day, Store,
   Brand, Category, and Bank pages are revalidated as applicable.

Creation, update, deletion, relationship removal, and expiry all use this
transactional outbox path.

## 12. Logging and alerts

CMS outbox logs use `component=isr-outbox`. Monitor:

```text
isr.outbox.enqueued
isr.outbox.dispatcher_started
isr.outbox.delivered
isr.outbox.delivery_failed
isr.outbox.lease_lost
isr.outbox.invalid
isr.outbox.dispatcher_cycle_failed
isr.outbox.dispatcher_disabled
isr.outbox.cleanup_completed
isr.outbox.cleanup_failed
isr.outbox.backlog_stale
isr.outbox.backlog_check_failed
```

Alert on:

- an unhealthy Strapi container;
- database migration failure;
- PostgreSQL or S3 connectivity failure;
- repeated `isr.outbox.delivery_failed`;
- any `isr.outbox.invalid` quarantined row;
- a stalled or failing dispatcher reported by `/api/isr/status`;
- rows remaining undelivered beyond the normal retry window (`isr.outbox.backlog_stale`, threshold `ISR_OUTBOX_BACKLOG_ALERT_MS`; also turns `/api/isr/status` unhealthy);
- more than one active cron scheduler;
- more than one `isr.outbox.dispatcher_started` process. The render container
  should instead log `isr.outbox.dispatcher_disabled` with
  `ISR_OUTBOX_DISPATCHER_ENABLED=false` once during bootstrap.

`/api/isr/status` exposes `dispatcher.lastProgressAt`, which advances after each
delivered, retried, lease-lost, or quarantined event. Stall detection uses that
per-event heartbeat, so a healthy sequential batch is not marked stalled merely
because the complete drain takes longer than one request timeout.

## Rollback

Rollback uses the last known compatible immutable image:

```bash
cd /opt/couponzguru
./deploy.sh <LAST_KNOWN_GOOD_CMS_TAG>
```

Before rollback, confirm that the older image supports the current PostgreSQL
schema and the frontend API contract. Rolling back the image does not roll
back content or database migrations.

For a coordinated frontend/CMS contract rollback, roll back the frontend
first, then Strapi.

Do not restore PostgreSQL or rotate secrets merely to roll back application
code.

## Transaction callback replay rollout

This release fixes retained transaction callbacks; replacing files in a running
process cannot remove its old callback state. Restart every Strapi role.
Production CPU improvement is an acceptance check, not an inference from tests.

1. Resolve actual container names and roles from the target deployment's Compose
   configuration and non-secret worker flags. The repository roles are `strapi`
   (admin/dispatch), `strapi-render` (reads), and `strapi-maintenance` (backfill).
   Capture immutable image IDs/revisions, recent logs, active backfill IDs,
   checkpoints, queue counts/oldest work, container CPU, traffic volume, and two
   query-counter snapshots 60 seconds apart. Use `pg_stat_statements` total calls
   if available; `pg_stat_database` transaction deltas are not query counts.
2. Pull the verified immutable image before the approved brief background pause.
   Stop admin/dispatch and maintenance with a **60-second maximum graceful
   timeout**, then let deployment tooling stop those containers if still busy.
   A six-hour scan must not delay rollout. Do not terminate database sessions,
   clear queues/checkpoints, reset leases, or use Queue all.
3. Replace sequentially behind existing health gates: admin first, render next,
   maintenance last. Keep the old render service available during admin recovery.
   A brief admin/search/redeem interruption is possible. `deploy.sh` now stops
   the old workers with `--timeout 60` and force-recreates all three roles.
4. Let interrupted work recover using existing leases: backfill becomes stale
   after five minutes; translation defaults to fifteen minutes. Never manually
   reset a lease while its former process is alive.
5. Observe for **15 minutes after lease recovery**. Old payload sequences must
   stop replaying; startup logs (instance ID/PID for dispatchers, PID/generation
   for backfill) must match configured roles. Jobs must advance checkpoints or
   reach an explicit terminal state. Duplicate suppression diagnostics are
   aggregated at most once per minute; normal invalidation logs remain intact.
6. Compare CPU and 60-second query deltas under comparable traffic. If load
   stays high, leave bulk maintenance paused and investigate active work. Do
   not declare the CPU incident resolved solely because callback tests pass.

Useful read-only database snapshots (preserve complete checkpoints privately):

```sql
SELECT id, status, locked_at, checkpoint, progress, finished_at
FROM translation_backfill_runs WHERE status IN ('pending', 'running');
SELECT status, count(*), min(created_at) FROM translation_outbox GROUP BY status;
SELECT status, count(*), min(created_at) FROM isr_outbox GROUP BY status;
SELECT sum(calls) AS query_calls FROM pg_stat_statements;
```

Keep before/after evidence with the release record, including observation times,
image revision, traffic, query rates, CPU, and outstanding terminal failures.


### Shared-country upgrade prerequisites

Deploy CMS first, then the storefront/gateway/worker. Set
`DEPLOYMENT_COUNTRY_CODE` to the persisted country's ISO code in every tier;
the preflight checks `DATABASE_SCHEMA` as well as database identity. Keep the
production Compose file aligned with the release. The default DB budget is 22,
with 14 possible application connections and at least four reserved for rollout.
`MAINTENANCE_SERVICE_ENABLED=false` can omit the translation container on an
English-only host; restore it before enabling translations. Default is true.
Database backups are mandatory on every host regardless: `deploy.sh` refuses
to run without `BACKUP_S3_*`, and when the maintenance container is omitted the
admin container takes the backups (`ADMIN_BACKUP_RUNNER_ENABLED`, exported by
`deploy.sh`). See `docs/database-backups.md`.

September upgrade migrations acquire locks with a transaction-local
`MIGRATION_LOCK_TIMEOUT_MS` (default 15000), failing safely if a lock cannot be
obtained. This is not a query-duration limit. Editor advisory locks retain the
separate `WRITE_SERIALIZATION_TIMEOUT_MS` default of 8000; continuing a save
without its required lock would violate write consistency.

For the serialized inventory background lane, delivery timeout/lease defaults
are now 330000/360000 ms. Update explicit older environment overrides when
using the corresponding gateway's 300-second inventory budget. Manual refresh
failures are bounded separately; ordinary content invalidations retain durable
retry. See [website refresh](website-refresh.md) for status semantics.
