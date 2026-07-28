// Exact upload sizes for homepage section images, taken from the Figma spec
// and final responsive render targets (@2x of the rendered @1x size).
// Every rule is path-scoped to one
// homepage slot — enforcement never applies to the media library globally,
// and a component reused in another slot is unaffected unless listed here.
// All targets are below the 1920px upload cap (src/constants/image.ts), so
// the WebP/AVIF re-encode pipeline preserves the master's pixel dimensions
// and an exact width/height match is deterministic.

export type HomepageImageRule = {
  /** Path from the homepage root in params.data; `[]` marks a repeatable component. */
  path: string;
  /** Component UID owning the media field (for admin field descriptions). */
  componentUid: string;
  /** Media attribute name on the component. */
  field: string;
  /** Human label used in validation messages. */
  label: string;
  /** Required upload width in px (@2x). */
  width: number;
  /** Required upload height in px (@2x). */
  height: number;
  /** Rendered @1x size, for admin copy. */
  display: [number, number];
  /** Whether the media must be set on every row of this slot. */
  required: boolean;
  /**
   * Re-check files already attached to the stored homepage. Defaults to false,
   * which preserves the existing grandfathering policy for legacy card art.
   */
  validateExisting?: boolean;
};

export const HOMEPAGE_IMAGE_RULES: HomepageImageRule[] = [
  {
    path: 'hero.banners[].desktopImage',
    componentUid: 'homepage.slider-slide',
    field: 'desktopImage',
    label: 'Hero slide desktop image',
    width: 1882,
    height: 781,
    display: [941, 390.5],
    required: true,
    validateExisting: true,
  },
  {
    path: 'hero.products[].imageOverride',
    componentUid: 'home.hero-product',
    field: 'imageOverride',
    label: 'Hero product image override',
    width: 400,
    height: 400,
    display: [200, 200],
    required: false,
  },
  {
    path: 'topOffers.items[].banner',
    componentUid: 'home.top-offer-item',
    field: 'banner',
    label: 'Top offer banner',
    width: 584,
    height: 354,
    display: [292, 177],
    required: true,
    validateExisting: true,
  },
  {
    path: 'cgExclusive.items[].bannerOverride',
    componentUid: 'home.exclusive-item',
    field: 'bannerOverride',
    label: 'CG Exclusive banner',
    width: 768,
    height: 370,
    display: [384, 185],
    required: true,
  },
  {
    path: 'newlyAdded.items[].cardImage',
    componentUid: 'home.coupon-card-item',
    field: 'cardImage',
    label: 'Fresh Drops card image',
    width: 354,
    height: 646,
    display: [177, 323],
    required: true,
  },
];

export const imageRuleDescription = (rule: HomepageImageRule): string =>
  `Required image size: ${rule.width} × ${rule.height} px ` +
  `(2x of ${rule.display[0]} × ${rule.display[1]}). ` +
  'Upload at exactly this size — other sizes are rejected on save. ' +
  'Formats: WebP/AVIF/PNG/JPEG (no SVG).';
