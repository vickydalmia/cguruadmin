import { describe, expect, it, vi } from 'vitest';
import { resolveFestivalCategories } from './festival-categories';
import { festivalCategoryProblems } from './festival-category-validation';
const offer = (id: string, category = 'cat') => ({ documentId: id, contentStatus: 'published', affiliateLink: 'https://example.com', categories: [{ documentId: category }] });
function setup(batches: any[][]) {
  const findMany = vi.fn(); batches.forEach((batch) => findMany.mockResolvedValueOnce(batch));
  const strapi = { documents: vi.fn(() => ({ findMany })), contentType: vi.fn(), contentAPI: { sanitize: { output: vi.fn(async (data) => data) } } };
  return { strapi: strapi as any, findMany };
}
describe('Festival category fallback', () => {
  it('loads all batches for every empty category in one locale-aware query sequence', async () => {
    const { strapi, findMany } = setup([Array.from({length: 100}, (_, i) => offer(String(i))), [offer('last', 'second')]]);
    const section = { categories: [{ category: { documentId: 'cat' }, coupons: [] }, { category: { documentId: 'second' }, coupons: [] }] };
    await resolveFestivalCategories(strapi, {state:{}}, section, 'hi');
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[0][0]).toMatchObject({locale:'hi', start:0, limit:100, filters:{categories:{documentId:{$in:['cat','second']}}}});
    expect(section.categories[0].coupons).toHaveLength(100);
    expect(section.categories[1].coupons).toHaveLength(1);
  });
  it('preserves curated order, rejects unsafe/expired items, and never backfills a nonempty selection', async () => {
    const {strapi, findMany} = setup([]);
    const section = {categories:[{category:{documentId:'cat'},coupons:[offer('b'), offer('a'), offer('b'), {...offer('old'), expiresAt:'2000-01-01'}, {...offer('bad'),affiliateLink:'javascript:alert(1)'}]}]};
    await resolveFestivalCategories(strapi, {state:{}}, section, 'en');
    expect(findMany).not.toHaveBeenCalled(); expect(section.categories[0].coupons.map((row)=>row.documentId)).toEqual(['b','a']);
  });
  it('does not query for disabled sections', async () => {
    const {strapi,findMany}=setup([]);
    await resolveFestivalCategories(strapi,{state:{}},{enabled:false,categories:[{category:{documentId:'cat'}}]},'en');
    expect(findMany).not.toHaveBeenCalled();
  });
});
describe('Festival category validation', () => {
  it('supports partial relation edits and detects missing and duplicate categories at field paths', () => {
    const stored={categories:[{id:1,category:{id:7,documentId:'cat'}}]};
    expect(festivalCategoryProblems({categories:[{id:1,labelOverride:'New label'}]},stored)).toEqual([]);
    expect(festivalCategoryProblems({categories:[{id:1,category:{disconnect:[{id:7,documentId:'cat'}]}}]},stored)[0].path).toEqual(['exploreCategories','categories',0,'category']);
    expect(festivalCategoryProblems({categories:[{category:{connect:[{documentId:'cat'}]}},{category:{connect:[{documentId:'cat'}]}}]},null)[0].path).toEqual(['exploreCategories','categories',1,'category']);
  });
});

it('resolves gift categories without a curated Coupons field', async () => {
 const {strapi,findMany}=setup([[offer('gift')]]);
 const section:any={categories:[{category:{documentId:'cat'},labelOverride:'Gifts'}]};
 await resolveFestivalCategories(strapi,{state:{}},section,'en');
 expect(findMany).toHaveBeenCalledTimes(1);
 expect(section.categories[0].coupons.map((row:any)=>row.documentId)).toEqual(['gift']);
 expect(festivalCategoryProblems({categories:[{category:null}]},null,'giftSection')[0].path).toEqual(['giftSection','categories',0,'category']);
});
