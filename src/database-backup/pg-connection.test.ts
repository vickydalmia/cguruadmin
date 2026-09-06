import { describe, expect, it } from 'vitest';

import { buildPgInvocation, decodeCaPem, parseConnection, planSsl, redactSecrets } from './pg-connection';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
const options = { compression: 'zstd:3', caFilePath: '/opt/app/.tmp/database-backup/ca-abc.pem' };

describe('parseConnection', () => {
  it('prefers DATABASE_URL and decodes the password', () => {
    const connection = parseConnection({
      DATABASE_URL: 'postgres://strapi:p%40ss%3Aword@db-host.example.com:25060/strapi?sslmode=require&sslrootcert=/x',
      DATABASE_HOST: 'ignored',
      DATABASE_SCHEMA: 'public',
    });
    expect(connection).toEqual({
      host: 'db-host.example.com', port: '25060', database: 'strapi', user: 'strapi', password: 'p@ss:word', schema: 'public',
    });
  });

  it('falls back to the discrete variables with Strapi defaults', () => {
    expect(parseConnection({ DATABASE_NAME: 'cg', DATABASE_PASSWORD: 'secret' })).toEqual({
      host: 'localhost', port: '5432', database: 'cg', user: 'strapi', password: 'secret', schema: 'public',
    });
  });

  it('rejects a non-postgres URL', () => {
    expect(() => parseConnection({ DATABASE_URL: 'mysql://a:b@c/d' })).toThrow('postgres://');
    expect(() => parseConnection({ DATABASE_URL: 'not a url' })).toThrow('not a valid URL');
  });
});

describe('planSsl', () => {
  it('covers the four cases', () => {
    expect(planSsl({ DATABASE_SSL: 'false' })).toEqual({ mode: 'prefer' });
    expect(planSsl({})).toEqual({ mode: 'prefer' });
    expect(planSsl({ DATABASE_SSL: 'true', DATABASE_SSL_CA_PATH: '/certs/ca.crt' })).toEqual({ mode: 'verify-full', rootCert: 'file' });
    expect(planSsl({ DATABASE_SSL: 'true', DATABASE_SSL_CA: Buffer.from(PEM).toString('base64') })).toEqual({ mode: 'verify-full', rootCert: 'file' });
    expect(planSsl({ DATABASE_SSL: 'true', DATABASE_SSL_REJECT_UNAUTHORIZED: 'false' })).toEqual({ mode: 'require' });
    expect(planSsl({ DATABASE_SSL: 'true' })).toEqual({ mode: 'verify-full', rootCert: 'system' });
  });
});

describe('decodeCaPem', () => {
  it('accepts raw and base64 PEM and rejects garbage', () => {
    expect(decodeCaPem(PEM)).toBe(PEM);
    expect(decodeCaPem(Buffer.from(PEM).toString('base64'))).toBe(PEM);
    expect(decodeCaPem('bm90IGEgY2VydA==')).toBeNull();
    expect(decodeCaPem('')).toBeNull();
  });
});

describe('buildPgInvocation', () => {
  it('passes the connection only through an allow-listed environment', () => {
    const invocation = buildPgInvocation({
      DATABASE_URL: 'postgres://strapi:s3cret@db:25060/strapi?sslmode=disable',
      DATABASE_SSL: 'true',
      DATABASE_SSL_CA: Buffer.from(PEM).toString('base64'),
      PATH: '/usr/bin',
      HOME: '/opt/app',
    }, options);

    expect(invocation.childEnv).toEqual({
      PATH: '/usr/bin', HOME: '/opt/app', LANG: 'C.UTF-8',
      PGHOST: 'db', PGPORT: '25060', PGDATABASE: 'strapi', PGUSER: 'strapi', PGPASSWORD: 's3cret',
      PGCONNECT_TIMEOUT: '15', PGAPPNAME: 'cguru-db-backup',
      PGSSLMODE: 'verify-full', PGSSLROOTCERT: options.caFilePath,
    });
    expect(invocation.dumpArgs).toEqual([
      '--format=custom', '--compress=zstd:3', '--schema=public', '--no-owner', '--no-acl', '--no-password', '--lock-wait-timeout=60000',
    ]);
    expect(invocation.dumpArgs.join(' ')).not.toContain('s3cret');
    expect(invocation.caPem).toBe(PEM);
    expect(invocation.caPath).toBeNull();
    expect(invocation.secrets).toEqual(['s3cret']);
  });

  it('uses an existing CA path verbatim and the system store when no CA is given', () => {
    const withPath = buildPgInvocation({ DATABASE_SSL: 'true', DATABASE_SSL_CA_PATH: '/certs/ca.crt' }, options);
    expect(withPath.childEnv.PGSSLROOTCERT).toBe('/certs/ca.crt');
    expect(withPath.caPem).toBeNull();
    const system = buildPgInvocation({ DATABASE_SSL: 'true' }, options);
    expect(system.childEnv.PGSSLROOTCERT).toBe('system');
    const plain = buildPgInvocation({}, options);
    expect(plain.childEnv.PGSSLMODE).toBe('prefer');
    expect(plain.childEnv.PGSSLROOTCERT).toBeUndefined();
  });
});

describe('redactSecrets', () => {
  it('masks the password wherever it appears', () => {
    const text = 'FATAL: password authentication failed; PGPASSWORD=s3cret url=postgres://strapi:s3cret@db/x';
    expect(redactSecrets(text, ['s3cret'])).toBe(
      'FATAL: password authentication failed; PGPASSWORD=*** url=postgres://strapi:***@db/x',
    );
    expect(redactSecrets('postgres://u:other@h/db', [])).toBe('postgres://u:***@h/db');
    expect(redactSecrets('clean', [''])).toBe('clean');
  });
});
