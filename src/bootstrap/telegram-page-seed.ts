import type { Core } from '@strapi/strapi';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONTENT_LOCALE } from '../constants/content-locales';
import { TELEGRAM_PAGE_UID } from '../constants/telegram';
import { acquireWriteSerializationLock } from '../utils/write-serialization';
import seed from '../api/telegram-page/content/telegram-page-seed.json';
import { withTelegramLease } from '../telegram/worker-lease';

// One-time seed of the Join Telegram page with the Figma content. Runs on
// every boot but writes ONLY when the single type has no row, or a row with
// no content in any section (the empty row Content Manager creates on a
// first save). Anything an editor has authored survives every later
// deployment. Assets ship under <app>/seed/telegram-page and are uploaded
// into the Media Library once, into their own folder, so editors can swap
// them like any other media.

export const TELEGRAM_PAGE_MEDIA_FOLDER_NAME = 'Telegram Page';
/** Core-store marker: set once the seed ran, so a deleted page is never resurrected. */
export const TELEGRAM_PAGE_SEED_MARKER = { store: { type: 'core', name: 'telegram-page' } as const, key: 'initial-content-v1' };
const SEED_ASSET_DIRECTORY = ['seed', 'telegram-page'];

type SeedImage = string | null | undefined;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

async function ensureFolder(strapi: Core.Strapi): Promise<number | null> {
  const folders: any = strapi.db.query('plugin::upload.folder');
  const existing = await folders.findOne({
    where: { name: TELEGRAM_PAGE_MEDIA_FOLDER_NAME },
    select: ['id'],
  });
  if (existing?.id) return existing.id;
  const created = await strapi.plugin('upload').service('folder').create({
    name: TELEGRAM_PAGE_MEDIA_FOLDER_NAME,
    parent: null,
  });
  return created?.id ?? null;
}

/** Upload one seed asset (or reuse an identically named file in the folder). */
async function uploadSeedAsset(
  strapi: Core.Strapi,
  folderId: number | null,
  fileName: SeedImage,
  alternativeText: string | null,
): Promise<number | null> {
  if (!fileName) return null;
  const files: any = strapi.db.query('plugin::upload.file');
  const existing = await files.findOne({
    where: { name: fileName, ...(folderId ? { folder: folderId } : {}) },
    select: ['id'],
  });
  if (existing?.id) return existing.id;

  const filepath = path.join((strapi as any).dirs.app.root, ...SEED_ASSET_DIRECTORY, fileName);
  let size: number;
  try {
    size = (await fs.stat(filepath)).size;
  } catch {
    strapi.log.warn(`[telegram-page] seed asset missing: ${fileName}`);
    return null;
  }
  const mimetype = MIME_BY_EXTENSION[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream';
  const uploadService: any = strapi.plugin('upload').service('upload');
  const [uploaded] = await uploadService.upload({
    data: { fileInfo: { name: fileName, alternativeText, caption: null, folder: folderId } },
    files: [{ filepath, originalFilename: fileName, mimetype, detectedMimeType: mimetype, size }],
  });
  return uploaded?.id ?? null;
}

/**
 * Existing Stores matched by name (case-insensitive), in seed order, as
 * numeric entry ids. Numeric ids are what the entity validator counts
 * against the store table; documentId strings are only translated later in
 * the document-service pipeline, so they fail the pre-check on Postgres.
 */
async function storeIdsByName(strapi: Core.Strapi, names: readonly string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const name of names) {
    const row: any = await strapi.db.query('api::store.store').findOne({
      where: { name: { $eqi: name }, locale: DEFAULT_CONTENT_LOCALE },
      select: ['id'],
    });
    if (typeof row?.id === 'number' && !ids.includes(row.id)) ids.push(row.id);
  }
  return ids;
}

export async function buildTelegramPageSeedData(strapi: Core.Strapi): Promise<Record<string, unknown>> {
  const folderId = await ensureFolder(strapi);
  const image = (name: SeedImage, alt: string | null) => uploadSeedAsset(strapi, folderId, name, alt);
  const { _comment, ...content } = seed as any;
  const hero = content.hero ?? {};
  const benefits = content.benefits ?? {};
  const { storeNames, ...favouriteStores } = content.favouriteStores ?? {};

  return {
    ...content,
    hero: {
      ...hero,
      previewCards: await Promise.all(
        (hero.previewCards ?? []).map(async (card: any) => ({
          ...card,
          icon: await image(card.icon, card.title ?? null),
        })),
      ),
    },
    benefits: {
      ...benefits,
      phoneImage: await image(benefits.phoneImage, benefits.phoneImageAlt ?? null),
      floatingCards: await Promise.all(
        (benefits.floatingCards ?? []).map(async (card: any) => ({
          ...card,
          icon: await image(card.icon, card.title ?? null),
        })),
      ),
    },
    favouriteStores: {
      ...favouriteStores,
      stores: await storeIdsByName(strapi, Array.isArray(storeNames) ? storeNames : []),
    },
  };
}

const hasText = (value: unknown) => typeof value === 'string' && value.trim().length > 0;

/** True when no section carries editor content (a fresh or never-filled row). */
export function isTelegramPageEmpty(row: any): boolean {
  if (!row) return true;
  return (
    !hasText(row.hero?.titleLead) &&
    !hasText(row.hero?.subtitle) &&
    !hasText(row.benefits?.heading) &&
    !(row.benefits?.features?.length > 0) &&
    !hasText(row.latestDeals?.heading) &&
    !hasText(row.favouriteStores?.heading) &&
    !(row.faq?.items?.length > 0) &&
    !hasText(row.joinCta?.heading) &&
    !hasText(row.seo?.metaTitle)
  );
}

/**
 * Create the Telegram Page from the seed when it does not exist, or fill it
 * when it exists without any content. A row that carries content is never
 * touched. Logged and swallowed: a seed problem must never keep the admin
 * from booting.
 */
export async function ensureTelegramPageSeed(strapi: Core.Strapi): Promise<boolean> {
  const marker = strapi.store(TELEGRAM_PAGE_SEED_MARKER.store);
  const { key } = TELEGRAM_PAGE_SEED_MARKER;
  try {
    if (await marker.get({ key })) {
      strapi.log.info('[telegram-page] seed marker present; skipping');
      return false;
    }
    return await withTelegramLease(strapi, 'page-seed', async lease => {
    if (await marker.get({ key })) return false;
    const initial = await readSeedPage(strapi);
    // Network preparation runs without a transaction or shared identity lock.
    const data = isTelegramPageEmpty(initial) ? await buildTelegramPageSeedData(strapi) : null;
    let seeded = false;
    await strapi.db.transaction(async ({ trx }: any) => {
      await lease.assertOwned(trx);
      await acquireWriteSerializationLock(strapi, 'identity', trx);
      if (await marker.get({ key })) return;
      const existing: any = await readSeedPage(strapi);
      if (data && isTelegramPageEmpty(existing)) {
        if (existing) {
          // Keep whatever routing state the editor already chose on the empty row.
          const { enabled, slug, ...sections } = data as any;
          await strapi.documents(TELEGRAM_PAGE_UID as any).update({
              documentId: existing.documentId,
              locale: DEFAULT_CONTENT_LOCALE,
              data: sections,
            });
          strapi.log.info('[telegram-page] filled the empty Telegram Page with the design content');
        } else {
          await strapi.documents(TELEGRAM_PAGE_UID as any).create({
              locale: DEFAULT_CONTENT_LOCALE,
              data: data as any,
            });
          strapi.log.info('[telegram-page] seeded the Telegram Page with the design content (disabled until an editor switches it on)');
        }
        seeded = true;

      } else {
        strapi.log.info('[telegram-page] Telegram Page already carries content; seed skipped');
      }
      await marker.set({ key, value: true });
    });
    return seeded;
    }) ?? false;
  } catch (err: any) {
    strapi.log.error(`[telegram-page] seed failed: ${err?.message ?? err}`);
    return false;
  }
}

async function readSeedPage(strapi: Core.Strapi): Promise<any> {
  return strapi.documents(TELEGRAM_PAGE_UID as any).findFirst({
        locale: DEFAULT_CONTENT_LOCALE,
        populate: {
          hero: true,
          benefits: { populate: { features: true } },
          latestDeals: true,
          favouriteStores: true,
          faq: { populate: { items: true } },
          joinCta: true,
          seo: true,
        } as any,
      });
}
