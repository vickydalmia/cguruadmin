import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import type { Core } from '@strapi/strapi';
import { rebuildConfig } from './queue';

const execFileAsync = promisify(execFile);

export interface RebuildJob {
  full: boolean;
  homepage: boolean;
  sitemap: boolean;
  slugs: string[];
  reasons: string[];
}

const SHA_MARKER = '.last-full-deploy-sha';

async function gitSha(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD']);
    return stdout.trim();
  } catch {
    return null; // not a git checkout — SHA guard disabled
  }
}

function runBuild(strapi: Core.Strapi, job: RebuildJob, frontendDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const logDir = path.join(frontendDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `rebuild-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    const logStream = fs.createWriteStream(logPath);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      STRAPI_URL: 'http://127.0.0.1:1337',
      STRAPI_MEDIA_URL: process.env.STRAPI_MEDIA_URL || '',
      PUBLIC_SITE_URL: process.env.PUBLIC_SITE_URL || '',
      PUBLIC_ALLOW_INDEXING: 'true',
    };
    if (!job.full) {
      // Surgical: only these entity pages (homepage & friends always build).
      env.ONLY_SLUGS = job.slugs.join(',');
    } else {
      delete env.ONLY_SLUGS;
    }

    strapi.log.info(
      `[rebuild] building ${job.full ? 'FULL' : `surgical (${job.slugs.length} page(s)${job.homepage ? ' + homepage' : ''})`} → ${logPath}`
    );

    // Low CPU priority: Strapi/Postgres always win the scheduler over a
    // build, so admin/API latency stays flat even during full builds.
    const child = spawn('nice', ['-n', '10', 'npm', 'run', 'build'], {
      cwd: frontendDir,
      env,
    });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
    child.on('error', reject);
    child.on('close', (code) => {
      logStream.end();
      if (code === 0) resolve();
      else reject(new Error(`build exited with code ${code} (log: ${logPath})`));
    });
  });
}

async function aws(args: string[]): Promise<void> {
  await execFileAsync('aws', args, { maxBuffer: 16 * 1024 * 1024 });
}

// Freshness model: HTML (and sitemap/robots) carry a short shared-cache TTL
// with stale-while-revalidate, so CloudFront refreshes them from S3 within
// ~REBUILD_HTML_TTL seconds of a deploy — NO per-page invalidations (metered
// at $0.005/path past 1,000/month; S3 refresh GETs cost ~nothing and
// S3→CloudFront transfer is free). Hashed assets stay immutable for a year.
// REQUIRES the CloudFront cache policy to honor origin Cache-Control headers
// (runbook §4.2). The single '/*' invalidation on FULL builds remains for
// instant chrome fixes (1 path — always within the free tier).
function htmlCacheControl(): string {
  const ttl = Number(process.env.REBUILD_HTML_TTL) || 60;
  return `public, max-age=0, s-maxage=${ttl}, stale-while-revalidate=${ttl * 5}`;
}
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

async function deployFull(strapi: Core.Strapi, frontendDir: string, bucket: string, distributionId: string) {
  const dist = path.join(frontendDir, 'dist');

  // Hashed assets first (immutable, own --delete scope cleans stale hashes),
  // then everything else with the short-TTL header. --exclude also excludes
  // from deletion, so pass 2 never touches /_astro.
  await aws([
    's3', 'sync', path.join(dist, '_astro'), `s3://${bucket}/_astro`,
    '--delete', '--cache-control', IMMUTABLE_CACHE,
  ]);
  await aws([
    's3', 'sync', dist, `s3://${bucket}`,
    '--delete', '--exclude', '_astro/*', '--cache-control', htmlCacheControl(),
  ]);
  await aws(['cloudfront', 'create-invalidation', '--distribution-id', distributionId, '--paths', '/*']);

  const sha = await gitSha(frontendDir);
  if (sha) fs.writeFileSync(path.join(frontendDir, SHA_MARKER), sha);
  strapi.log.info('[rebuild] FULL deploy complete (sync --delete, invalidated /*)');
}

async function deploySurgical(
  strapi: Core.Strapi,
  job: RebuildJob,
  frontendDir: string,
  bucket: string,
  _distributionId: string,
) {
  const dist = path.join(frontendDir, 'dist');
  const cacheControl = htmlCacheControl();

  // Hashed assets are additive — never --delete outside a full deploy
  // (a partial dist would wipe every other page; runbook caveat 8.6).
  await aws([
    's3', 'sync', path.join(dist, '_astro'), `s3://${bucket}/_astro`,
    '--cache-control', IMMUTABLE_CACHE,
  ]);

  const deployed: string[] = [];

  if (job.homepage) {
    await aws(['s3', 'cp', path.join(dist, 'index.html'), `s3://${bucket}/index.html`, '--cache-control', cacheControl]);
    deployed.push('/');
  }
  for (const slug of job.slugs) {
    const file = path.join(dist, slug, 'index.html');
    if (!fs.existsSync(file)) {
      strapi.log.warn(`[rebuild] expected page missing from build output: ${slug} — skipped`);
      continue;
    }
    await aws(['s3', 'cp', file, `s3://${bucket}/${slug}/index.html`, '--cache-control', cacheControl]);
    deployed.push(`/${slug}/`);
  }

  // Sitemap enumerates ALL routes regardless of ONLY_SLUGS — always current.
  const sitemap = path.join(dist, 'sitemap.xml');
  if (fs.existsSync(sitemap)) {
    await aws(['s3', 'cp', sitemap, `s3://${bucket}/sitemap.xml`, '--cache-control', cacheControl]);
    deployed.push('/sitemap.xml');
  }

  // No invalidations here: the short TTL refreshes these paths within
  // ~REBUILD_HTML_TTL seconds at zero cost.
  strapi.log.info(`[rebuild] surgical deploy complete (${deployed.join(', ') || 'nothing uploaded'}; live within TTL)`);
}

// ISR mode (REBUILD_MODE=redis, spec §18 in cguru-ui/docs/isr-deployment/
// isr-redis-plan.md): instead of building + deploying to S3, the scope is
// POSTed to the ISR gateway's /revalidate — the gateway re-renders those
// pages into Redis and CloudFront picks them up within its s-maxage window.
// Full/chrome scopes send all=true (real full re-render, gateway-side).
export function redisRevalidatePayload(job: RebuildJob) {
  return job.full
    ? { all: true }
    : {
        paths: [
          ...(job.homepage ? ['/'] : []),
          ...(job.sitemap ? ['/sitemap.xml'] : []),
          ...job.slugs.map((slug) => `/${slug}/`),
        ],
        ...(job.sitemap ? { scopes: ['routes'] } : {}),
      };
}

async function executeRedisRevalidate(strapi: Core.Strapi, job: RebuildJob): Promise<void> {
  const gatewayUrl = process.env.ISR_GATEWAY_URL?.trim();
  const secret = process.env.ISR_REVALIDATE_SECRET?.trim();
  if (!gatewayUrl || !secret) {
    throw new Error('REBUILD_MODE=redis requires ISR_GATEWAY_URL and ISR_REVALIDATE_SECRET');
  }

  const payload = redisRevalidatePayload(job);

  // Generous timeout: the gateway answers 202 after a Redis enqueue, but when
  // it is busy (mid-sweep) a tight timeout aborts an ALREADY-ACCEPTED request
  // and the retry then queues a duplicate full sweep. The gateway coalesces
  // duplicates, but not timing out in the first place is cheaper.
  const response = await fetch(`${gatewayUrl.replace(/\/+$/, '')}/revalidate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(rebuildConfig().postTimeoutMs),
  });

  if (!response.ok) {
    // Includes the gateway's 503 on routeset-sync failure — throwing here
    // feeds the queue's retry semantics, so route changes are never dropped.
    throw new Error(`ISR revalidate failed: ${response.status} ${await response.text()}`);
  }

  const result = (await response.json().catch(() => ({}))) as {
    queued?: number | boolean;
    accepted?: string[];
    skippedNonManifest?: string[];
  };

  if (result.skippedNonManifest && result.skippedNonManifest.length > 0) {
    // Post-sync skip = the path is genuinely not a public route (e.g. an
    // entity with no page). Not retryable, but must be visible.
    strapi.log.warn(
      `[rebuild] ISR revalidate skipped non-manifest path(s): ${result.skippedNonManifest.join(', ')}`
    );
  }

  strapi.log.info(
    `[rebuild] ISR revalidate sent: ${
      job.full
        ? 'all=true (full re-render)'
        : `${result.accepted?.length ?? (payload as any).paths.length}/${(payload as any).paths.length} path(s) accepted`
    }`
  );
}

export async function executeRebuild(strapi: Core.Strapi, job: RebuildJob): Promise<void> {
  // ISR-first: redis revalidation is the DEFAULT delivery mode. Set
  // REBUILD_MODE=static explicitly for S3 static deploys (DR snapshots,
  // or a full fallback rollout).
  if (process.env.REBUILD_MODE !== 'static') {
    await executeRedisRevalidate(strapi, job);
    return;
  }

  const config = rebuildConfig();
  if (!config.frontendDir || !config.siteBucket || !config.distributionId) {
    throw new Error(
      'rebuild misconfigured: FRONTEND_DIR, SITE_BUCKET and CLOUDFRONT_DISTRIBUTION_ID are required'
    );
  }

  // Code-change guard: frontend checkout moved since the last full deploy →
  // hashed bundle names changed → a subset deploy would mix versions.
  if (!job.full) {
    const sha = await gitSha(config.frontendDir);
    const markerPath = path.join(config.frontendDir, SHA_MARKER);
    const lastFullSha = fs.existsSync(markerPath)
      ? fs.readFileSync(markerPath, 'utf8').trim()
      : null;
    if (sha && sha !== lastFullSha) {
      strapi.log.info('[rebuild] frontend code changed since last full deploy — escalating to FULL');
      job = { ...job, full: true };
    }
  }

  await runBuild(strapi, job, config.frontendDir);

  if (job.full) {
    await deployFull(strapi, config.frontendDir, config.siteBucket, config.distributionId);
  } else {
    await deploySurgical(strapi, job, config.frontendDir, config.siteBucket, config.distributionId);
  }
}
