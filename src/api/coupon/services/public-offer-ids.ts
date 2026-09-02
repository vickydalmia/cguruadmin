// Public offer responses use one URL identity in every language. Strapi i18n
// gives each locale row its own numeric primary key, but /coupon/:id and
// /deal/:id are owned by the default-locale row. This response-boundary helper
// rewrites translated offer objects to that stable public id in one batched
// lookup per offer type.
import type { Core } from '@strapi/strapi';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';
import { enabledContentLocaleCodesSync } from '../../../translation/locales/registry';

const ID_BATCH_SIZE = 500;

export type PublicOfferKind = 'coupon' | 'deal';
type OfferUid = 'api::coupon.coupon' | 'api::deal.deal';

const OFFER_UID_BY_KIND: Record<PublicOfferKind, OfferUid> = {
  coupon: 'api::coupon.coupon',
  deal: 'api::deal.deal',
};

export function requestedOfferTargetLocale(ctx: any): string | null {
  const raw = ctx.query?.locale;
  const requested = Array.isArray(raw) ? raw[0] : raw;
  if (
    typeof requested !== 'string' ||
    requested === DEFAULT_CONTENT_LOCALE ||
    !enabledContentLocaleCodesSync().includes(requested)
  ) {
    return null;
  }
  return requested;
}

function objectGraph(root: unknown): Record<string, any>[] {
  const found: Record<string, any>[] = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object' || seen.has(value as object)) return;
    seen.add(value as object);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, any>;
    found.push(record);
    for (const child of Object.values(record)) visit(child);
  };
  visit(root);
  return found;
}

async function publicIdsFor(
  strapi: Core.Strapi,
  uid: OfferUid,
  documentIds: readonly string[],
): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (let start = 0; start < documentIds.length; start += ID_BATCH_SIZE) {
    const batch = documentIds.slice(start, start + ID_BATCH_SIZE);
    const rows: any[] = await strapi.db.query(uid).findMany({
      where: {
        locale: DEFAULT_CONTENT_LOCALE,
        documentId: { $in: batch },
      },
      select: ['id', 'documentId'],
    } as any);
    for (const row of rows ?? []) {
      const id = Number(row?.id);
      if (
        typeof row?.documentId === 'string' &&
        row.documentId &&
        Number.isSafeInteger(id) &&
        id > 0
      ) {
        ids.set(row.documentId, id);
      }
    }
  }
  return ids;
}

/**
 * Mutates a sanitized public response in place. It is a no-op for English,
 * invalid locales, and payloads without document identities. Translated ISR
 * renders pay at most two bounded, indexed reads; normal visitors receive the
 * cached page and never execute this path.
 */
export async function attachStablePublicOfferIds(
  strapi: Core.Strapi,
  data: unknown,
  targetLocale: string | null,
  kinds: readonly PublicOfferKind[] = ['coupon', 'deal'],
): Promise<void> {
  if (!targetLocale || targetLocale === DEFAULT_CONTENT_LOCALE) return;

  const records = objectGraph(data);
  const documentIds = [
    ...new Set(
      records
        .map((record) => record.documentId)
        .filter(
          (documentId): documentId is string =>
            typeof documentId === 'string' && documentId.length > 0,
        ),
    ),
  ];
  if (documentIds.length === 0) return;

  const selectedKinds = [...new Set(kinds)];
  const idMaps = new Map<PublicOfferKind, Map<string, number>>(
    await Promise.all(
      selectedKinds.map(async (kind) => [
        kind,
        await publicIdsFor(strapi, OFFER_UID_BY_KIND[kind], documentIds),
      ] as const),
    ),
  );

  for (const record of records) {
    const documentId = record.documentId;
    if (typeof documentId !== 'string') continue;
    const matches = selectedKinds.flatMap((kind) => {
      const id = idMaps.get(kind)?.get(documentId);
      return id ? [id] : [];
    });
    // documentId is globally generated, but fail closed if legacy/manual data
    // ever collides across the two offer tables instead of guessing a route.
    if (matches.length !== 1) continue;
    record.id = matches[0];
  }
}

export async function attachStablePublicOfferIdsForRequest(
  strapi: Core.Strapi,
  ctx: any,
  data: unknown,
  kinds?: readonly PublicOfferKind[],
): Promise<void> {
  await attachStablePublicOfferIds(
    strapi,
    data,
    requestedOfferTargetLocale(ctx),
    kinds,
  );
}
