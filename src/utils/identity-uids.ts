// The four taxonomy content types that share one public identity space
// (unique name within a type, unique public route across all four). Shared
// by the identity validator, its collision queries, and the redirect
// validator's live-entity shadow check.
import { type IdentityKind } from './route-normalization';

export const IDENTITY_UIDS = [
  'api::store.store',
  'api::brand.brand',
  'api::category.category',
  'api::bank.bank',
] as const;

export type IdentityUid = (typeof IDENTITY_UIDS)[number];

export const KIND_BY_UID: Record<IdentityUid, IdentityKind> = {
  'api::store.store': 'store',
  'api::brand.brand': 'brand',
  'api::category.category': 'category',
  'api::bank.bank': 'bank',
};

export function isIdentityUid(uid: string): uid is IdentityUid {
  return IDENTITY_UIDS.includes(uid as IdentityUid);
}
