import { festivalCategoryProblems } from './festival-category-validation';
import { festivalSlideProblems } from './festival-slider-validation';
import type { Core } from '@strapi/strapi';
import { FESTIVAL_PAGE_UID } from '../../../constants/festival-page';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';
import { toValidationError, type Problem } from '../../../utils/write-validation/problems';

const safeLink = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim()) return false;
  const href = value.trim();
  if (/^\/(?!\/)/u.test(href)) return !/[\\\s]/u.test(href);
  try { return ['https:', 'http:'].includes(new URL(href).protocol); } catch { return false; }
};

export async function validateFestivalPage(strapi: Core.Strapi, data, locale?: string): Promise<void> {
  if (!data || typeof data !== 'object') return;
  const current = await strapi.db.query(FESTIVAL_PAGE_UID).findOne({
    where: { locale: locale ?? DEFAULT_CONTENT_LOCALE }, populate: { giftSection: { populate: { items: { populate: ['coupon'] }, categories: { populate: ['category'] } } }, productSection: { populate: { items: { populate: ['deal'] }, categories: { populate: ['category'] } } }, exploreCategories: { populate: { categories: { populate: ['category'] } } }, countdown: true, hero: true, offerSlider: { populate: { items: { populate: ['coupon'] } } } },
  });
  const merged = (key: string) => data[key] === undefined ? current?.[key]
    : data[key] === null ? null : { ...current?.[key], ...data[key] };
  const countdown = merged('countdown');
  const hero = merged('hero');
  const problems: Problem[] = [...festivalSlideProblems(data.giftSection, current?.giftSection, 'giftSection'), ...festivalCategoryProblems(data.giftSection, current?.giftSection, 'giftSection'), ...festivalSlideProblems(data.productSection, current?.productSection, 'productSection', 'deal'), ...festivalCategoryProblems(data.productSection, current?.productSection, 'productSection'), ...festivalSlideProblems(data.offerSlider, current?.offerSlider), ...festivalCategoryProblems(data.exploreCategories, current?.exploreCategories)];
  for (const [index, row] of (data.productSection?.categories ?? []).entries()) {
    if (row?.urlOverride && !safeLink(row.urlOverride)) problems.push({ path: ['productSection', 'categories', index, 'urlOverride'], message: 'Use a root-relative path or an HTTP(S) URL.' });
  }
  if (countdown && countdown.enabled !== false) {
    const start = Date.parse(countdown.saleStartAt);
    const end = Date.parse(countdown.saleEndAt);
    if (!Number.isFinite(start)) {
      problems.push({ path: ['countdown', 'saleStartAt'], message: 'Enter a valid sale start date and time.' });
    }
    if (!Number.isFinite(end)) {
      problems.push({ path: ['countdown', 'saleEndAt'], message: 'Enter a valid sale end date and time.' });
    } else if (Number.isFinite(start) && start >= end) {
      problems.push({ path: ['countdown', 'saleEndAt'], message: 'The sale must end after the start.' });
    }
    for (const key of ['preSaleLabel', 'preSaleCtaLabel', 'liveLabel', 'liveCtaLabel']) {
      if (typeof countdown[key] !== 'string' || !countdown[key].trim()) {
        problems.push({ path: ['countdown', key], message: 'Provide a label for this countdown phase.' });
      }
    }
    for (const key of ['preSaleCtaHref', 'liveCtaHref']) {
      if (!safeLink(countdown[key])) problems.push({ path: ['countdown', key], message: 'Provide a root-relative path or an HTTP(S) URL for this action.' });
    }
  }
  if (hero?.linkUrl && !safeLink(hero.linkUrl)) problems.push({ path: ['hero', 'linkUrl'], message: 'Use a root-relative path or an HTTP(S) URL.' });
  if (problems.length) throw toValidationError(problems);
}
