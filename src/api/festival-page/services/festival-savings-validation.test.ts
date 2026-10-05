import { expect, it } from 'vitest';
import { festivalSlideProblems } from './festival-slider-validation';
it('limits savings to two selected Coupons without restricting other sliders',()=>{
 const items=Array.from({length:3},(_,id)=>({coupon:{documentId:`coupon-${id}`}}));
 expect(festivalSlideProblems({items},null,'savingsSection')).toContainEqual({path:['savingsSection','items'],message:'Select no more than 2 Coupons.'});
 expect(festivalSlideProblems({items:items.slice(0,2)},null,'savingsSection')).toEqual([]);
 expect(festivalSlideProblems({items},null)).toEqual([]);
});
