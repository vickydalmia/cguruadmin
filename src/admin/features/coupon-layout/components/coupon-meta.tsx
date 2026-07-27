import { Flex, Typography } from '@strapi/design-system';
import * as React from 'react';

import type { CouponCandidate } from '../coupon-layout';

/**
 * The line that makes a Coupon identifiable.
 *
 * Coupon titles repeat heavily across an entity ("Flat 10% Off" six times), so
 * a title-only row forced editors to open each Coupon to tell them apart.
 */

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function CouponMeta({
  candidate,
  extra,
}: {
  candidate: CouponCandidate;
  extra?: string | null;
}) {
  const published = formatDate(candidate.publishedOn);
  const expires = formatDate(candidate.expiresAt);

  const parts = [
    candidate.offerType === null
      ? null
      : candidate.offerType === 'code'
        ? 'CODE'
        : 'NO CODE',
    candidate.badge,
    published ? `published ${published}` : null,
    // "no expiry" is only true if we actually loaded the field.
    expires ? `expires ${expires}` : candidate.detailed ? 'no expiry' : null,
    extra,
  ].filter((part): part is string => Boolean(part));

  if (parts.length === 0) return null;

  return (
    <Flex gap={1} wrap="wrap" paddingTop={1}>
      <Typography
        variant="pi"
        textColor="neutral600"
        style={{ overflowWrap: 'anywhere' }}
      >
        {parts.join(' · ')}
      </Typography>
    </Flex>
  );
}
