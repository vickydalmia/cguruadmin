// Entity coupon-layout REQUEST PARSING: kind registry/limits, id/selection
// normalisation, and the editor-facing CouponLayoutError. Split out of the
// service coordinator (see ./entity-coupon-layout.ts).

export class CouponLayoutError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CouponLayoutError';
  }
}

export const TOP_PICK_LIMIT = 4;

export const ORDERED_COUPON_LIMIT = 10;

export const DISPLAYED_TOP_PICK_COUNT = 2;

export const PREVIEW_COUPON_LIMIT = 30;

const KIND_CONFIG = {
  store: {
    uid: 'api::store.store',
    table: 'stores',
    relation: 'stores',
    publicPath: 'stores',
  },
  brand: {
    uid: 'api::brand.brand',
    table: 'brands',
    relation: 'brands',
    publicPath: 'brands',
  },
  category: {
    uid: 'api::category.category',
    table: 'categories',
    relation: 'categories',
    publicPath: 'categories',
  },
  bank: {
    uid: 'api::bank.bank',
    table: 'banks',
    relation: 'banks',
    publicPath: 'banks',
  },
} as const;

export type EntityCouponLayoutKind = keyof typeof KIND_CONFIG;

export type LayoutSelection = {
  topPickCouponIds: string[];
  orderedCouponIds: string[];
};

export function configFor(kind: unknown) {
  const normalized = String(kind ?? '').trim().toLowerCase();
  const config = KIND_CONFIG[normalized as EntityCouponLayoutKind];
  if (!config) {
    throw new CouponLayoutError(
      'Entity kind must be store, brand, category or bank.',
      400,
      'INVALID_KIND',
    );
  }
  return {
    kind: normalized as EntityCouponLayoutKind,
    ...config,
  };
}

export function documentId(value: unknown): string {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > 255) {
    throw new CouponLayoutError(
      'A valid entity documentId is required.',
      400,
      'INVALID_DOCUMENT_ID',
    );
  }
  return normalized;
}

function idArray(
  value: unknown,
  field: string,
  limit: number,
): string[] {
  if (!Array.isArray(value)) {
    throw new CouponLayoutError(
      `${field} must be an array.`,
      400,
      'INVALID_SELECTION',
      { field },
    );
  }
  const result = value.map((entry) => String(entry ?? '').trim());
  if (result.some((entry) => !entry || entry.length > 255)) {
    throw new CouponLayoutError(
      `${field} contains an invalid Coupon documentId.`,
      400,
      'INVALID_SELECTION',
      { field },
    );
  }
  if (result.length > limit) {
    throw new CouponLayoutError(
      `${field} accepts at most ${limit} Coupons.`,
      400,
      'LIMIT_EXCEEDED',
      { field, limit },
    );
  }
  if (new Set(result).size !== result.length) {
    throw new CouponLayoutError(
      `${field} contains the same Coupon more than once.`,
      400,
      'DUPLICATE_SELECTION',
      { field },
    );
  }
  return result;
}

export function parseLayoutSelection(value: unknown): LayoutSelection {
  const body =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const topPickCouponIds = idArray(
    body.topPickCouponIds,
    'topPickCouponIds',
    TOP_PICK_LIMIT,
  );
  const orderedCouponIds = idArray(
    body.orderedCouponIds,
    'orderedCouponIds',
    ORDERED_COUPON_LIMIT,
  );
  const displayed = new Set(
    topPickCouponIds.slice(0, DISPLAYED_TOP_PICK_COUNT),
  );
  const overlap = orderedCouponIds.filter((id) => displayed.has(id));
  if (overlap.length > 0) {
    throw new CouponLayoutError(
      'A displayed Top Pick cannot also be an Ordered Coupon. Buffer slots 3–4 may overlap.',
      400,
      'DISPLAYED_OVERLAP',
      { documentIds: overlap },
    );
  }
  return { topPickCouponIds, orderedCouponIds };
}
