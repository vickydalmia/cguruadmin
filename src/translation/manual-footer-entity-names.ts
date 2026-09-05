import type { Core } from '@strapi/strapi';
import { DEFAULT_CONTENT_LOCALE } from '../constants/content-locales';

// Runtime-only evidence, never a synthetic relation or a persisted CMS field.
const verifiedNames = new WeakMap<object, { url: string; name: string }>();

function entitySlug(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  // Only an unprefixed, root-relative entity route is authoritative here.
  // Never trust a matching path on an external origin, or normalize traversal.
  return /^\/([a-zA-Z0-9_-]+)\/?(?:[?#][^\s]*)?$/u.exec(url.trim())?.[1];
}

export function manualFooterEntityName(link: any): string | undefined {
  const verified = link && typeof link === 'object' ? verifiedNames.get(link) : undefined;
  return verified && !link.store && !link.category && link.url === verified.url
    && typeof link.label === 'string' && link.label.trim() === verified.name
    ? verified.name : undefined;
}

/** Batch verification shared by single-entry translation and repair scans. */
export async function verifyManualFooterEntityNames(
  strapi: Core.Strapi,
  uid: string,
  entries: readonly any[],
  locale: string,
): Promise<void> {
  if (uid !== 'api::footer.footer' || locale !== DEFAULT_CONTENT_LOCALE) return;
  const candidates: Array<{ link: any; slug: string }> = [];
  for (const entry of entries) {
    for (const section of entry?.sections ?? []) {
      for (const link of section?.links ?? []) {
        if (!link || typeof link !== 'object') continue;
        verifiedNames.delete(link);
        const slug = entitySlug(link.url);
        if (slug && !link.store && !link.category && typeof link.label === 'string') {
          candidates.push({ link, slug });
        }
      }
    }
  }
  const slugs = [...new Set(candidates.map(({ slug }) => slug))];
  const bySlug = new Map<string, Map<string, string>>();
  for (let offset = 0; offset < slugs.length; offset += 100) {
    for (const entityUid of ['api::store.store', 'api::brand.brand', 'api::category.category', 'api::bank.bank']) {
      const entities = await strapi.db.query(entityUid as any).findMany({
        where: { locale: DEFAULT_CONTENT_LOCALE, slug: { $in: slugs.slice(offset, offset + 100) } },
        select: ['documentId', 'slug', 'name'],
      });
      for (const entity of entities) {
        if (!entity.documentId || typeof entity.name !== 'string') continue;
        const matches = bySlug.get(entity.slug) ?? new Map<string, string>();
        // Reject conflicting rows even if they share a document identity.
        matches.set(`${entityUid}:${entity.documentId}:${entity.name.trim()}`, entity.name.trim());
        bySlug.set(entity.slug, matches);
      }
    }
  }
  for (const { link, slug } of candidates) {
    const matches = bySlug.get(slug);
    if (matches?.size !== 1) continue;
    const name = [...matches.values()][0];
    if (name && link.label.trim() === name) verifiedNames.set(link, { url: link.url, name });
  }
}
