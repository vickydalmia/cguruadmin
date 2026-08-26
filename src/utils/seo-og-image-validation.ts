import type { Core } from '@strapi/strapi';
import { ENTITY_UIDS, SEO_UIDS } from './changed-field-rules';

/**
 * Recommended share-card image size. 1200×630 (~1.91:1) is what Facebook and
 * twitter:card=summary_large_image render full-bleed; anything smaller is
 * upscaled or letterboxed by the platforms.
 *
 * SOFT check by request: much of the catalogue is migrated from WordPress with
 * arbitrary image sizes, so an undersized image must never block a save. The
 * editor sees the size guidance as the field's permanent description (wired in
 * src/bootstrap/field-hints.ts COMPONENT_FIELD_DESCRIPTIONS), and an
 * undersized assignment is
 * logged as a warning for ops visibility instead of thrown as a
 * ValidationError.
 */
export const OG_IMAGE_MIN_WIDTH = 1200;
export const OG_IMAGE_MIN_HEIGHT = 630;

/** Every (uid, component-field) pair that carries a share-card image. */
const OG_IMAGE_PATHS: ReadonlyArray<{
  uids: ReadonlySet<string>;
  component: 'seo' | 'entityDealPageSeo';
}> = [
  { uids: SEO_UIDS, component: 'seo' },
  { uids: new Set<string>(ENTITY_UIDS), component: 'entityDealPageSeo' },
];

// Media values arrive as file objects ({ id, ... }) from the admin content
// manager, bare numeric ids from programmatic calls, or { set: [...] }
// connectors — same folding as homepage-image-validation.ts.
const fileIdOf = (value: unknown): number | null => {
  if (value == null) return null;
  if (Array.isArray(value)) return fileIdOf(value[0]);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return fileIdOf(obj.set ?? obj.id);
  }
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function hasOwn(value: unknown, key: string): boolean {
  return Boolean(
    value &&
      typeof value === 'object' &&
      Object.prototype.hasOwnProperty.call(value, key),
  );
}

/**
 * Warns (never throws) when a save assigns an SEO ogImage smaller than
 * 1200×630 px. Dimensions are re-read from plugin::upload.file because
 * payload width/height can be stale. Returns the number of undersized images
 * so tests can assert behaviour without capturing the logger.
 */
export async function warnUndersizedSeoOgImage(
  strapi: Core.Strapi,
  uid: string,
  action: string,
  data: unknown,
): Promise<number> {
  if (!['create', 'update', 'clone'].includes(action)) return 0;
  if (!data || typeof data !== 'object') return 0;

  const checks: Array<{ component: string; fileId: number }> = [];
  for (const path of OG_IMAGE_PATHS) {
    if (!path.uids.has(uid)) continue;
    if (!hasOwn(data, path.component)) continue;
    const component = Reflect.get(data, path.component);
    if (!hasOwn(component, 'ogImage')) continue;
    const fileId = fileIdOf(Reflect.get(component, 'ogImage'));
    if (fileId == null) continue;
    checks.push({ component: path.component, fileId });
  }
  if (checks.length === 0) return 0;

  const ids = [...new Set(checks.map((check) => check.fileId))];
  const files = await strapi.db.query('plugin::upload.file').findMany({
    where: { id: { $in: ids } },
    select: ['id', 'name', 'width', 'height'],
  });
  const byId = new Map<number, any>(files.map((file: any) => [file.id, file]));

  let undersized = 0;
  for (const check of checks) {
    const file = byId.get(check.fileId);
    // Deleted mid-flight — core relation validation reports it.
    if (!file) continue;
    if (
      Number(file.width) >= OG_IMAGE_MIN_WIDTH &&
      Number(file.height) >= OG_IMAGE_MIN_HEIGHT
    ) {
      continue;
    }
    undersized += 1;
    strapi.log.warn(
      `[seo-og-image] ${uid} ${check.component}.ogImage "${file.name}" is ` +
        `${file.width ?? '?'}×${file.height ?? '?'} px — below the recommended ` +
        `${OG_IMAGE_MIN_WIDTH}×${OG_IMAGE_MIN_HEIGHT} px share-card size. ` +
        `The save was allowed; share previews may crop or upscale it.`,
    );
  }
  return undersized;
}
