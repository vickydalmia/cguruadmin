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
- `deploy/compose.prod.yml`
- `deploy/scripts/deploy.sh`
- `deploy/nginx.conf`
- `deploy/site.nginx.conf`
- `.github/workflows/release-deploy.yml`
- `docs/strapi-production-deployment.md`

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

The `Dockerfile` uses a multi-stage build on `node:24-bookworm-slim`:

| Stage | Purpose |
| --- | --- |
| `base` | Slim Node 24 image, enables Corepack + Yarn 1.22 |
| `build` | Installs all deps (dev + prod), compiles native addons, runs `yarn build`, then prunes dev dependencies |
| `runtime` | Copies only production `node_modules` and build artifacts, creates a custom `strapi` user (UID 1001), runs as non-root |

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
- DNS ready for the Strapi public URL, for example `cms.example.com`

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
- leave `S3_ACL` blank for providers that do not support ACLs, such as Cloudflare R2

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
├── compose.prod.yml      # copied from repo deploy/compose.prod.yml
├── deploy.sh             # copied from repo deploy/scripts/deploy.sh
└── .env.production       # manually created, stays on server
```

Copy the deployment files from the repo:

```bash
scp deploy/compose.prod.yml deploy/scripts/deploy.sh user@droplet:/opt/couponzguru/
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
HOST=0.0.0.0
PORT=1337
APP_PORT=1337
PUBLIC_URL=https://cms.example.com
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
S3_ENDPOINT=
S3_FORCE_PATH_STYLE=false
S3_BASE_URL=https://cdn.example.com
S3_ROOT_PATH=
S3_ACL=private
S3_SIGNED_URL_EXPIRES=900
S3_PREVENT_OVERWRITE=true
S3_CHECKSUM_ALGORITHM=CRC64NVME
S3_ENCRYPTION_TYPE=AES256
S3_KMS_KEY_ID=
S3_MULTIPART_PART_SIZE=10485760
S3_MULTIPART_QUEUE_SIZE=4
S3_OBJECT_TAG_APPLICATION=couponzguru
UPLOAD_CSP_SOURCES=https://cdn.example.com,https://bucket.s3.ap-south-1.amazonaws.com
```

Important:

- `DATABASE_CLIENT` must be `postgres` in production.
- `PUBLIC_URL` must be the final HTTPS URL exposed to the public.
- `TRUST_PROXY=true` is required because Nginx sits in front of Strapi.
- DigitalOcean Managed PostgreSQL uses port `25060` and requires SSL.
- Keep `APP_PORT=1337` unless you also change the upstream port in `deploy/site.nginx.conf`.

### Database SSL CA (DigitalOcean managed DB)

DigitalOcean managed PostgreSQL uses a CA certificate. For proper verification (instead of `DATABASE_SSL_REJECT_UNAUTHORIZED=false`), provide the CA:

1. **Option A – file path**: Download the CA from the DO database dashboard, place it on the droplet (e.g. `deploy/certs/ca-certificate.crt`), uncomment the `volumes` block in `deploy/compose.prod.yml`, and set `DATABASE_SSL_CA_PATH=/opt/app/certs/ca.crt`.
2. **Option B – base64 in env**: Encode the CA with `base64 -w 0 ca-certificate.crt` and set `DATABASE_SSL_CA=<output>` in `.env.production`.
3. **Option C – raw PEM**: Set `DATABASE_SSL_CA` to the PEM content with `\n` for newlines.

With a valid CA, keep `DATABASE_SSL_REJECT_UNAUTHORIZED=true`.

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
# Set the image (only needed once, or add APP_IMAGE to .env.production)
export APP_IMAGE=ghcr.io/OWNER/REPO

# Deploy the latest tag
./deploy.sh
```

The script pulls, starts, health-checks, and reports success or failure.

Verify manually:

```bash
# Container should show "healthy"
docker compose -f compose.prod.yml ps

# Should return HTTP 204
curl -I http://127.0.0.1:1337/_health

# Confirm the container runs as the strapi user (uid=1001)
docker compose -f compose.prod.yml exec strapi id

# Verify through the load balancer
curl -I https://cms.example.com/_health
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

1. Validates `compose.prod.yml` and `.env.production` exist
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

## 11. Post-release validation checklist

After every release, verify:

- the GitHub Actions workflow completed successfully
- `docker compose -f compose.prod.yml ps` shows `strapi` as healthy
- `https://cms.example.com/_health` returns `204`
- the admin panel loads at the expected public URL
- a media upload succeeds and is stored in the S3-compatible bucket
- uploaded media previews load correctly in the admin panel
- the application connects to PostgreSQL successfully

Useful commands:

```bash
cd /opt/couponzguru
docker compose -f compose.prod.yml ps
docker compose -f compose.prod.yml logs --tail=200 strapi
docker image ls 'ghcr.io/*'
```

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
docker compose -f compose.prod.yml logs --tail=200 strapi
```

Common causes:

- missing or malformed `.env.production`
- `DATABASE_CLIENT` left as default SQLite instead of `postgres`
- invalid `DATABASE_URL`
- unreachable PostgreSQL host or blocked firewall
- wrong `PUBLIC_URL`
- missing `APP_KEYS` or JWT secrets

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

- `PUBLIC_URL=https://cms.example.com`
- `TRUST_PROXY=true`
- DNS points to the Nginx load balancer
- Nginx upstream block includes the correct backend IPs and ports

## 15. Docker commands reference

All commands assume you are in the deployment directory (`/opt/couponzguru`) and `APP_IMAGE` / `APP_IMAGE_TAG` are exported.

### Service lifecycle

```bash
# Start the service
docker compose -f compose.prod.yml up -d strapi

# Stop the service (keeps container)
docker compose -f compose.prod.yml stop strapi

# Stop and remove the container
docker compose -f compose.prod.yml down

# Restart the service
docker compose -f compose.prod.yml restart strapi

# Force recreate (new container from same image)
docker compose -f compose.prod.yml up -d --force-recreate strapi
```

### Health and status

```bash
# Show service status and health
docker compose -f compose.prod.yml ps

# Check health via container inspect
docker compose -f compose.prod.yml ps -q strapi | xargs docker inspect --format='{{.State.Health.Status}}'

# Quick loopback health check
curl -I http://127.0.0.1:1337/_health
```

### Logs

```bash
# Last 200 lines
docker compose -f compose.prod.yml logs --tail=200 strapi

# Follow live logs
docker compose -f compose.prod.yml logs -f strapi

# Logs since a specific time
docker compose -f compose.prod.yml logs --since=1h strapi
```

### Image management

```bash
# Pull the latest tagged image
docker compose -f compose.prod.yml pull strapi

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
docker compose -f compose.prod.yml exec strapi /bin/sh

# Run a one-off command in a new container
docker compose -f compose.prod.yml run --rm strapi node -e "console.log(process.env.NODE_ENV)"

# Check which user the container runs as
docker compose -f compose.prod.yml exec strapi id

# Check container resource usage
docker stats --no-stream

# Inspect the full container config
docker compose -f compose.prod.yml ps -q strapi | xargs docker inspect
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
