# Strapi Production Deployment

This document explains how to deploy this Strapi application to an Ubuntu droplet with:

- GitHub Releases triggering deployment
- Docker Compose running the application (1 replica per droplet)
- GHCR storing production images
- DigitalOcean Managed PostgreSQL for the database
- S3-compatible object storage for media uploads
- Nginx as a standalone load balancer (may run on the same or a separate server)

## Architecture overview

```mermaid
flowchart LR
  githubRelease[GitHubRelease] --> ghaBuild[GitHubActionsBuild]
  ghaBuild --> ghcr[GHCRImage]
  ghcr --> ghaDeploy[GitHubActionsDeploy]
  ghaDeploy --> droplet[UbuntuDroplet]
  droplet --> strapi[StrapiContainer]
  nginx[NginxLoadBalancer] --> strapi
  strapi --> postgres[ManagedPostgreSQL]
  strapi --> s3[S3CompatibleStorage]
  nginx --> publicInternet[PublicHTTPS]
```

## Files added for deployment

- `Dockerfile`
- `.dockerignore`
- `deploy/docker.compose.yml`
- `deploy/scripts/deploy.sh`
- `deploy/nginx.conf`
- `deploy/site.nginx.conf`
- `.github/workflows/release-deploy.yml`
- `docs/strapi-production-deployment.md`
- `database/search-index-migration.js` — shared best-effort DDL helper used by both search-index migrations and post-schema-sync bootstrap reconciliation

The runtime configuration is also updated in:

- `config/server.ts`
- `config/plugins.ts`
- `config/middlewares.ts`
- `.env.example`

## Production design decisions

- Production images are built on GitHub Actions and published to `ghcr.io`
- Release deployments run only from GitHub Releases or manual workflow dispatch
- Each droplet runs exactly 1 Strapi container
- The droplet does not run a database container -- use DigitalOcean Managed PostgreSQL
- The app never uses SQLite in production
- Media uploads are stored in S3-compatible object storage, not on the droplet filesystem
- Nginx is a standalone load balancer -- it may run on the same server or a separate server
- The Nginx `upstream` block is managed manually by the operator to support backends on different machines
- The workflow deploys the immutable `sha-*` image tag even when a release tag also exists

## Docker image details

### Dockerfile stages

The `Dockerfile` uses a multi-stage build on `node:22-alpine`:

| Stage | Purpose |
| --- | --- |
| `build` | Alpine + build deps (gcc, vips-dev, etc.), installs deps, runs `yarn build`, then prunes to production-only |
| `runtime` | Slim Alpine + vips runtime, copies production `node_modules` and build artifacts, creates custom `strapi` user (UID 1001), runs as non-root |

The runtime image does not contain build tools (python3, make, g++), dev dependencies, or source TypeScript -- only what Strapi needs to run.

### Custom user

The image creates a dedicated `strapi` user and group (UID/GID 1001). The container never runs as root. The compose file enforces this with `user: "1001:1001"` and `no-new-privileges`.

### Read-only filesystem

The compose file sets `read_only: true` on the container. Writable directories (`/opt/app/.tmp`, `/opt/app/.cache`, `/tmp`) are mounted as `tmpfs` so Strapi can write temporary files without making the root filesystem writable.

### Building locally

```bash
docker build -t couponzguru:local .
```

To override the UID/GID at build time:

```bash
docker build --build-arg STRAPI_UID=1500 --build-arg STRAPI_GID=1500 -t couponzguru:local .
```

### Running locally with Docker

```bash
docker run --rm -it \
  -p 1337:1337 \
  --env-file .env \
  couponzguru:local
```

## Prerequisites

You need the following before starting:

- A GitHub repository with Actions enabled
- A GHCR-compatible package destination
- An Ubuntu 22.04 or 24.04 droplet (1 vCPU / 2 GB RAM is sufficient for a single replica)
- A domain name pointing to the Nginx load balancer
- A DigitalOcean Managed PostgreSQL database
- An S3-compatible object storage bucket
- DNS ready for the Strapi public URL, for example `cms.couponzguru.com`

## 1. Prepare production infrastructure

### DigitalOcean Managed PostgreSQL

Create a managed database cluster and collect:

- host
- port
- database name
- username
- password
- SSL requirement (always enabled on DO managed DB)

Recommended:

- require SSL
- create a dedicated application user with least privileges
- keep connection pooling within the defaults in `.env.example` unless load proves otherwise

### S3-compatible object storage

Create a production bucket and collect:

- bucket name
- region
- endpoint if using a non-AWS provider (e.g. DigitalOcean Spaces endpoint)
- access key ID
- secret access key
- CDN or public base URL if applicable

Recommended:

- use a private bucket unless public assets are intentional
- enable versioning
- enable bucket lifecycle rules
- serve public media through `media.couponzguru.com`

## 2. Configure GitHub

### Repository settings

Enable:

- GitHub Actions
- GitHub Packages
- GitHub Releases

### Production environment

Create a GitHub environment named `production`.

Recommended environment protection:

- require manual approval before deploy
- restrict who can deploy
- keep all deploy secrets only in the `production` environment

### GitHub secrets

The workflow only builds and pushes. It uses the built-in `GITHUB_TOKEN` to push images to GHCR. No SSH keys or deploy secrets are stored in GitHub.

All server credentials stay on the droplet only.

### GHCR package access

If the repository is private:

- ensure the GHCR package is accessible to the repository
- create a fine-grained token or PAT with `read:packages` for droplet pulls
- do not use a full admin or personal all-scope token if a narrower token works

## 3. Provision the Ubuntu droplet

SSH into the droplet as `root` once, then create a dedicated deploy user.

### Create a deploy user

```bash
adduser deploy
mkdir -p /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
```

Do NOT add the deploy user to the `sudo` group. It only needs Docker access (via the `docker` group, added below). A compromised SSH key should not give an attacker root.

Add the public SSH key that matches `PROD_SSH_PRIVATE_KEY` to:

```bash
/home/deploy/.ssh/authorized_keys
```

Then lock down permissions:

```bash
chmod 600 /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
```

### Install Docker Engine and Compose plugin

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker deploy
```

Log out and back in if you added the user to the `docker` group in the current session.

### Install Nginx (if load balancer runs on the same server)

```bash
sudo apt-get update
sudo apt-get install -y nginx
sudo systemctl enable nginx
sudo systemctl start nginx
```

## 4. Prepare the droplet runtime directory

Use the deployment directory from `PROD_APP_DIR`, recommended:

```bash
sudo mkdir -p /opt/couponzguru
sudo chown -R deploy:deploy /opt/couponzguru
cd /opt/couponzguru
```

The expected runtime layout is:

```text
/opt/couponzguru/
├── docker.compose.yml      # copied from repo deploy/docker.compose.yml
├── deploy.sh             # copied from repo deploy/scripts/deploy.sh
└── .env.production       # manually created, stays on server
```

Copy the deployment files from the repo:

```bash
scp deploy/docker.compose.yml deploy/scripts/deploy.sh user@droplet:/opt/couponzguru/
```

The `.env.production` file stays only on the droplet and is never committed.

## 5. Create the production environment file

Copy the structure from `.env.example` and create:

```bash
/opt/couponzguru/.env.production
```

Example:

```dotenv
NODE_ENV=production
APP_IMAGE=ghcr.io/OWNER/REPO
HOST=0.0.0.0
PORT=1337
APP_PORT=1337
PUBLIC_URL=https://cms.couponzguru.com
TRUST_PROXY=true
TRANSFER_REMOTE_ENABLED=false

APP_KEYS=changeMe1,changeMe2,changeMe3,changeMe4
API_TOKEN_SALT=change-me-api-token-salt
ADMIN_JWT_SECRET=change-me-admin-jwt-secret
TRANSFER_TOKEN_SALT=change-me-transfer-token-salt
JWT_SECRET=change-me-jwt-secret
ENCRYPTION_KEY=change-me-32-char-encryption-key

DATABASE_CLIENT=postgres
DATABASE_URL=postgres://strapi:change-me-password@your-do-db-host.db.ondigitalocean.com:25060/strapi?sslmode=require
DATABASE_SCHEMA=public
DATABASE_SSL=true
# Use CA for proper verification (recommended). See "Database SSL CA" below.
# DATABASE_SSL_CA_PATH=/opt/app/certs/ca.crt
# DATABASE_SSL_CA=<base64-encoded CA>
DATABASE_SSL_REJECT_UNAUTHORIZED=true
DATABASE_POOL_MIN=2
DATABASE_POOL_MAX=10
DATABASE_CONNECTION_TIMEOUT=60000

S3_UPLOAD_ENABLED=true
S3_ACCESS_KEY_ID=change-me-access-key
S3_ACCESS_SECRET=change-me-secret-key
S3_BUCKET=change-me-bucket
S3_REGION=ap-south-1
S3_FORCE_PATH_STYLE=false
S3_BASE_URL=https://media.couponzguru.com
S3_ROOT_PATH=uploads
S3_PREVENT_OVERWRITE=true
S3_CHECKSUM_ALGORITHM=CRC64NVME
S3_MULTIPART_PART_SIZE=10485760
S3_MULTIPART_QUEUE_SIZE=4
UPLOAD_CSP_SOURCES=https://media.couponzguru.com,https://bucket.s3.ap-south-1.amazonaws.com

CORS_ORIGINS=
ISR_GATEWAY_URL=http://<ASTRO_PRIVATE_IP>:3010
ISR_ADMIN_SECRET=change-me-same-as-gateway
ISR_OUTBOX_POLL_MS=2000
ISR_OUTBOX_BATCH_SIZE=25
ISR_OUTBOX_REQUEST_TIMEOUT_MS=15000
ISR_OUTBOX_LEASE_MS=60000
ISR_OUTBOX_MAX_BACKOFF_MS=300000
ISR_OUTBOX_ALERT_AFTER_ATTEMPTS=5
ISR_OUTBOX_RETENTION_DAYS=30
STRAPI_MEDIA_URL=https://media.couponzguru.com
```

Important:

- `DATABASE_CLIENT` must be `postgres` in production.
- `PUBLIC_URL` must be the final HTTPS URL exposed to the public.
- `CORS_ORIGINS` can stay empty for beta/production because public browser search/redeem calls go through the ISR gateway proxy.
- `TRUST_PROXY=true` is required because Nginx sits in front of Strapi.
- DigitalOcean Managed PostgreSQL uses port `25060` and requires SSL.
- Keep `APP_PORT=1337` unless you also change the upstream port in `deploy/site.nginx.conf`.

### Database SSL CA (DigitalOcean managed DB)

DigitalOcean managed PostgreSQL uses a CA certificate. For proper verification (instead of `DATABASE_SSL_REJECT_UNAUTHORIZED=false`), provide the CA:

1. **Option A – file path**: Download the CA from the DO database dashboard, place it on the droplet (e.g. `deploy/certs/ca-certificate.crt`), uncomment the `volumes` block in `deploy/docker.compose.yml`, and set `DATABASE_SSL_CA_PATH=/opt/app/certs/ca.crt`.
2. **Option B – base64 in env**: Encode the CA (see [Appendix A §1](#1-database-ssl-self-signed-certificate-error) for commands) and set `DATABASE_SSL_CA=<output>` in `.env.production`. Do not copy the zsh `%` prompt if it appears at the end.
3. **Option C – raw PEM**: Set `DATABASE_SSL_CA` to the PEM content with `\n` for newlines.

With a valid CA, keep `DATABASE_SSL_REJECT_UNAUTHORIZED=true`.

### Media uploads: S3 gate and image variants

- `S3_UPLOAD_ENABLED` defaults to **off** when `NODE_ENV=production` (and on
  everywhere else). A production boot without `S3_UPLOAD_ENABLED=true` logs a
  loud startup error — `[upload] S3_UPLOAD_ENABLED is not "true" — uploads
  will go to LOCAL DISK …` — because local disk is tmpfs in this deploy and
  every redeploy wipes it. The boot still succeeds so a bad env can be fixed
  through the running instance; treat the error as a deploy blocker.
- Responsive breakpoints (`large`/`medium`/`small`/`xsmall` plus thumbnail)
  are configured independently of the S3 gate, from `src/constants/image.ts`
  (shared with the migration pipeline) — the generated variant matrix is
  identical whether uploads land on S3 or local disk.
- The same matrix also generates AVIF "twin" variants for webp masters
  (`original`/`xsmall`/`small`/`medium`/`large` `_avif`), so `<picture>` markup
  can serve AVIF with a webp fallback. A twin no smaller than its webp
  counterpart is dropped.
- New uploads get `Cache-Control: public, max-age=31536000, immutable`
  (filenames are content-hashed and overwrites are prevented, so immutable is
  safe). Objects uploaded before that setting need a one-time metadata
  backfill: `cd migration && npm run fix:cache-headers` (dry-run is the
  default), review, then re-run with `--apply --yes-i-mean-<bucket>` (the
  script refuses `--apply` without the bucket-named confirmation flag and
  prints the exact flag to use). The script preserves each object's stored
  Content-Type — do NOT use `aws s3 cp --metadata-directive REPLACE`, which
  re-guesses types from file extensions.
- Its sibling `npm run fix:content-srcsets` rebuilds rich-text `<img>`
  `srcset`/`sizes` from the current `files.formats` (same dry-run default and
  `--apply --yes-i-mean-<pg-host>` gating) — useful after a variant backfill.
  See [FRESH-MIGRATION.md § Maintenance scripts](../migration/FRESH-MIGRATION.md#maintenance-scripts)
  for the full catalog.
- An image CDN (on-the-fly resizing in front of the bucket) is a future-only
  option; nothing in the current pipeline depends on one. All variants are
  pre-generated at upload/migration/backfill time.

## 6. Log the droplet into GHCR

### Create a personal access token (classic)

1. Go to [GitHub Settings > Developer settings > Personal access tokens > Tokens (classic)](https://github.com/settings/tokens)
2. Click **Generate new token (classic)**
3. Name it something like `droplet-ghcr-pull`
4. Set expiration (or no expiration for a server token)
5. Select only the `read:packages` scope
6. Generate and copy the token

### Log in on the droplet

SSH into the droplet as the deploy user and run:

```bash
echo 'YOUR_TOKEN' | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

Replace `YOUR_GITHUB_USERNAME` with your GitHub username and `YOUR_TOKEN` with the token you just created.

Expected output:

```
Login Succeeded
```

Verify it works:

```bash
docker pull ghcr.io/YOUR_ORG/cguruadmin:latest
```

This only needs to be done once. Docker stores the credentials in `~/.docker/config.json`.

## 7. Configure Nginx as the load balancer

This repository includes host-level Nginx templates:

```text
deploy/nginx.conf          # global Nginx config
deploy/site.nginx.conf     # virtual host with upstream block
```

### Nginx upstream management

The `upstream strapi_backend` block in `site.nginx.conf` is **manually managed**. Nginx is a standalone load balancer -- backend Strapi droplets may be on the same server or on entirely different machines.

The default configuration ships with one active backend and two commented-out placeholders:

```nginx
upstream strapi_backend {
    least_conn;

    server 127.0.0.1:1337 max_fails=3 fail_timeout=30s;
    # server 127.0.0.1:1338 max_fails=3 fail_timeout=30s;
    # server 127.0.0.1:1339 max_fails=3 fail_timeout=30s;

    keepalive 32;
}
```

To add more backends (additional droplets):

- Add entries like `server 10.0.0.5:1337 max_fails=3 fail_timeout=30s;`
- Each entry points to a droplet running its own Strapi container on port 1337

After editing, validate and reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### Public API hardening

`cms.couponzguru.com` is public only for Strapi admin/login. The visitor-facing
website must not call CMS APIs directly. Public requests to CMS content APIs
should return `403`; Astro reads Strapi through the CMS droplet private IP.

The provided `deploy/site.nginx.conf` blocks these public paths:

```nginx
location ^~ /api/ {
    return 403;
}

location ^~ /unique-coupon/ {
    return 403;
}
```

Keep those blocks before the catch-all `location /`.

Private API access still needs to work from the Astro droplet:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  http://<CMS_PRIVATE_IP>:1337/api/homepage-full
```

Expected from the Astro droplet:

```text
200
```

Expected from a laptop or any public network:

```text
timeout / connection refused
```

If the Strapi container is bound only to `127.0.0.1`, add a private-only nginx
listener on the CMS droplet private IP, or bind the container port to the CMS
private interface and restrict port `1337` to `<ASTRO_PRIVATE_IP>` in the
DigitalOcean firewall. Do not open port `1337` to the public internet.

### Install the Nginx templates

Copy the templates into place:

```bash
sudo cp deploy/nginx.conf /etc/nginx/nginx.conf
sudo cp deploy/site.nginx.conf /etc/nginx/sites-available/strapi.conf
sudo ln -sf /etc/nginx/sites-available/strapi.conf /etc/nginx/sites-enabled/strapi.conf
```

Update `server_name` and certificate paths in the site config if your production domain differs from the template.

Then validate and reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 8. Perform the first deployment

From `/opt/couponzguru`:

```bash
# Deploy the latest tag from APP_IMAGE in .env.production
./deploy.sh
```

The script pulls, starts, health-checks, and reports success or failure.

Verify manually:

```bash
# Container should show "healthy"
docker compose --env-file .env.production -f docker.compose.yml ps

# Check logs (last 200 lines)
docker compose --env-file .env.production -f docker.compose.yml logs --tail=200 strapi

# Should return HTTP 204
curl -I http://127.0.0.1:1337/_health

# Confirm the container runs as the strapi user (uid=1001)
docker compose --env-file .env.production -f docker.compose.yml exec strapi id

# Verify through the load balancer
curl -I https://cms.couponzguru.com/_health
```

## 9. How it works

### GitHub Actions (build only)

The workflow in `.github/workflows/release-deploy.yml` builds and pushes the image:

- checks out the repository
- sets up Docker Buildx
- logs into GHCR using `GITHUB_TOKEN`
- builds the production image from `Dockerfile`
- pushes three tags:
  - the release tag, for example `v1.0.0`
  - the immutable commit tag, for example `sha-abc123...`
  - `latest`

The workflow does NOT deploy. You deploy manually by SSH-ing into the droplet.

### deploy.sh (manual deployment)

SSH into the droplet, go to `/opt/couponzguru`, and run:

```bash
./deploy.sh              # deploy latest tag
./deploy.sh v1.2.0       # deploy a specific release tag
./deploy.sh sha-abc123   # deploy a specific commit
```

The script:

1. Validates `docker.compose.yml` and `.env.production` exist
2. Pulls the image
3. Starts the container
4. Waits for the health check to pass (up to 120s)
5. Verifies the `/_health` endpoint returns 204
6. Prunes old images older than 7 days

## 10. Release process

The standard production deployment process is:

1. Merge tested changes to the release branch or default branch.
2. Create and publish a GitHub Release.
3. GitHub Actions builds and pushes the production image to GHCR.
4. SSH into the droplet and run `./deploy.sh` (or `./deploy.sh v1.2.0` for a specific tag).
5. The script verifies the container health check.
6. Validate the site and admin panel after deployment.

### One-time unique-code integrity migration

The release containing
`2026.07.23T00.00.00.enforce-unique-pool-codes.js` must have a brief writer
pause while the new container first boots. Stop any separate import/migration
jobs and make sure only one Strapi writer is starting. The normal single-
container `deploy.sh` replacement provides this pause; a multi-replica
deployment must scale to one writer first.

On boot, the migration keeps one deterministic row for each duplicate
`(pool_id, code)` pair (preserving redeemed history), recalculates pool
counters, and creates the blocking composite unique index. Do not resume
imports until the container is healthy. Later boots inspect the index and make
no counter writes when the database is already healthy.

## 11. Post-release validation checklist

After every release, verify:

- the GitHub Actions workflow completed successfully
- `docker compose --env-file .env.production -f docker.compose.yml ps` shows `strapi` as healthy
- `https://cms.couponzguru.com/_health` returns `204`
- the admin panel loads at the expected public URL
- a media upload succeeds and is stored in the S3-compatible bucket
- uploaded media previews load correctly in the admin panel
- the application connects to PostgreSQL successfully

Useful commands:

```bash
cd /opt/couponzguru
docker compose --env-file .env.production -f docker.compose.yml ps
docker compose --env-file .env.production -f docker.compose.yml logs --tail=200 strapi
docker image ls 'ghcr.io/*'
```

### Search: cache and index semantics

> Deploy-facing summary only. Two companion documents own the detail:
> **[docs/search-operations.md](./search-operations.md)** — the 11 expected
> trigram indexes and what each backs, the index-validity rules, the
> `/api/search/status` payload and its auth, and the automatic migration plus
> post-schema-sync reconciliation path; and
> **[docs/public-api.md](./public-api.md)** — the search request/response
> contract the ISR gateway and the UI code against. Prefer editing those; keep
> this section to what bears on a deploy.

The three things that bear on a deploy: mode follows the database dialect and
never changes at runtime, so index problems degrade speed and never
correctness; search-index reconciliation runs automatically after schema sync
on every PostgreSQL boot; and the insights contract couples a Strapi rollback
to a gateway rollback.

Search mode is fixed during Strapi bootstrap, before the instance serves
traffic. The configured database dialect is the only selector: PostgreSQL
always uses the full-set SQL ranker in
`src/api/search/services/search-sql.ts`; any non-Postgres database uses the
query-engine implementation. `pg_trgm` never changes row membership or
ranking and is only a performance aid. A SQL error after bootstrap is
returned as a real request error; the process never switches scorers between
pages.

Both implementations use the same scoring tiers: literal direct-field matches
occupy tiers 0–3, derived singular/plural matches 4–7, relation-name matches
8–15, and slug-only matches tier 99. Coupon `code` is a direct field. Within
a tier, both rankers order by normalized label and then `documentId`.
PostgreSQL uses the stable bytewise `C` collation; JavaScript compares UTF-8
bytes to mirror it. Both paths rank, count, and page the full matching set.
The non-Postgres fallback reads visible documents in deterministic 500-row
batches and performs literal membership in JavaScript, so `%`, `_`, and
backslash are ordinary query characters rather than LIKE wildcards.

Bootstrap checks the `pg_trgm` catalog entry and all 11 expected indexes once.
Call the uncached diagnostic endpoint with
`Authorization: Bearer $ISR_ADMIN_SECRET`; missing configuration, a
missing header, or a mismatch is denied. Its payload returns `mode`,
`pgTrgmAvailable`, `missingExpectedIndexes`, and
`invalidExpectedIndexes: [{name, reason}]`. Health validation covers the
owning table, indexed expression, GIN access method, `gin_trgm_ops` from the
extension's actual schema, and valid/ready state. Missing, invalid, or
uninspectable performance aids log at **error** level in production (warn
elsewhere), but PostgreSQL search remains in SQL mode.

The `2026.07.12T01.00.00.add-public-search-indexes.js` and
`2026.07.19T00.00.00.add-search-rank-indexes.js` migrations isolate optional
extension/index DDL behind nested savepoints. Expected permission, extension,
lock, or timeout failures therefore do not leave the surrounding migration
transaction aborted; unexpected schema errors still fail the migration. The
DDL path applies a transaction-local 5-second lock timeout and 30-second
statement timeout, so optional work cannot hold startup indefinitely. The later
migration reconciles all 11 indexes, including any skipped by the earlier one,
and structurally replaces a wrong or invalid same-name index. The drop and
replacement create share one savepoint, so an optional create failure restores
the prior index. Reconciliation uses ordinary transactional `CREATE INDEX`,
never `CONCURRENTLY` inside a migration transaction. Both paths discover the
schema that owns `pg_trgm` and schema-qualify `gin_trgm_ops`.

On a completely fresh database, Strapi 5 runs user migrations before schema
sync creates the content tables. The migration logs one consolidated skip, then
`bootstrap` invokes the same structural reconciler after schema sync and creates
the indexes automatically. It also runs on every later PostgreSQL boot, so an
already-migrated database with a missing, invalid, or wrong-expression index is
repaired without editing `strapi_migrations` or running a server SQL script.
Migrations and bootstrap share a transaction advisory lock; a concurrent
instance skips its pass immediately rather than delaying startup.

If the application role cannot create the extension or indexes, boot still
succeeds and search remains correct but may be slower. Production logs name the
problem, `/api/search/status` retains the missing/invalid diagnostics, and the
next boot retries automatically. Grant the application role the required schema
DDL capability through normal database provisioning if the warning persists.
Verify after deploy:

```bash
curl -fsS \
  -H "Authorization: Bearer $ISR_ADMIN_SECRET" \
  https://cms.couponzguru.com/api/search/status
# expect mode=postgres-sql, pgTrgmAvailable=true, and both index arrays empty
```

The public contract contains exactly six result groups: `stores`, `brands`,
`categories`, `banks`, `coupons`, and `deals`. `insights` is not a compatibility
group: `group=insights` is invalid, and an upstream payload containing an
`insights` result, total, or `hasMore` key is rejected by the gateway.

Rollback coupling: rolling Strapi back across the insights-removal boundary
(to a build whose search payloads still carry `insights` keys) requires
rolling back the ISR gateway — and the UI — in the same window. The current
gateway rejects such old-contract 200s as invalid upstream payloads, so
every uncached search request would 502 until the gateway is rolled back
too. There is no transitional or backward-compatibility handling for
`insights`: deploy and roll back Strapi, the ISR gateway, and the UI as one
search-contract unit.

Freshness is cache-bounded, not instant. Strapi keeps a 30-second in-process
route cache (`global::cache`). Each ISR gateway then keeps its own bounded
in-memory LRU — never Redis — fresh for 120 seconds and stale-servable through
600 seconds while a coalesced background refresh runs. A successful refresh
normally exposes changes after the fresh window; during upstream failures a
served stale body can reflect data fetched up to roughly 630 seconds earlier.
Browser responses remain `no-store`, and restarting a gateway starts its
search cache cold.

## 12. Rollback procedure

Because deployments use immutable `sha-*` tags, rollback is straightforward:

```bash
cd /opt/couponzguru
./deploy.sh v1.1.0                # rollback to a previous release tag
./deploy.sh sha-PREVIOUS_GOOD_SHA # or rollback to a specific commit
```

Find the previously known-good image tag from:

- previous workflow run logs
- GHCR package tags page
- the last successful release commit SHA

If the rollback crosses the search insights-removal boundary, roll back the
ISR gateway (and UI) in the same window — see the rollback-coupling note in
[Search: cache and index semantics](#search-cache-and-index-semantics).

## 13. Scaling horizontally

To handle more traffic, add more droplets rather than scaling vertically:

1. Provision a new small droplet (1 vCPU / 2 GB).
2. Follow sections 3-6 on the new droplet.
3. Deploy Strapi on the new droplet (same image, same `.env.production` pointing to the shared managed DB).
4. Add the new droplet's IP to the Nginx `upstream` block:

```nginx
upstream strapi_backend {
    least_conn;

    server 127.0.0.1:1337 max_fails=3 fail_timeout=30s;
    server 10.0.0.5:1337 max_fails=3 fail_timeout=30s;

    keepalive 32;
}
```

5. Reload Nginx: `sudo nginx -t && sudo systemctl reload nginx`

Keep in mind:

- `DATABASE_POOL_MAX` is per droplet. With 3 droplets at `DATABASE_POOL_MAX=10`, the database sees up to 30 connections.
- Size your DigitalOcean Managed PostgreSQL plan accordingly.

## 14. Troubleshooting

### Container never becomes healthy

Check:

```bash
cd /opt/couponzguru
docker compose --env-file .env.production -f docker.compose.yml logs --tail=200 strapi
```

Common causes:

- missing or malformed `.env.production`
- `DATABASE_CLIENT` left as default SQLite instead of `postgres`
- invalid `DATABASE_URL`
- unreachable PostgreSQL host or blocked firewall
- wrong `PUBLIC_URL`
- missing `APP_KEYS` or JWT secrets
- **Database SSL:** `self-signed certificate in certificate chain` → provide the CA via `DATABASE_SSL_CA` or `DATABASE_SSL_CA_PATH` (see [Appendix A §1](#1-database-ssl-self-signed-certificate-error))

### Uploads work but previews fail

Check:

- `UPLOAD_CSP_SOURCES` includes the asset host
- `S3_BASE_URL` or bucket endpoint matches the actual serving URL
- bucket CORS is configured correctly

### GHCR pull fails on the droplet

Check:

- `GHCR_PULL_USERNAME` and `GHCR_PULL_TOKEN`
- package visibility and repository access
- whether the deploy user is already logged in with `docker login ghcr.io`

### Release workflow builds but deploy fails

Check:

- `PROD_SSH_HOST`, `PROD_SSH_USER`, `PROD_SSH_PORT`
- `PROD_SSH_PRIVATE_KEY`
- `PROD_APP_DIR`
- whether `/opt/couponzguru/.env.production` exists on the droplet

### Nginx is up but the app URL is wrong

Check:

- `PUBLIC_URL=https://cms.couponzguru.com`
- `TRUST_PROXY=true`
- DNS points to the Nginx load balancer
- Nginx upstream block includes the correct backend IPs and ports

## 15. Docker commands reference

All commands assume you are in the deployment directory (`/opt/couponzguru`) and `.env.production` contains `APP_IMAGE`.

### Service lifecycle

```bash
# Start the service
docker compose --env-file .env.production -f docker.compose.yml up -d strapi

# Stop the service (keeps container)
docker compose --env-file .env.production -f docker.compose.yml stop strapi

# Stop and remove the container
docker compose --env-file .env.production -f docker.compose.yml down

# Restart the service
docker compose --env-file .env.production -f docker.compose.yml restart strapi

# Force recreate (new container from same image)
docker compose --env-file .env.production -f docker.compose.yml up -d --force-recreate strapi
```

### Health and status

```bash
# Show service status and health
docker compose --env-file .env.production -f docker.compose.yml ps

# Check health via container inspect
docker compose --env-file .env.production -f docker.compose.yml ps -q strapi | xargs docker inspect --format='{{.State.Health.Status}}'

# Quick loopback health check
curl -I http://127.0.0.1:1337/_health
```

### Logs

```bash
# Last 200 lines
docker compose --env-file .env.production -f docker.compose.yml logs --tail=200 strapi

# Follow live logs
docker compose --env-file .env.production -f docker.compose.yml logs -f strapi

# Logs since a specific time
docker compose --env-file .env.production -f docker.compose.yml logs --since=1h strapi
```

### Image management

```bash
# Pull the latest tagged image
docker compose --env-file .env.production -f docker.compose.yml pull strapi

# List all GHCR images on the droplet
docker image ls 'ghcr.io/*'

# Prune images older than 7 days
docker image prune -af --filter "until=168h"

# Prune all unused images, containers, networks
docker system prune -af
```

### Debugging

```bash
# Open a shell inside the running container
docker compose --env-file .env.production -f docker.compose.yml exec strapi /bin/sh

# Run a one-off command in a new container
docker compose --env-file .env.production -f docker.compose.yml run --rm strapi node -e "console.log(process.env.NODE_ENV)"

# Check which user the container runs as
docker compose --env-file .env.production -f docker.compose.yml exec strapi id

# Check container resource usage
docker stats --no-stream

# Inspect the full container config
docker compose --env-file .env.production -f docker.compose.yml ps -q strapi | xargs docker inspect
```

### Deploy and rollback

```bash
cd /opt/couponzguru

# Deploy latest
./deploy.sh

# Deploy a specific release
./deploy.sh v1.2.0

# Rollback to a previous tag
./deploy.sh v1.1.0

# Rollback to a specific commit
./deploy.sh sha-PREVIOUS_GOOD_SHA
```

## 16. Security notes

### Secrets and access

- Keep all production secrets out of git.
- Use the GitHub `production` environment for deployment secrets.
- Enable required reviewers on the `production` environment so no one can deploy without approval.
- Use a dedicated deploy SSH key -- not your personal key.
- Use a read-only GHCR token on the droplet (`read:packages` only).
- The deploy user on the droplet has NO sudo. It can only run Docker commands via the `docker` group. If the SSH key leaks, the attacker cannot escalate to root.

### Workflow hardening

- The GitHub Actions workflow only builds and pushes the image. It has no SSH access to your server and no deploy secrets.
- Only first-party actions (`actions/checkout`, `docker/*`) are used. No third-party actions.
- `workflow_dispatch` allows manual triggers. Restrict who can trigger via branch protection rules.
- The `concurrency` group prevents parallel builds from racing.

### Container hardening

- Container runs as non-root `strapi` user (UID 1001), not `root` or the default `node` user.
- `no-new-privileges` prevents privilege escalation inside the container.
- `read_only: true` makes the root filesystem immutable; only `tmpfs` mounts are writable.
- The runtime image contains no build tools, compilers, or dev dependencies.
- Strapi containers bind to `127.0.0.1` -- only the Nginx load balancer is exposed publicly.

### Network and TLS

- TLSv1 and TLSv1.1 are disabled; only TLSv1.2 and TLSv1.3 are allowed.
- Force PostgreSQL in production to avoid accidental SQLite fallback.
- Prefer a private bucket and signed URLs unless public assets are intentional.

---

## Appendix A: Debug fixes and implementation notes

This section documents fixes applied during deployment debugging. Use it when troubleshooting similar issues or understanding why certain choices were made.

### 1. Database SSL: self-signed certificate error

**Problem:** Connecting to DigitalOcean managed PostgreSQL fails with `self-signed certificate in certificate chain` when `DATABASE_SSL_REJECT_UNAUTHORIZED=true`.

**Why:** DO managed DB uses a CA certificate. Node’s TLS stack rejects the server cert unless the CA is trusted. Setting `DATABASE_SSL_REJECT_UNAUTHORIZED=false` works but disables verification and is insecure.

**Fix:** Add CA support in `config/database.ts` via a `readCA()` helper that:

- Reads from `DATABASE_SSL_CA_PATH` if the file exists
- Otherwise uses `DATABASE_SSL_CA` (raw PEM or base64-encoded)

With a valid CA, keep `DATABASE_SSL_REJECT_UNAUTHORIZED=true` for proper verification.

**Base64 CA generation:**

```bash
# Linux (GNU base64)
base64 -w 0 ca-certificate.crt

# macOS (BSD base64)
base64 -i ca-certificate.crt | tr -d '\n'

# Cross-platform
base64 < ca-certificate.crt | tr -d '\n'
```

**Copy tip:** In zsh, a `%` at the end of the output is the shell prompt (no trailing newline), not part of the base64 string. Do not include it when copying into `DATABASE_SSL_CA`. To avoid it: `base64 < ca-certificate.crt | tr -d '\n'; echo`

---

### 2. Dockerfile: Node base and Strapi startup

**Problem:** Strapi in Docker may fail to start or hit Corepack/Node compatibility issues.

**Fix:**

- Use `node:22-alpine` as base (per Strapi Docker docs)
- Install `vips` in build and runtime for image processing
- Copy `dist/config` → `config` so the compiled `.js` config is used at runtime
- Set `HOME=/opt/app` and create `.tmp`, `.cache`, `.config` for Strapi
- Use CMD: `node node_modules/@strapi/strapi/bin/strapi.js start` instead of `strapi start` to avoid Corepack

---

### 3. Dockerfile: Custom user and hardening

**Problem:** Running as root inside the container is a security risk.

**Fix:**

- Create `strapi` user (UID/GID 1001) in the runtime stage
- `USER strapi` before `CMD`
- Compose enforces `user: "1001:1001"` and `no-new-privileges:true`

---

### 4. Compose: Read-only filesystem

**Problem:** Strapi needs writable dirs for `.tmp`, `.cache`, `.config`, and `/tmp`.

**Fix:**

- `read_only: true` on the container
- Mount writable `tmpfs` for `/opt/app/.tmp`, `/opt/app/.cache`, `/opt/app/.config`, `/tmp` with `uid=1001,gid=1001`

---

### 5. Compose: Optional CA volume for DB SSL

**Problem:** When using `DATABASE_SSL_CA_PATH`, the CA file must exist inside the container.

**Fix:** Optional volume in `docker.compose.yml`:

```yaml
# volumes:
#   - ./certs/ca-certificate.crt:/opt/app/certs/ca.crt:ro
```

Uncomment and set `DATABASE_SSL_CA_PATH=/opt/app/certs/ca.crt` in `.env.production`.

---

### 6. Deployment: Manual deploy only

**Problem:** Deploying from GitHub Actions requires storing SSH keys and server credentials in GitHub, which increases risk.

**Fix:**

- Workflow only builds and pushes images to GHCR
- Deploy is manual: SSH to the droplet and run `./deploy.sh`
- Droplet logs into GHCR with a classic PAT (`read:packages` only)
- All production secrets stay on the droplet

---

### 7. config/database.ts: Files updated

The following files were changed for deployment:

- `config/database.ts` – CA support (`readCA`, `DATABASE_SSL_CA_PATH`, `DATABASE_SSL_CA`)
- `config/server.ts`, `config/plugins.ts`, `config/middlewares.ts` – production settings
- `.env.example` – CA options and production defaults
