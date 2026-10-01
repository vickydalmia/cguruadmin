import { useForm } from '@strapi/admin/strapi-admin';
import { festivalSlideTitle } from './slide-title';

type QueryHook = (args: { model: string; id?: string; targetField: string; params: Record<string, unknown> }, options: { skip: boolean; refetchOnMountOrArgChange: boolean }) => { data?: { results?: Array<{ id?: number; documentId?: string; title?: string; label?: string }> } };

// Strapi's relation query is injected by the small repeatable-row adapter so
// labels share its cache, permissions, locale and post-save invalidation.
export function useFestivalSlideTitle(name: string, component: string, fallback: unknown, params: Record<string, unknown>, useRelations: QueryHook) {
  const row = useForm('FestivalSlideTitle', (state) => {
    if (component !== 'festival.offer-slide') return undefined;
    return name.split('.').reduce<any>((value, key) => value?.[key], state.values);
  });
  const { data } = useRelations({ model: component, id: row?.id?.toString(), targetField: 'coupon', params: { ...params, page: 1, pageSize: 5 } }, {
    skip: component !== 'festival.offer-slide' || !row?.id,
    refetchOnMountOrArgChange: true,
  });
  return component === 'festival.offer-slide' ? festivalSlideTitle(fallback, row?.coupon, data?.results) : fallback;
}
