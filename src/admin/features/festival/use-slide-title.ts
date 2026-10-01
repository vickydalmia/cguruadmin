import { useForm } from '@strapi/admin/strapi-admin';
import { festivalSlideTitle } from './slide-title';

type QueryHook = (args: { model: string; id?: string; targetField: string; params: Record<string, unknown> }, options: { skip: boolean; refetchOnMountOrArgChange: boolean }) => { data?: { results?: Array<{ id?: number; documentId?: string; title?: string; name?: string; label?: string }> } };

// Strapi's relation query is injected by the small repeatable-row adapter so
// labels share its cache, permissions, locale and post-save invalidation.
export function useFestivalSlideTitle(name: string, component: string, fallback: unknown, params: Record<string, unknown>, useRelations: QueryHook) {
  const isCategory = ['festival.category-selection', 'festival.product-category'].includes(component);
  const isProduct = component === 'festival.product-slide';
  const supported = isProduct || component === 'festival.offer-slide' || isCategory;
  const field = isCategory ? 'category' : isProduct ? 'deal' : 'coupon';
  const row = useForm('FestivalSlideTitle', (state) => {
    if (!supported) return undefined;
    return name.split('.').reduce<any>((value, key) => value?.[key], state.values);
  });
  const { data } = useRelations({ model: component, id: row?.id?.toString(), targetField: field, params: { ...params, page: 1, pageSize: 5 } }, {
    skip: !supported || !row?.id,
    refetchOnMountOrArgChange: true,
  });
  return supported ? festivalSlideTitle(fallback, row?.[field], data?.results, isCategory ? 'Select a Category' : isProduct ? 'Select a Product Deal' : 'Select a Coupon') : fallback;
}
