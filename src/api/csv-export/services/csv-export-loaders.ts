// CSV export ROW-CONTEXT LOADERS: the batched lookups that resolve
// checkout-merchant display names and audit-user emails for one page. One
// of the modules split out of the csv-export service (see ./csv-export.ts).
import type { Core } from '@strapi/strapi';
import {
  CHECKOUT_MERCHANT_FIELD,
  parseCheckoutMerchant,
} from '../../../constants/checkout-merchant';
import {
  ADMIN_USER_UID,
  buildPopulate,
  type Column,
  type ModelResolver,
} from './csv-export-columns';
import { readPath } from './csv-export-format';

/**
 * Resolve every `<kind>:<documentId>` reference on this page to a merchant
 * name with one query per kind. Unknown references (a merchant deleted after
 * the offer was saved) resolve to an empty name; the raw column still shows
 * the reference.
 */
export async function resolveMerchantNames(
  strapi: Core.Strapi,
  rows: any[],
): Promise<Map<string, string>> {
  const ids: Record<'store' | 'brand', Set<string>> = {
    store: new Set(),
    brand: new Set(),
  };
  for (const row of rows) {
    const ref = parseCheckoutMerchant(row?.[CHECKOUT_MERCHANT_FIELD]);
    if (ref) ids[ref.kind].add(ref.documentId);
  }

  const names = new Map<string, string>();
  for (const kind of ['store', 'brand'] as const) {
    const documentIds = [...ids[kind]];
    if (!documentIds.length) continue;
    const found: any[] = await strapi
      .documents(`api::${kind}.${kind}` as any)
      .findMany({
        filters: { documentId: { $in: documentIds } },
        fields: ['documentId', 'name'],
        limit: documentIds.length,
      } as any);
    for (const merchant of found ?? []) {
      if (merchant?.documentId) {
        names.set(`${kind}:${merchant.documentId}`, String(merchant.name ?? ''));
      }
    }
  }
  return names;
}

/**
 * Emails for every admin user referenced by an audit column on this page,
 * in one query. `email` is private on admin::user, so it cannot be selected
 * through the document-service populate (see buildPopulate); the Query Engine
 * has no such rule.
 */
export async function resolveAdminEmails(
  strapi: Core.Strapi,
  columns: Column[],
  rows: any[],
): Promise<Map<number, string>> {
  const ids = new Set<number>();
  const userColumns = columns.filter((column) => column.kind === 'audit-user');
  for (const row of rows) {
    for (const column of userColumns) {
      const id = Number((readPath(row, column.path) as any)?.id);
      if (Number.isSafeInteger(id) && id > 0) ids.add(id);
    }
  }
  const emails = new Map<number, string>();
  if (!ids.size) return emails;
  const users: any[] = await strapi.db.query(ADMIN_USER_UID as any).findMany({
    where: { id: { $in: [...ids] } },
    select: ['id', 'email'],
  } as any);
  for (const user of users ?? []) {
    if (user?.id !== undefined && typeof user.email === 'string') {
      emails.set(Number(user.id), user.email);
    }
  }
  return emails;
}
