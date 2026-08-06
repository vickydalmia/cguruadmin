import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import {
  INDEPENDENCE_DAY_SALE_CAPS,
  INDEPENDENCE_DAY_SALE_UID,
} from '../constants/independence-day-sale-sections';
import { resultingRelationCount } from './deal-of-the-day-validation';

type Problem = { path: string[]; message: string };

function dateValue(value: unknown): number | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export async function validateIndependenceDaySale(
  strapi: Core.Strapi,
  data: any,
): Promise<void> {
  if (!data || typeof data !== 'object') return;

  const current = await strapi.db.query(INDEPENDENCE_DAY_SALE_UID).findOne({
    populate: {
      countdown: true,
      topPicks: { populate: ['offers'] },
      couponsByCategory: { populate: { tabs: { populate: ['offers'] } } },
      productDealsByCategory: { populate: { tabs: { populate: ['deals'] } } },
      couponsByStore: { populate: { tabs: { populate: ['offers'] } } },
      allCoupons: { populate: ['offers'] },
      allDeals: { populate: ['deals'] },
    } as any,
  });
  const problems: Problem[] = [];
  const countdown = data.countdown ?? current?.countdown;
  if (countdown?.enabled !== false) {
    const start = dateValue(countdown?.saleStartAt);
    const end = dateValue(countdown?.saleEndAt);
    if (start === null || end === null || start >= end) {
      problems.push({
        path: ['countdown'],
        message: 'An enabled clock needs valid sale start and end timestamps, with the end after the start.',
      });
    }
  }

  const relationLimits = [
    ['topPicks', 'offers', INDEPENDENCE_DAY_SALE_CAPS.topPicks, 'Top Picks'],
    ['allCoupons', 'offers', INDEPENDENCE_DAY_SALE_CAPS.allCoupons, 'All Coupons'],
    ['allDeals', 'deals', INDEPENDENCE_DAY_SALE_CAPS.allDeals, 'All Deals'],
  ] as const;
  for (const [section, field, max, label] of relationLimits) {
    const incoming = data?.[section]?.[field];
    if (incoming === undefined) continue;
    const count = resultingRelationCount(
      incoming,
      current?.[section]?.[field] ?? [],
    );
    if (count != null && count > max) {
      problems.push({
        path: [section, field],
        message: `${label} accepts at most ${max} items. Remove ${count - max}.`,
      });
    }
  }

  const categoryTabs = data?.couponsByCategory?.tabs;
  if (
    Array.isArray(categoryTabs) &&
    categoryTabs.length > INDEPENDENCE_DAY_SALE_CAPS.categoryTabs
  ) {
    problems.push({
      path: ['couponsByCategory', 'tabs'],
      message: `Explore by Category accepts at most ${INDEPENDENCE_DAY_SALE_CAPS.categoryTabs} tabs. Remove ${categoryTabs.length - INDEPENDENCE_DAY_SALE_CAPS.categoryTabs}.`,
    });
  }

  for (const [section, field] of [
    ['couponsByCategory', 'offers'],
    ['productDealsByCategory', 'deals'],
    ['couponsByStore', 'offers'],
  ] as const) {
    for (const [index, tab] of (data?.[section]?.tabs ?? []).entries()) {
      const relation = tab?.[field];
      if (relation === undefined) continue;
      const existingTab = (current?.[section]?.tabs ?? []).find(
        (candidate: any) => tab?.id != null && candidate?.id === tab.id,
      );
      const count = resultingRelationCount(relation, existingTab?.[field] ?? []);
      if (count != null && count > INDEPENDENCE_DAY_SALE_CAPS.perTab) {
        problems.push({
          path: [section, 'tabs', String(index), field],
          message: `Each tab accepts at most ${INDEPENDENCE_DAY_SALE_CAPS.perTab} items.`,
        });
      }
    }
  }

  if (!problems.length) return;
  throw new errors.ValidationError(
    `Independence Day Sale validation failed:\n• ${problems
      .map((problem) => `${problem.path.join('.')}: ${problem.message}`)
      .join('\n• ')}`,
    {
      errors: problems.map((problem) => ({
        path: problem.path,
        message: problem.message,
        name: 'ValidationError',
      })),
      problems: problems.map(
        (problem) => `${problem.path.join('.')}: ${problem.message}`,
      ),
    },
  );
}
