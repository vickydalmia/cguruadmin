import type { Core } from '@strapi/strapi';

type AnySchema = { attributes?: Record<string, any> };

const populateCache = new WeakMap<object, Map<string, Record<string, unknown>>>();

function localized(definition: any): boolean {
  return definition?.pluginOptions?.i18n?.localized === true;
}
function ownerRelation(definition: any): boolean {
  return (
    definition?.type === 'relation' &&
    !definition.mappedBy &&
    !String(definition.relation ?? '').toLowerCase().includes('morph')
  );
}

/**
 * Build the smallest populate graph that can feed field-map.ts. In
 * particular, inverse `mappedBy` collections are never part of a localized
 * write and must not be expanded: one Store can otherwise pull thousands of
 * Coupons and Deals into a single repair-scan query.
 */
function buildPopulate(
  strapi: Core.Strapi,
  uid: string,
  insideComponent: boolean,
  componentStack: ReadonlySet<string>,
): Record<string, unknown> {
  const schema = (strapi.getModel(uid as any) as AnySchema) ?? { attributes: {} };
  const populate: Record<string, unknown> = {};

  for (const [key, definition] of Object.entries(schema.attributes ?? {})) {
    // Shared media is inherited by Strapi, but must already be present in the
    // English source used to validate a first localized row before persistence.
    const included = insideComponent || localized(definition) || ownerRelation(definition)
      || definition.type === 'media';
    if (!included) continue;

    if (definition.type === 'relation') {
      if (ownerRelation(definition) && definition.target) {
        // Hero overrides may be official store/brand names. Read only their
        // names on the linked offer; never expand their inverse offer lists.
        const heroOffer = uid === 'home.hero-product'
          && ((key === 'coupon' && definition.target === 'api::coupon.coupon')
            || (key === 'deal' && definition.target === 'api::deal.deal'));
        populate[key] = heroOffer ? {
          populate: {
            stores: { fields: ['name'] },
            brands: { fields: ['name'] },
          },
        } : true;
      }
      continue;
    }
    if (definition.type === 'media') {
      // field-map only consumes the media id. `true` deliberately avoids the
      // content-manager builder's nested Media Library folder population.
      populate[key] = true;
      continue;
    }
    if (definition.type === 'component' && definition.component) {
      const childUid = String(definition.component);
      if (componentStack.has(childUid)) continue;
      populate[key] = {
        populate: buildPopulate(
          strapi,
          childUid,
          true,
          new Set([...componentStack, childUid]),
        ),
      };
      continue;
    }
    if (definition.type === 'dynamiczone') {
      const on: Record<string, unknown> = {};
      for (const componentUid of definition.components ?? []) {
        const childUid = String(componentUid);
        if (componentStack.has(childUid)) continue;
        on[childUid] = {
          populate: buildPopulate(
            strapi,
            childUid,
            true,
            new Set([...componentStack, childUid]),
          ),
        };
      }
      populate[key] = { on };
    }
  }

  return populate;
}

export function translationPopulate(
  strapi: Core.Strapi,
  uid: string,
): Record<string, unknown> {
  let byUid = populateCache.get(strapi as object);
  if (!byUid) {
    byUid = new Map();
    populateCache.set(strapi as object, byUid);
  }
  const cached = byUid.get(uid);
  if (cached) return cached;
  const populate = buildPopulate(strapi, uid, false, new Set([uid]));
  byUid.set(uid, populate);
  return populate;
}
