import { expect, it, vi } from 'vitest';
import { resolveFestivalDealListing } from './festival-deal-listing';
const deal=(id:string)=>({documentId:id,contentStatus:'published',affiliateLink:'https://example.com',dealImage:{url:'/image.png'}});
it('loads all live Deal facets beyond 50 in locale-aware batches, rejecting unsafe and duplicate rows',async()=>{
  const findMany=vi.fn().mockResolvedValueOnce(Array.from({length:100},(_,i)=>deal(String(i)))).mockResolvedValueOnce([deal('100'),deal('0'),{...deal('bad'),affiliateLink:'javascript:alert(1)'},{...deal('expired'),expiresAt:'2000-01-01'}]);
  const strapi={documents:vi.fn(()=>({findMany})),contentType:vi.fn(),contentAPI:{sanitize:{output:vi.fn(async data=>data)}}};
  const section:any={};
  await resolveFestivalDealListing(strapi as any,{state:{}},section,'hi');
  expect(section.listingDeals).toHaveLength(101);
  expect(findMany.mock.calls[1][0]).toMatchObject({locale:'hi',start:100,limit:100,populate:{banks:{fields:['name','slug']}}});
});
it('does not load a disabled listing or section',async()=>{
  const documents=vi.fn();
  for(const section of [null,{enabled:false},{listingEnabled:false}])await resolveFestivalDealListing({documents} as any,{},section,'en');
  expect(documents).not.toHaveBeenCalled();
});
