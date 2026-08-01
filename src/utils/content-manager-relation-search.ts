import type { Core } from '@strapi/strapi';

/**
 * Content Manager relation-picker search configuration.
 *
 * This is deliberately separate from the curated offer relations. That list
 * also controls public live-offer filtering, cleanup, and ISR scope; this one
 * only tells Strapi Admin which visible text field to search for each
 * relation. Native relation search reads mainField from the SOURCE component
 * relation metadata — without it, Strapi falls back to searching numeric IDs
 * and typed titles never match.
 */
export type AdminRelationSearchField = Readonly<{
  sourceUid: string;
  field: string;
  targetUid: string;
  mainField: 'name' | 'title';
}>;

const MAIN_FIELD_BY_TARGET: Readonly<Record<string, 'name' | 'title'>> = {
  'api::deal.deal': 'title',
  'api::coupon.coupon': 'title',
  'api::store.store': 'name',
  'api::brand.brand': 'name',
  'api::category.category': 'name',
  'api::bank.bank': 'name',
};

const adminRelationSearchCache = new WeakMap<
  object,
  readonly AdminRelationSearchField[]
>();

/**
 * Derived from the loaded component schemas so newly added relation pickers
 * get a searchable text field without touching a hand-maintained list. Lazy:
 * this module is imported before a `strapi` instance exists.
 */
export function getAdminRelationSearchFields(
  strapi: Core.Strapi,
): readonly AdminRelationSearchField[] {
  const cached = adminRelationSearchCache.get(strapi);
  if (cached) return cached;

  const fields: AdminRelationSearchField[] = [];
  for (const [sourceUid, component] of Object.entries(
    (strapi.components ?? {}) as Record<string, any>,
  )) {
    for (const [field, attribute] of Object.entries(
      (component?.attributes ?? {}) as Record<string, any>,
    )) {
      const mainField =
        attribute?.type === 'relation'
          ? MAIN_FIELD_BY_TARGET[attribute.target]
          : undefined;
      if (!mainField) continue;
      fields.push({ sourceUid, field, targetUid: attribute.target, mainField });
    }
  }

  adminRelationSearchCache.set(strapi, fields);
  return fields;
}

export function groupAdminRelationSearchFields(
  fields: readonly AdminRelationSearchField[],
): Map<string, AdminRelationSearchField[]> {
  const grouped = new Map<string, AdminRelationSearchField[]>();
  for (const field of fields) {
    const componentFields = grouped.get(field.sourceUid) ?? [];
    componentFields.push(field);
    grouped.set(field.sourceUid, componentFields);
  }
  return grouped;
}

/**
 * Shown on every live-filtered Coupon/Deal picker so editors know why an
 * entry they can see in the Coupon/Deal list does not appear here.
 */
export const LIVE_OFFER_PICKER_DESCRIPTION =
  'Only live offers (published, not expired) appear here. '
  + 'Expired or scheduled offers are hidden and auto-removed.';

type ApplicableRelationSearchField = Pick<
  AdminRelationSearchField,
  'field' | 'mainField'
> & { description?: string };

/**
 * Apply the desired main fields while retaining every unrelated metadata
 * property. Descriptions are only filled in when empty so hand-authored ones
 * win. A null result means the configuration is already correct.
 */
export function applyAdminRelationSearchFields(
  metadatas: Record<string, any> | null | undefined,
  fields: readonly ApplicableRelationSearchField[],
): { metadatas: Record<string, any>; changedFields: string[] } | null {
  const next = { ...(metadatas ?? {}) };
  const changedFields: string[] = [];

  for (const { field, mainField, description } of fields) {
    const previous = next[field] ?? {};
    const missingDescription = description && !previous.edit?.description;
    if (previous.edit?.mainField === mainField && !missingDescription) continue;
    next[field] = {
      ...previous,
      edit: {
        ...(previous.edit ?? {}),
        mainField,
        ...(missingDescription ? { description } : {}),
      },
    };
    changedFields.push(field);
  }

  return changedFields.length > 0
    ? { metadatas: next, changedFields }
    : null;
}

const OFFER_TARGET_UIDS = new Set(['api::coupon.coupon', 'api::deal.deal']);

/**
 * Pin the searchable mainField (and live-filter description) for one source
 * component, verifying the write actually landed. Returns false — after
 * logging an error — when the picker would degrade to ID search.
 */
export async function ensureAdminRelationSearchFieldsForUid(
  strapi: Core.Strapi,
  uid: string,
  fields: readonly AdminRelationSearchField[],
): Promise<boolean> {
  const service: any = strapi.plugin('content-manager').service('components');
  if (!service) return false;

  const component = service.findComponent(uid);
  if (!component) {
    strapi.log.error(
      `[content-manager] admin relation search failed: component ${uid} not found`,
    );
    return false;
  }

  const validFields = fields.filter((field) => {
    let target: any = null;
    try {
      target = strapi.contentType(field.targetUid as any);
    } catch {
      target = null;
    }
    if (!target?.attributes?.[field.mainField]) {
      strapi.log.error(
        `[content-manager] admin relation search skipped: `
        + `${field.targetUid} has no field "${field.mainField}"`,
      );
      return false;
    }
    return true;
  });
  const allValid = validFields.length === fields.length;
  if (validFields.length === 0) return allValid;

  const decorated = validFields.map((field) => ({
    ...field,
    description: OFFER_TARGET_UIDS.has(field.targetUid)
      ? LIVE_OFFER_PICKER_DESCRIPTION
      : undefined,
  }));

  const config = await service.findConfiguration(component);
  const update = applyAdminRelationSearchFields(config.metadatas, decorated);
  if (!update) return allValid;

  await service.updateConfiguration(component, {
    ...config,
    metadatas: update.metadatas,
  });

  const persisted = await service.findConfiguration(component);
  const mismatched = validFields.filter(
    (field) =>
      persisted?.metadatas?.[field.field]?.edit?.mainField !== field.mainField,
  );
  if (mismatched.length > 0) {
    strapi.log.error(
      `[content-manager] admin relation search write did not persist for ${uid}: `
      + mismatched.map((field) => field.field).join(', '),
    );
    return false;
  }

  strapi.log.info(
    `[content-manager] admin relation search configured for ${uid}: `
    + update.changedFields.join(', '),
  );
  return allValid;
}
