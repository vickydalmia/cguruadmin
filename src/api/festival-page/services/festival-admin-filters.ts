import { AsyncLocalStorage } from 'node:async_hooks';
import type { Core } from '@strapi/strapi';
import { hasSafeAffiliateLink } from '../../../utils/offer-visibility';
import { publishedOnlyFilters } from '../../../utils/content-status';

const targets: Record<string,string> = {filterBrands:'api::brand.brand',filterStores:'api::store.store',filterBanks:'api::bank.bank'};
const requestScope=new AsyncLocalStorage<{target:string;ids:string[]}>();
export function festivalFilterTarget(path:string):string|null {
  const parts=path.split('/').filter(Boolean).map(value=>{try{return decodeURIComponent(value);}catch{return value;}});
  return parts[0]==='content-manager'&&parts[1]==='relations'&&parts[2]==='festival.product-section'&&parts.length===4 ? targets[parts.at(-1)!]??null : null;
}
export function runWithFestivalFilter<T>(target:string,ids:string[],callback:()=>T):T { return requestScope.run({target,ids},callback); }
export function appendFestivalFilterWhere(event:any) {
  const request=requestScope.getStore();
  if(!request || (event.model?.uid??event.model)!==request.target)return;
  const live={documentId:{$in:request.ids}};
  event.params??={};
  event.params.where=event.params.where?{$and:[event.params.where,live]}:live;
}
export function registerFestivalAdminFilters(strapi:Core.Strapi) {
  strapi.db.lifecycles.subscribe({models:Object.values(targets),beforeFindMany:appendFestivalFilterWhere,beforeCount:appendFestivalFilterWhere});
}

const cache=new WeakMap<object,Map<string,{at:number;value:Promise<Record<string,string[]>>}>>();
export async function liveFestivalFilterIds(strapi:Core.Strapi,target:string,locale:string) {
  let entries=cache.get(strapi);if(!entries){entries=new Map();cache.set(strapi,entries);}
  let entry=entries.get(locale);
  if(!entry||Date.now()-entry.at>15000){
    const value=(async()=>{
      const facets={brands:new Set<string>(),stores:new Set<string>(),banks:new Set<string>()};
      for(let start=0;;start+=100){
        const deals=await strapi.documents('api::deal.deal').findMany({locale,fields:['affiliateLink'],filters:publishedOnlyFilters(),populate:{dealImage:{fields:['url']},brands:{fields:['name']},stores:{fields:['name']},banks:{fields:['name']}},start,limit:100} as any);
        for(const deal of deals as any[]){
          if(!deal.dealImage?.url||!hasSafeAffiliateLink(deal.affiliateLink))continue;
          for(const kind of ['brands','stores','banks'] as const)for(const entity of deal[kind]??[])if(entity.documentId)facets[kind].add(entity.documentId);
        }
        if(deals.length<100)break;
      }
      return {'api::brand.brand':[...facets.brands],'api::store.store':[...facets.stores],'api::bank.bank':[...facets.banks]};
    })();
    entry={at:Date.now(),value};entries.set(locale,entry);value.catch(()=>entries!.delete(locale));
  }
  return (await entry.value)[target]??[];
}
