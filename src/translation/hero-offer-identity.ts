/** Match only an official name on the hero's selected Coupon or Deal. */
export function heroOfferIdentityName(item: any, title: string): string | undefined {
  const entityType = item?.entityType ?? 'deal';
  if (entityType !== 'coupon' && entityType !== 'deal') return undefined;
  const offer = item?.[entityType];
  if (typeof offer?.documentId !== 'string' || !offer.documentId) return undefined;

  for (const field of ['stores', 'brands'] as const) {
    const relations = offer[field];
    if (!Array.isArray(relations)) continue;
    for (const relation of relations) {
      if (typeof relation?.documentId !== 'string' || !relation.documentId) continue;
      if (typeof relation.name !== 'string') continue;
      const name = relation.name.trim();
      if (name && title.trim() === name) return name;
    }
  }
  return undefined;
}
