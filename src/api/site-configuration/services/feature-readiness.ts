import type { Core } from '@strapi/strapi';
import {
  FEATURE_REGISTRY,
  type FeatureDefinition,
  type FeatureKey,
  type SiteConfiguration,
} from './country-registry';
import { findEntityTemplateOwners } from './entity-template-owners';

export type FeatureReadiness = {
  enabled: boolean;
  ready: boolean;
  live: boolean;
  reason?: string;
  /** Campaign features only: the live owner's public path (e.g. "/deal-of-the-day/"). */
  path?: string;
};

export type FeatureReadinessMap = Record<FeatureKey, FeatureReadiness>;

function hasContent(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined;
}

async function countCatalog(strapi: Core.Strapi, feature: FeatureDefinition) {
  const filters =
    feature.key === 'coupons' || feature.key === 'productDeals'
      ? { contentStatus: 'published' }
      : undefined;
  return strapi.documents(feature.catalogUid as any).count({
    ...(filters ? { filters: filters as any } : {}),
  });
}

async function singletonReady(
  strapi: Core.Strapi,
  config: SiteConfiguration,
  feature: FeatureDefinition,
): Promise<{ ready: boolean; reason?: string }> {
  const row: any = await strapi.documents(feature.sourceUid as any).findFirst({
    populate: '*' as any,
  });

  // The committed static-page fixtures are an intentional compatibility
  // source only for the India deployment. Other countries must supply CMS
  // content before an enabled page can become live.
  if (
    !row &&
    config.countryCode === 'IN' &&
    feature.group !== 'Campaigns'
  ) {
    return { ready: true };
  }
  if (!row) return { ready: false, reason: 'CMS singleton is missing.' };

  const missing = (feature.sourceFields ?? []).filter(
    (field) => !hasContent(row[field]),
  );
  if (missing.length > 0) {
    return {
      ready: false,
      reason: `Required content is missing: ${missing.join(', ')}.`,
    };
  }

  if (feature.key === 'dealOfTheDay') {
    const dealCount = await strapi.documents('api::deal.deal').count({
      filters: { contentStatus: 'published' } as any,
    });
    if (dealCount < 1) return { ready: false, reason: 'No eligible live Product Deals exist.' };
  }

  return { ready: true };
}

async function readinessFor(
  strapi: Core.Strapi,
  config: SiteConfiguration,
  feature: FeatureDefinition,
): Promise<FeatureReadiness> {
  let enabled = feature.flag ? config[feature.flag] === true : false;
  let ready = true;
  let reason: string | undefined;
  let path: string | undefined;

  // Campaigns have no Country Setup switch. Assigning the template to one
  // entity is the activation signal; singleton/catalog checks independently
  // decide when that owner is safe to publish.
  if (feature.pageTemplate) {
    const owners = await findEntityTemplateOwners(strapi, feature.pageTemplate);
    enabled = owners.length > 0;
    if (enabled) path = `/${owners[0]!.slug}/`;
  }

  if (feature.catalogUid) {
    const count = await countCatalog(strapi, feature);
    ready = count > 0;
    if (!ready) reason = 'No source-backed catalog records exist.';
  } else if (feature.sourceUid) {
    const result = await singletonReady(strapi, config, feature);
    ready = result.ready;
    reason = result.reason;
  }

  return {
    enabled,
    ready,
    live: enabled && ready,
    ...(reason ? { reason } : {}),
    ...(path && enabled && ready ? { path } : {}),
  };
}

export async function getFeatureReadiness(
  strapi: Core.Strapi,
  config: SiteConfiguration,
): Promise<FeatureReadinessMap> {
  const rows = await Promise.all(
    FEATURE_REGISTRY.map(async (feature) => [
      feature.key,
      await readinessFor(strapi, config, feature),
    ] as const),
  );
  return Object.fromEntries(rows) as FeatureReadinessMap;
}
