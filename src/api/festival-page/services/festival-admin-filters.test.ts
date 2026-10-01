import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {expect,it,vi} from 'vitest';
import {appendFestivalFilterWhere,festivalFilterTarget,runWithFestivalFilter,liveFestivalFilterIds} from './festival-admin-filters';
it('targets only the Festival Product Deal filter relations',()=>{
 expect(festivalFilterTarget('/content-manager/relations/festival.product-section/filterBrands')).toBe('api::brand.brand');
 expect(festivalFilterTarget('/content-manager/relations/festival.product-section/4/filterBanks')).toBeNull();
 expect(festivalFilterTarget('/content-manager/relations/home.popular-stores/stores')).toBeNull();
});
it('applies live Deal ownership to both find/count without changing unrelated queries',()=>{
 const event:any={model:{uid:'api::brand.brand'},params:{where:{name:{$contains:'Test'}}}};
 runWithFestivalFilter('api::brand.brand',['live-brand'],()=>appendFestivalFilterWhere(event));
 expect(event.params.where.$and[1]).toEqual({documentId:{$in:['live-brand']}});
 const normal:any={model:{uid:'api::brand.brand'},params:{where:{id:1}}};appendFestivalFilterWhere(normal);expect(normal.params.where).toEqual({id:1});
});

it('passes the installed Strapi relation where parser',()=>{
 const require=createRequire(import.meta.url);
 const {processWhere}=require(join(dirname(require.resolve('@strapi/database')),'query/helpers/where.js'));
 const event:any={model:{uid:'api::brand.brand'},params:{where:{name:{$contains:'Test'}}}};
 runWithFestivalFilter('api::brand.brand',['live-brand'],()=>appendFestivalFilterWhere(event));
 const relation=(target:string)=>({type:'relation',target,relation:'manyToOne',joinColumn:{name:'fk',referencedColumn:'id'}});
 const db={metadata:{get:(uid:string)=>({tableName:uid,attributes:uid==='brand'?{deals:relation('deal')}:uid==='deal'?{dealImage:relation('image')}:{}})}};
 const qb={alias:'root',getAlias:()=> 'joined',join:()=>{},aliasColumn:(column:string,alias:string)=>`${alias}.${column}`};
 expect(()=>processWhere(event.params.where,{db,qb,uid:'brand',alias:'root'})).not.toThrow();
});

it('uses only identities attached to actionable live Deals and shares the lightweight facet lookup',async()=>{
 const findMany=vi.fn().mockResolvedValue([{affiliateLink:'https://example.com',dealImage:{url:'/image.png'},brands:[{documentId:'brand'}],stores:[{documentId:'store'}],banks:[{documentId:'bank'}]},{affiliateLink:'javascript:bad',dealImage:{url:'/image.png'},banks:[{documentId:'bad'}]}]);
 const strapi={documents:vi.fn(()=>({findMany}))} as any;
 expect(await liveFestivalFilterIds(strapi,'api::bank.bank','en')).toEqual(['bank']);
 expect(await liveFestivalFilterIds(strapi,'api::store.store','en')).toEqual(['store']);
 expect(findMany).toHaveBeenCalledTimes(1);
 expect(findMany.mock.calls[0][0]).toMatchObject({locale:'en',fields:['affiliateLink'],limit:100,filters:{contentStatus:{$eq:'published'}}});
});
