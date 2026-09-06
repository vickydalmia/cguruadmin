import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

const BACKUP_ENV = 'BACKUP_S3_BUCKET=test-backups\nBACKUP_S3_REGION=ap-south-1\n'
  + 'BACKUP_S3_ACCESS_KEY_ID=AKIATEST\nBACKUP_S3_ACCESS_SECRET=test-secret\n';

it('audits through the new image and retains old containers on an audit failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'cguru-preflight-'));
  try {
    writeFileSync(join(root, '.env.production'), `APP_IMAGE=test-cms\nAPP_IMAGE_TAG=test\nDEPLOYMENT_COUNTRY_CODE=IN\n${BACKUP_ENV}`);
    writeFileSync(join(root, 'docker.compose.yml'), 'services: {}\n');
    writeFileSync(join(root, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$DEPLOY_TEST_LOG"
case "$*" in
  *'run --rm --no-deps --entrypoint node'*) exit 44 ;;
esac
exit 0
`, { mode: 0o755 });
    const result = spawnSync('bash', [join(process.cwd(), 'deploy/scripts/deploy.sh'), 'test'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}`, DEPLOY_TEST_LOG: join(root, 'calls') },
    });
    expect(result.status).toBe(44);
    const calls = readFileSync(join(root, 'calls'), 'utf8');
    expect(calls).toContain('deploy/scripts/check-country.cjs');
    expect(calls).not.toContain('/api/site-settings');
    expect(calls).not.toMatch(/\b(stop|up|down)\b/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('refuses to deploy a host without database backup configuration before touching Docker', () => {
  const root = mkdtempSync(join(tmpdir(), 'cguru-preflight-'));
  try {
    writeFileSync(join(root, '.env.production'),
      'APP_IMAGE=test-cms\nAPP_IMAGE_TAG=test\nDEPLOYMENT_COUNTRY_CODE=US\n'
      + 'BACKUP_S3_BUCKET=change-me-backup-bucket\nBACKUP_S3_REGION=us-east-1\nBACKUP_S3_ACCESS_KEY_ID=AKIATEST\n');
    writeFileSync(join(root, 'docker.compose.yml'), 'services: {}\n');
    writeFileSync(join(root, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$DEPLOY_TEST_LOG"
exit 0
`, { mode: 0o755 });
    const result = spawnSync('bash', [join(process.cwd(), 'deploy/scripts/deploy.sh'), 'test'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}`, DEPLOY_TEST_LOG: join(root, 'calls') },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Database backups are mandatory on every host');
    expect(result.stderr).toContain('BACKUP_S3_BUCKET');
    expect(result.stderr).toContain('BACKUP_S3_ACCESS_SECRET');
    expect(result.stderr).not.toContain('BACKUP_S3_REGION');
    expect(existsSync(join(root, 'calls'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('moves the backup runner to the admin container when the maintenance service is disabled', () => {
  const root = mkdtempSync(join(tmpdir(), 'cguru-preflight-'));
  try {
    writeFileSync(join(root, '.env.production'),
      `APP_IMAGE=test-cms\nAPP_IMAGE_TAG=test\nDEPLOYMENT_COUNTRY_CODE=IN\nMAINTENANCE_SERVICE_ENABLED=false\n${BACKUP_ENV}`);
    writeFileSync(join(root, 'docker.compose.yml'), 'services: {}\n');
    writeFileSync(join(root, 'docker'), `#!/bin/sh
printf '%s admin-runner=%s\\n' "$*" "\${ADMIN_BACKUP_RUNNER_ENABLED:-unset}" >> "$DEPLOY_TEST_LOG"
case "$*" in
  *'run --rm --no-deps --entrypoint node'*) exit 44 ;;
esac
exit 0
`, { mode: 0o755 });
    const result = spawnSync('bash', [join(process.cwd(), 'deploy/scripts/deploy.sh'), 'test'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}`, DEPLOY_TEST_LOG: join(root, 'calls') },
    });
    expect(result.status).toBe(44);
    expect(result.stdout).toContain('admin container takes database backups');
    expect(readFileSync(join(root, 'calls'), 'utf8')).toMatch(/config -q admin-runner=true/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('stops a previously enabled maintenance container even when the service is disabled', () => {
  const root = mkdtempSync(join(tmpdir(), 'cguru-preflight-'));
  try {
    writeFileSync(join(root, '.env.production'),
      `APP_IMAGE=test-cms\nAPP_IMAGE_TAG=test\nDEPLOYMENT_COUNTRY_CODE=IN\nMAINTENANCE_SERVICE_ENABLED=false\n${BACKUP_ENV}`);
    writeFileSync(join(root, 'docker.compose.yml'), 'services: {}\n');
    // The audit passes; the fake stops the run at the first `up` so nothing
    // waits on health checks.
    writeFileSync(join(root, 'docker'), `#!/bin/sh
printf '%s profiles=%s\\n' "$*" "\${COMPOSE_PROFILES:-unset}" >> "$DEPLOY_TEST_LOG"
case "$*" in
  *'up -d --force-recreate'*) exit 45 ;;
esac
exit 0
`, { mode: 0o755 });
    const result = spawnSync('bash', [join(process.cwd(), 'deploy/scripts/deploy.sh'), 'test'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}`, DEPLOY_TEST_LOG: join(root, 'calls') },
    });
    expect(result.status).toBe(45);
    const calls = readFileSync(join(root, 'calls'), 'utf8');
    expect(calls).toMatch(/stop --timeout 60 strapi-maintenance strapi profiles=translation/);
    expect(calls).toMatch(/up -d --force-recreate --timeout 60 strapi profiles=unset$/m);
    expect(calls).not.toMatch(/up -d --force-recreate --timeout 60 strapi-maintenance/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
