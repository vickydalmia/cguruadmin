import type { IsrOutboxPayload } from '../../../isr-outbox/types';
import { createHash } from 'node:crypto';

export type RefreshLanguage = { code: string; name: string; pathPrefix: string };

export function canonicalPagePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1000 || !value.startsWith('/') || value.startsWith('//') || /[?#\\\s]/.test(value)) {
    throw new Error('Enter a website path such as /about-us/, without a domain or query string.');
  }
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { throw new Error('Invalid encoded website path.'); }
  if (decoded.split('/').some((segment) => segment === '.' || segment === '..') ||
    !/^\/(?:[\p{L}\p{N}_.-]+\/)*[\p{L}\p{N}_.-]*\/?$/u.test(decoded) || /%2f|%5c/i.test(value)) {
    throw new Error('Invalid website path.');
  }
  const path = decoded.split('/').map(encodeURIComponent).join('/');
  return path === '/' || path.endsWith('/') || /\.(?:xml|txt)$/i.test(path) ? path : `${path}/`;
}

export function buildRefreshRequest(body: unknown, languages: RefreshLanguage[]): { payload: IsrOutboxPayload; eventKey: string } {
  const input = body as Record<string, unknown> | null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid refresh request.');
  const language = languages.find((entry) => entry.code === input.locale);
  if (input.locale !== '*' && !language) throw new Error('Select an enabled website language.');
  if (input.all !== true && input.all !== false) throw new Error('Choose a page or the entire website.');
  if (input.all && input.confirm !== true) throw new Error('Confirm the whole-website refresh.');
  const prefixes = languages.map((entry) => entry.pathPrefix).filter(Boolean).sort();
  const path = input.all ? undefined : canonicalPagePath(input.path);
  if (path && prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    throw new Error('Enter the English page path and choose the language separately.');
  }
  const payload: IsrOutboxPayload = {
    manualRefresh: true,
    ...(input.locale === 'en' ? { excludeLocalePrefixes: prefixes } : {}),
    ...(language?.pathPrefix ? { localePrefix: language.pathPrefix } : {}),
    ...(input.all ? { all: true as const } : {
      paths: input.locale === '*' ? [path!, ...prefixes.map((prefix) => path === '/' ? `${prefix}/` : `${prefix}${path}`)] : [path!],
    }),
    scopes: ['chrome', 'insights', 'error-page'],
  };
  if (payload.paths) payload.optionalPaths = [...payload.paths];
  // Coalesce repeated pending clicks, including the exact configured language set.
  return { payload, eventKey: createHash('sha256').update(JSON.stringify([input.locale, prefixes, path ?? '*'])).digest('hex') };
}
