# Coordinated Release Deployment Guide — Search Contract Change (cguruadmin v1.0.0 + cguru-ui v1.1.1)

A→Z steps for this coordinated two-repo release. It is coordinated because the
latest commits on each side change the search contract together:
`cguruadmin` `962d604` ("add deterministic ranking and automatic index
repair") pairs with `cguru-ui` `fa2d8cf` ("harden gateway caching and rollout
safety") — both remove the legacy `insights` search group.

## Current state at time of writing

| Repo | State |
|---|---|
| `cguruadmin` | Uncommitted: `src/api/search/services/search.test.ts` (NODE_ENV fix). **Never tagged** — no releases yet, `package.json` still `0.1.0`. |
| `cguru-ui` | Clean on code; **uncommitted docs**: `docs/README.md`, `docs/deployment-guide.md`, `docs/isr-deployment/{deployment-checklist,docker-deploy-runbook,release-deployment-runbook}.md`, and a new `docs/isr-deployment/releases/v1.1.1-production-environment.md`. Latest tag `v1.1.0`; this release is `v1.1.1`. |

Since this is `cguruadmin`'s first-ever release, some GitHub one-time setup
(Phase 3) may not exist yet — verify before assuming it's done.

## Phase 0 — Commit pending work (both repos)

**cguruadmin**
```bash
cd cguruadmin
git add src/api/search/services/search.test.ts
git commit -m "test(search): stub NODE_ENV in diagnostic-warn tests so they don't depend on ambient env"
```

**cguru-ui**
```bash
cd cguru-ui
git add docs/README.md docs/deployment-guide.md docs/isr-deployment/deployment-checklist.md \
        docs/isr-deployment/docker-deploy-runbook.md docs/isr-deployment/release-deployment-runbook.md \
        docs/isr-deployment/releases/v1.1.1-production-environment.md
git commit -m "docs: add v1.1.1 production environment guide and update deployment docs"
```

## Phase 1 — Preflight quality gates

**cguruadmin**
```bash
NODE_ENV=production yarn test    # must match Docker's build env — this is what caught the earlier bug
yarn build
docker build -t couponzguru:local .   # full parity check with the real release build
```

**cguru-ui** (from `docs/isr-deployment/release-deployment-runbook.md` §2)
```bash
node --version            # must be >=22.23.1
npm ci
npm ci --prefix isr-gateway
npm run lint
npm run check
npm run check:responsive-images
npm run test
npm run test:gateway
npm --prefix isr-gateway run typecheck
npm run build:ssr
```
Do not proceed past a failing gate.

## Phase 2 — Cut both releases

`cguruadmin` first (first-time release — no prior tag to bump from; pick a
starting version, e.g. `v1.0.0` matching `package.json`):

```bash
cd cguruadmin
git push origin main
# on GitHub: Releases → Draft a new release → tag e.g. v1.0.0 → Publish
```
Triggers `.github/workflows/release-deploy.yml`, pushing
`ghcr.io/vickydalmia/cguruadmin:v1.0.0`, `:sha-<commit>`, `:latest`.

Then `cguru-ui`:
```bash
cd cguru-ui
git push origin main
# on GitHub: Releases → Draft a new release → tag v1.1.1 → Publish
```
Pushes `cguru-ui-ssr`, `cguru-ui-tools`, `cguru-isr-gateway` at `v1.1.1`.

Wait for both workflow runs to go green before touching the droplets.

## Phase 3 — One-time GitHub setup (verify, since this is cguruadmin's first release)

On `cguruadmin`'s GitHub repo, confirm (per `docs/strapi-production-deployment.md` §2):
- Actions, Packages, Releases enabled
- A `production` environment exists (required reviewers if a manual gate is wanted)
- GHCR package visibility lets the droplet pull it

## Phase 4 — Deploy the CMS (cguruadmin) first — never the reverse

On the CMS droplet, `/opt/couponzguru`:
```bash
scp deploy/docker.compose.yml deploy/scripts/deploy.sh user@droplet:/opt/couponzguru/
```
Confirm `.env.production` on the droplet needs **no new variable names** for
this release (per `v1.1.1-production-environment.md`), just verify existing
values:
```
APP_BIND=<CMS_PRIVATE_VPC_IP>       # required by compose, never 0.0.0.0
APP_PORT=1337
RATE_LIMIT_TRUSTED_IPS=<ASTRO_PRIVATE_VPC_IP>
DATABASE_CLIENT=postgres
TRUST_PROXY=true
ISR_GATEWAY_URL=http://<ASTRO_PRIVATE_IP>:3010
ISR_ADMIN_SECRET=<SAME_SECRET_AS_GATEWAY>
```
Then:
```bash
cd /opt/couponzguru
./deploy.sh v1.0.0
```
Verify before moving to the gateway:
```bash
curl -I http://127.0.0.1:1337/_health                          # expect 204
curl -fsS -H "Authorization: Bearer $ISR_ADMIN_SECRET" \
  http://127.0.0.1:1337/api/search/status
# expect mode=postgres-sql, pgTrgmAvailable=true, empty missing/invalid arrays
# manually hit the search endpoint once (preview + one grouped query) and confirm
# the response has exactly the six groups, no "insights"
```
**Stop here if this fails.** Do not deploy the gateway against a CMS that isn't
confirmed six-group.

## Phase 4.5 — Media/image backfill (required — pending since before this release)

`migration.log` shows the WordPress migration last ran on **2026-07-15**.
Phase 15 (`migration/src/phases/15-media-formats-backfill.ts`) and the
AVIF/responsive pipeline were only added on **2026-07-19**
(`f92ab9e`, `22d3715`). Every media row migrated on the 12th/15th predates
that pipeline and is missing the new formats — this must run once against
the target DB, from your local machine (not inside the Docker deploy):

```bash
cd migration

# 1. Backfill missing responsive/AVIF formats — checkpointed, convergent, retryable
yarn migrate:phase 15-media-formats-backfill

# 2. Rebuild rich-text <img> srcsets, AFTER step 1 so it sees the new formats
yarn fix:content-srcsets                                    # dry-run first
yarn fix:content-srcsets --apply --yes-i-mean-<pg-host>

# 3. Stamp immutable cache headers on the pre-existing S3 objects
#    (new uploads already get this automatically; only old objects need it)
yarn fix:cache-headers                                      # dry-run first
yarn fix:cache-headers --apply --yes-i-mean-<bucket>
```

Separately, still pending from the July QA batch and unrelated to images —
drops the legacy Amazon columns:

```bash
yarn cleanup:legacy-fields                                  # dry-run
yarn cleanup:legacy-fields --apply --yes-i-mean-<db-host>
```

None of these four run automatically as part of `deploy.sh`/Docker — only
the two Strapi-internal search-index migrations in `database/` run
automatically on boot. All four default to dry-run and require a
target-named `--yes-i-mean-<target>` confirmation flag before writing.

## Phase 5 — Deploy the gateway + UI (cguru-ui)

On the Astro origin, `/opt/cguru-ui`, per `v1.1.1-production-environment.md`:
- No new mandatory env vars. Leave the 4 new deploy-state fields
  (`PREVIOUS_GATEWAY_TAG`, `GATEWAY_ROLLBACK_UI_BUILD_ID`, `GATEWAY_ENV_HASH`,
  `PREVIOUS_GATEWAY_ENV_HASH`) empty on first run — `deploy.sh` populates them.
- Leave the 7 new `SEARCH_*` gateway variables unset (defaults are the
  recommended production values).
- Do **not** hand-edit `env/gateway.last-good.env` / `env/gateway.previous.env`.

```bash
sudo chmod 0600 .env env/gateway.env env/ssr.env
sudo docker compose -f compose.isr.yml config --quiet
sudo ./deploy.sh v1.1.1
```
If it replaces itself with a newer `deploy.sh` and exits, re-run the same
command — expected on a script-version bump.

The script itself gates the whole thing: it runs the unique six-group
gateway→CMS search probe *before* warming/switching the UI, and aborts
(restoring the previous tag) if the CMS still returns `insights` or anything
other than a clean six-group 200.

## Phase 6 — Post-deploy verification

```bash
# CMS
curl -I https://cms.couponzguru.com/_health

# Gateway/UI
sudo docker compose -f compose.isr.yml ps
curl -fsSI https://www.couponzguru.com/
curl -fsSI https://www.couponzguru.com/robots.txt
curl -fsSI https://www.couponzguru.com/sitemap.xml

search_probe="release-check-$(date +%s)"
curl -sS -D - -o /dev/null "http://127.0.0.1:3010/api/search?query=${search_probe}&mode=preview"
curl -sS -D - -o /dev/null "http://127.0.0.1:3010/api/search?query=${search_probe}&mode=preview"
# expect X-ISR: SEARCH-MISS then SEARCH-HIT

curl -i https://www.couponzguru.com/redeem/coupon/<documentId>   # REDEEM_MISS then REDEEM_HIT
```
Also: update any external dashboard/alert keyed on the old bare
`X-ISR: SEARCH` literal to the new `SEARCH-MISS`/`SEARCH-HIT`/`SEARCH-STALE`
values — this is a breaking observability change in this release.

Full checklists to run line-by-line:
`cguru-ui/docs/isr-deployment/deployment-checklist.md` and the CMS's own §11
in `cguruadmin/docs/strapi-production-deployment.md`.

## Rollback (if needed) — exact reverse order

```bash
# UI first
cd /opt/cguru-ui && sudo ./deploy.sh --rollback
# then gateway, only with explicit acknowledgement
sudo CGURU_SEARCH_ROLLBACK_READY=true ./deploy.sh --rollback-gateway
# only now roll back the CMS
cd /opt/couponzguru && ./deploy.sh <previous-tag-or-sha>
```
Never roll the CMS back while the new (strict, no-insights) gateway is still
live — every uncached search will 502.

## Files touched by this release

Nothing else needs to change beyond:
- `cguruadmin/src/api/search/services/search.test.ts` (NODE_ENV test fix)
- `cguru-ui/docs/*` (the 5 modified + 1 new doc, currently uncommitted)
- `.env.production` on the CMS droplet and `.env`/`env/gateway.env` on the
  Astro origin — verify only, no new keys required this release
