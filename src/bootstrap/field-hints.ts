import type { Core } from '@strapi/strapi';
import { HOMEPAGE_IMAGE_RULES, imageRuleDescription } from '../constants/homepage-images';
import { CULTURE_GALLERY_MEDIA_FOLDER_NAME } from '../constants/media-folders';
import {
  changedFieldHints,
  changedFieldSeoHints,
} from '../utils/changed-field-validation';
import { WORD_LIMITS, BENEFIT_TEXT_FIELDS } from '../utils/offer-field-validation';
import {
  benefitFieldHint,
  offerAmountFieldHint,
} from '../utils/offer-word-limits';
import { textFieldHints } from '../utils/text-field-validation';

// Field help text pinned into the Content Manager on every boot. Homepage
// image guidance is derived from HOMEPAGE_IMAGE_RULES so the enforced size and
// instruction cannot drift; other business-input guidance is declared here.
// Uses the same DB config store + config-as-code approach as entry titles.
// Exported for hint-coverage.test.ts only (via the src/index.ts re-export).
export const COMPONENT_FIELD_DESCRIPTIONS: Record<string, Record<string, string>> = {};
for (const rule of HOMEPAGE_IMAGE_RULES) {
  (COMPONENT_FIELD_DESCRIPTIONS[rule.componentUid] ??= {})[rule.field] =
    imageRuleDescription(rule);
}
(COMPONENT_FIELD_DESCRIPTIONS['shared.seo'] ??= {}).canonicalUrl =
  'Enter only a URL or site path, for example /airport-tour-coupons/. Do not paste HTML such as <link rel="canonical" href="..." />.';
COMPONENT_FIELD_DESCRIPTIONS['shared.seo'].ogImage =
  'Share-card image shown when the page is shared on social apps. Recommended: at least 1200 × 630 px (1.91:1). Smaller images are allowed but may crop or blur in previews. Leave empty to use the site default card.';
(COMPONENT_FIELD_DESCRIPTIONS['shared.entity-deal-page-seo'] ??= {}).ogImage =
  'Share-card image shown when the deal page is shared on social apps. Recommended: at least 1200 × 630 px (1.91:1). Smaller images are allowed but may crop or blur in previews. Leave empty to use the site default card.';
(COMPONENT_FIELD_DESCRIPTIONS['homepage.slider-slide'] ??= {}).link =
  'Optional banner destination. Use /path/ for a CouponzGuru page or a full http(s) URL. CouponzGuru links open in this tab and remain followed; external links open in a new tab with nofollow. Leave empty for a non-clickable banner.';
(COMPONENT_FIELD_DESCRIPTIONS['deal-day.telegram-deal-item'] ??= {}).deal =
  'The Product Deal shown as a locked Telegram card. Its promo code is never sent to the site for this section.';
COMPONENT_FIELD_DESCRIPTIONS['deal-day.telegram-deal-item'].linkOverride =
  'Optional. Telegram post URL for this deal — used only by this section. Leave empty to send visitors to the deal’s affiliate link. Enter a full http(s) URL.';
COMPONENT_FIELD_DESCRIPTIONS['deal-day.telegram-deal-item'].titleOverride =
  'Optional. Leave blank to use the selected Deal title.';
(COMPONENT_FIELD_DESCRIPTIONS['nav.category-section'] ??= {}).category =
  'Preferred destination. When selected, the menu links to this Category and uses its icon unless an Icon override is uploaded below.';
COMPONENT_FIELD_DESCRIPTIONS['nav.category-section'].url =
  'Optional custom destination used only when no Category is selected. Enter a rooted site path or full http(s) URL.';
COMPONENT_FIELD_DESCRIPTIONS['nav.category-section'].icon =
  'Square menu icon. Leave empty to reuse the selected Category icon; upload one when this group uses a custom URL without a Category. It renders at 24px on desktop and 20px on mobile.';
COMPONENT_FIELD_DESCRIPTIONS['nav.category-section'].links =
  'Ordered child links. They render below the group on desktop and in the mobile drill-down panel; upload each child Icon for the mobile design and enable Bold only for links that need emphasis.';
(COMPONENT_FIELD_DESCRIPTIONS['nav.link'] ??= {}).icon =
  'Optional icon override for category drill-down rows. Leave empty to reuse the linked Category icon; custom category links can upload their own square icon.';
(COMPONENT_FIELD_DESCRIPTIONS['header.coupon-notification'] ??= {}).coupon =
  'Select the Coupon shown in this header notification row.';
COMPONENT_FIELD_DESCRIPTIONS['header.coupon-notification'].titleOverride =
  'Optional. Leave blank to use the selected Coupon title.';
COMPONENT_FIELD_DESCRIPTIONS['header.coupon-notification'].imageOverride =
  'Optional. Leave blank to use the selected Coupon’s related Store, Brand, Bank, or Category media. Maximum 80 × 80 px; a square image is recommended.';
(COMPONENT_FIELD_DESCRIPTIONS['header.product-deal-notification'] ??= {}).productDeal =
  'Select the Product Deal shown in this header notification row.';
COMPONENT_FIELD_DESCRIPTIONS['header.product-deal-notification'].titleOverride =
  'Optional. Leave blank to use the selected Product Deal title.';
COMPONENT_FIELD_DESCRIPTIONS['header.product-deal-notification'].imageOverride =
  'Optional. Leave blank to use the selected Product Deal image. Maximum 80 × 80 px; a square image is recommended.';
(COMPONENT_FIELD_DESCRIPTIONS['header.notification'] ??= {}).coupon =
  'Coupon notifications. Add one row per Coupon; each row can configure its own title and image overrides.';
COMPONENT_FIELD_DESCRIPTIONS['header.notification'].productDeal =
  'Product Deal notifications. Add one row per Product Deal; each row can configure its own title and image overrides.';
// The upload service can select a quality profile only while it still has the
// camera original. The dedicated folder is therefore the explicit editorial
// signal; linking an already-compressed root-folder asset cannot restore lost
// detail later when the Culture entry is saved.
(COMPONENT_FIELD_DESCRIPTIONS['culture.gallery-photo'] ??= {}).image =
  `Upload original photographs to the “${CULTURE_GALLERY_MEDIA_FOLDER_NAME}” Media Library folder, then select them here. ` +
  'Use JPG, PNG or WebP at 2560px or more on the longest side; this folder keeps a 2560px quality-90 WebP master and single-generation responsive images. Other Media Library folders keep the standard lighter profile.';

export async function ensureComponentFieldDescriptions(strapi: Core.Strapi): Promise<void> {
  const service: any = strapi.plugin('content-manager').service('components');
  if (!service) return;

  for (const [uid, fields] of Object.entries(COMPONENT_FIELD_DESCRIPTIONS)) {
    try {
      const component = service.findComponent(uid);
      if (!component) continue;

      const config = await service.findConfiguration(component);
      const metadatas = { ...(config.metadatas ?? {}) };
      let changed = false;

      for (const [field, description] of Object.entries(fields)) {
        if (!strapi.components[uid as any]?.attributes?.[field]) {
          strapi.log.warn(`[content-manager] ${uid} has no field "${field}" — description skipped`);
          continue;
        }
        const prev = metadatas[field] ?? {};
        if (prev.edit?.description === description) continue;
        metadatas[field] = { ...prev, edit: { ...(prev.edit ?? {}), description } };
        changed = true;
      }

      if (!changed) continue;
      await service.updateConfiguration(component, { ...config, metadatas });
      strapi.log.info(`[content-manager] field descriptions set for ${uid}`);
    } catch (err: any) {
      strapi.log.warn(
        `[content-manager] field descriptions for ${uid} failed: ${err?.message ?? err}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Editor-facing field hints for every validated field
// ---------------------------------------------------------------------------
// Every field a write-time validator enforces gets a grey description hint
// under it in the admin edit form, visible BEFORE the editor types — so limits
// are learnable without tripping them. Hints for rules living in
// changed-field-validation.ts and text-field-validation.ts are DERIVED from
// those rule tables (single source of truth). Rules owned by other validators
// are mirrored by hand below; each entry names the file it mirrors — keep them
// in step when that validator changes. hint-coverage.test.ts asserts the
// derived tables stay fully wired.

// DERIVED from the same tables the validator enforces (offer-word-limits.ts
// via offer-field-validation.ts), so the hint can never drift from the rule.
// offerText belongs only to Coupons; both offer types carry benefit fields.
const OFFER_WORD_CAP_HINTS = WORD_LIMITS.map(({ field, max }) => ({
  field,
  hint: `Up to ${max} word${max === 1 ? '' : 's'} — fills a fixed card slot.`,
}));
const OFFER_BENEFIT_HINTS = BENEFIT_TEXT_FIELDS.map(({ field, suffix }) => ({
  field,
  hint: benefitFieldHint(suffix),
}));

const VALIDATOR_MIRROR_HINTS: Array<{ uid: string; field: string; hint: string }> = [
  ...[
    { uid: 'api::coupon.coupon', hints: [...OFFER_WORD_CAP_HINTS, ...OFFER_BENEFIT_HINTS] },
    {
      uid: 'api::deal.deal',
      hints: [
        ...OFFER_BENEFIT_HINTS,
        {
          field: 'discount',
          hint: offerAmountFieldHint('the selected prefix and any applicable OFF suffix'),
        },
        {
          field: 'discountPrefix',
          hint: 'Required when a discount amount is entered.',
        },
      ],
    },
  ].flatMap(({ uid, hints }) => [
    ...hints.map(({ field, hint }) => ({ uid, field, hint })),
    {
      uid,
      field: 'logoStore',
      hint:
        'Optional image source only. The site borrows this Store logo; it does ' +
        'not add Store membership, ownership, search matching, or Store-page placement. ' +
        'Hidden and cleared automatically for affiliate-brand offers.',
    },
    // Mirrors checkout-merchant-validation.ts: the reference must resolve to a
    // live row, and it is nulled automatically if that row is later deleted.
    {
      uid,
      field: 'checkoutMerchant',
      hint:
        'Optional. One Store OR Brand — the merchant the shopper actually ' +
        'checks out with. Search the dropdown to see both; each option is ' +
        'tagged Store or Brand. Like Logo Store, this adds no membership, ' +
        'ownership or search matching. Hidden and cleared automatically for ' +
        'affiliate-brand offers.',
    },
    // Mirrors offer-lifecycle-validation.ts: past dates rejected, scheduledAt
    // must precede expiresAt, contentStatus derived from these two dates.
    {
      uid,
      field: 'scheduledAt',
      hint:
        'Optional. Must be in the future and before Expires at; leave empty to ' +
        'publish immediately. Status is set automatically from these dates.',
    },
    {
      uid,
      field: 'expiresAt',
      hint:
        'Optional. Must be in the future and after Scheduled at; leave empty to ' +
        'keep the offer live. Status is set automatically from these dates.',
    },
    // Mirrors offer-lifecycle-validation.ts: no future dates, seeded at go-live,
    // and deliberately NOT part of the published/scheduled/expired state machine.
    {
      uid,
      field: 'publishedOn',
      hint:
        'Drives "newest first" ordering on the site. Set automatically when the ' +
        'offer goes live — move it forward (or use "Bump to top") to resurface ' +
        'this offer above older ones. Cannot be in the future, and never changes ' +
        'the status: re-dating an expired offer leaves it expired.',
    },
  ]),
  // Deal content is optional: the site always renders a pre-calculated
  // Deal Price / MRP / Discount block (src/utils/deal-computed-content.ts);
  // anything written here is shown after it as "Any Other Condition".
  {
    uid: 'api::deal.deal',
    field: 'content',
    hint:
      'Optional. The site automatically shows Deal Price (bold), MRP and ' +
      'Discount from the pricing fields — anything written here appears ' +
      'after them under "Any Other Condition".',
  },
  {
    uid: 'api::deal.deal',
    field: 'enableAmazonAffiliateDisclosure',
    hint:
      'When enabled for a Deal assigned to the Amazon Store or Brand, appends ' +
      'the Amazon Creator Connections disclosure as the final item under ' +
      '"Any Other Condition". Existing written conditions stay unchanged.',
  },
  // Mirrors coupon-type-consistency.ts: code and uniqueCouponPool are mutually
  // exclusive, keyed off couponType.
  {
    uid: 'api::coupon.coupon',
    field: 'code',
    hint:
      'Shared code for "static" coupons. Cleared automatically when Coupon ' +
      'type is "unique".',
  },
  {
    uid: 'api::coupon.coupon',
    field: 'uniqueCouponPool',
    hint:
      'Required when Coupon type is "unique" — codes are handed out from this ' +
      'pool. Cleared automatically for static coupons.',
  },
  // Mirrors festive-offer-consistency.ts (clearing) and the checkFestiveOffer
  // rule in entity-field-validation.ts (both fields required when on). The
  // 60-character cap on the title is NOT restated here — changedFieldHints()
  // derives "Up to 60 characters." from the rule that enforces it, and both
  // hints are appended to the same field.
  ...['api::store.store', 'api::brand.brand'].flatMap((uid) => [
    {
      uid,
      field: 'isFestiveOffer',
      hint:
        'Turns on the festive offer title and description below. Switching it ' +
        'off CLEARS both of them on save — they are not kept in the background.',
    },
    {
      uid,
      field: 'festiveOfferTitle',
      hint: 'Required while "Is festive offer" is on.',
    },
    {
      uid,
      field: 'festiveOfferDescription',
      hint:
        'Required while "Is festive offer" is on. Rendered as formatted text ' +
        'on the site.',
    },
  ]),
  // Mirrors affiliate-offer-consistency.ts: affiliate-brand offers can only
  // select affiliate Brands, and the flag cannot be dropped while referenced.
  {
    uid: 'api::brand.brand',
    field: 'isAffiliateStore',
    hint:
      'Marks this Brand as an affiliate store. Offers with the "Affiliate ' +
      'brand offer" toggle on can only select affiliate Brands. Cannot be ' +
      'switched off while such offers still reference this Brand.',
  },
  // Mirrors redirect-validation.ts: from must be a rooted on-site path that
  // shadows nothing live; to must be a rooted path or absolute http(s) URL
  // and must not close a loop.
  {
    uid: 'api::redirect.redirect',
    field: 'from',
    hint:
      'Path on this site starting with "/", e.g. /old-page. Must not be a ' +
      "live page, a reserved route, or another active redirect's From.",
  },
  {
    uid: 'api::redirect.redirect',
    field: 'to',
    hint:
      'Path starting with "/" or a full http(s):// address. Must not point ' +
      'back at From or close a redirect loop.',
  },
  {
    uid: 'api::menu.menu',
    field: 'topStoresLabel',
    hint:
      'Label used by the desktop and mobile Top Stores navigation trigger and panel heading.',
  },
  {
    uid: 'api::menu.menu',
    field: 'topStoresTitle',
    hint:
      'Label on the All Stores control shown in both desktop and mobile store menus.',
  },
  {
    uid: 'api::menu.menu',
    field: 'topStoresViewAllUrl',
    hint:
      'Destination for the All Stores control. Enter a rooted site path or full http(s) URL.',
  },
  {
    uid: 'api::menu.menu',
    field: 'categoriesLabel',
    hint:
      'Label used by the desktop navigation trigger, desktop mega-menu heading, and mobile Categories panel.',
  },
  {
    uid: 'api::menu.menu',
    field: 'categoriesTitle',
    hint:
      'Label on the All Categories control shown in both desktop and mobile category menus.',
  },
  {
    uid: 'api::menu.menu',
    field: 'categoriesPopularStoresTitle',
    hint:
      'Heading above the first four configured Top Stores in the mobile Categories drill-down.',
  },
  {
    uid: 'api::menu.menu',
    field: 'categoriesViewAllUrl',
    hint:
      'Destination for the All Categories control. Enter a rooted site path or full http(s) URL.',
  },
  {
    uid: 'api::menu.menu',
    field: 'notification',
    hint:
      'Header notifications are managed together here. Add as many Coupon and Product Deal rows as needed.',
  },
  // Mirrors identity-validation.ts: name unique per type; slug unique across
  // all four taxonomies and off the reserved-route list.
  ...['store', 'brand', 'category', 'bank'].flatMap((name) => [
    {
      uid: `api::${name}.${name}`,
      field: 'name',
      hint:
        `Unique among ${name.endsWith('y') ? `${name.slice(0, -1)}ies` : `${name}s`} — ` +
        'compared ignoring capitalisation and surrounding spaces.',
    },
    {
      uid: `api::${name}.${name}`,
      field: 'slug',
      hint:
        'Public URL segment. Must be unique across stores, brands, categories ' +
        'and banks, and must not match a reserved page or an active redirect.',
    },
    {
      uid: `api::${name}.${name}`,
      field: 'showTrendingDeals',
      hint:
        'Show automatically selected live Product Deals on this entity page. ' +
        'Turn this off to hide the entire Trending Deals section.',
    },
  ]),
];

// Merge the three hint sources. When several validators constrain the same
// field the sentences are concatenated (required-ness first, then format
// limits, then the mirrored notes), so the editor sees one combined hint.
// Exported for hint-coverage.test.ts only (via the src/index.ts re-export).
export const CONTENT_TYPE_FIELD_HINTS: Record<string, Record<string, string>> = {};
{
  const componentHints: Record<string, Record<string, string>> = {};
  const append = (
    table: Record<string, Record<string, string>>,
    key: string,
    field: string,
    hint: string,
  ) => {
    if (!hint) return;
    const fields = (table[key] ??= {});
    const prev = fields[field];
    fields[field] = prev ? (prev.includes(hint) ? prev : `${prev} ${hint}`) : hint;
  };

  for (const entry of textFieldHints()) {
    if (entry.componentUid) {
      append(componentHints, entry.componentUid, entry.field, entry.hint);
    } else {
      append(CONTENT_TYPE_FIELD_HINTS, entry.uid, entry.field, entry.hint);
    }
  }
  for (const { uid, field, hint } of changedFieldHints()) {
    append(CONTENT_TYPE_FIELD_HINTS, uid, field, hint);
  }
  for (const { componentUid, field, hint } of changedFieldSeoHints()) {
    append(componentHints, componentUid, field, hint);
  }
  for (const { uid, field, hint } of VALIDATOR_MIRROR_HINTS) {
    append(CONTENT_TYPE_FIELD_HINTS, uid, field, hint);
  }
  // Component hints ride the existing component pass. An explicit description
  // declared above (homepage images, the canonicalUrl HTML warning) always
  // wins over a derived hint — skip keys already present.
  for (const [componentUid, fields] of Object.entries(componentHints)) {
    for (const [field, hint] of Object.entries(fields)) {
      if (COMPONENT_FIELD_DESCRIPTIONS[componentUid]?.[field]) continue;
      (COMPONENT_FIELD_DESCRIPTIONS[componentUid] ??= {})[field] = hint;
    }
  }
}

// Editor-facing LABELS for top-level attributes whose auto-derived name reads
// badly. Content-manager titlecases the attribute name, so `publishedOn`
// surfaces as "Published On" — nearly indistinguishable from Strapi's own
// internal `publishedAt`, which is exactly the confusion this field exists to
// remove. Applied to BOTH the edit and list metadata: `publishedOn` is a
// sortable list column, so the table header needs the same name the Publishing
// panel uses or the two views disagree about what the field is called.
const CONTENT_TYPE_FIELD_LABELS: Record<string, Record<string, string>> = {
  'api::coupon.coupon': {
    publishedOn: 'Published date',
    logoStore: 'Logo Store (image only)',
    checkoutMerchant: 'Checkout merchant (Store or Brand)',
    isForAffiliateBrand: 'Affiliate brand offer',
  },
  'api::deal.deal': {
    publishedOn: 'Published date',
    logoStore: 'Logo Store (image only)',
    checkoutMerchant: 'Checkout merchant (Store or Brand)',
    isForAffiliateBrand: 'Affiliate brand offer',
    enableAmazonAffiliateDisclosure: 'Amazon affiliate disclosure',
  },
  'api::menu.menu': {
    notification: 'Notification',
    topStoresLabel: 'Top Stores navigation label',
    topStoresTitle: 'All Stores button label',
    topStoresViewAllUrl: 'All Stores button URL',
    categoriesLabel: 'Categories navigation label',
    categoriesTitle: 'All Categories button label',
    categoriesPopularStoresTitle: 'Mobile Popular Stores heading',
    categoriesViewAllUrl: 'All Categories button URL',
  },
  ...Object.fromEntries(
    ['store', 'category', 'bank'].map((name) => [
      `api::${name}.${name}`,
      { showTrendingDeals: 'Show Trending Deals' },
    ]),
  ),
  // Brand gets the shared label plus its own — an explicit key after the
  // spread REPLACES the spread's entry, so both must live here together.
  'api::brand.brand': {
    showTrendingDeals: 'Show Trending Deals',
    isAffiliateStore: 'Affiliate Store',
  },
};

// Content-type counterpart of ensureComponentFieldDescriptions: pins the
// merged hints into metadatas[attr].edit.description (and the labels above into
// metadatas[attr].edit.label) for top-level attributes. Same DB config store +
// config-as-code + idempotent-boot approach — second restart compares equal and
// logs nothing.
export async function ensureFieldDescriptions(strapi: Core.Strapi): Promise<void> {
  const service: any = strapi.plugin('content-manager').service('content-types');
  if (!service) return;

  const uids = new Set([
    ...Object.keys(CONTENT_TYPE_FIELD_HINTS),
    ...Object.keys(CONTENT_TYPE_FIELD_LABELS),
  ]);

  for (const uid of uids) {
    try {
      const contentType = strapi.contentType(uid as any);
      if (!contentType) continue;

      const config = await service.findConfiguration(contentType);
      const metadatas = { ...(config.metadatas ?? {}) };
      let changed = false;

      const fields = CONTENT_TYPE_FIELD_HINTS[uid] ?? {};
      const labels = CONTENT_TYPE_FIELD_LABELS[uid] ?? {};

      for (const field of new Set([...Object.keys(fields), ...Object.keys(labels)])) {
        if (!contentType.attributes?.[field]) {
          strapi.log.warn(`[content-manager] ${uid} has no field "${field}" — description skipped`);
          continue;
        }
        const description = fields[field];
        const label = labels[field];
        const mainField = field === 'logoStore' ? 'name' : undefined;
        const prev = metadatas[field] ?? {};
        const descriptionSettled =
          description === undefined || prev.edit?.description === description;
        const labelSettled =
          label === undefined ||
          (prev.edit?.label === label && prev.list?.label === label);
        const mainFieldSettled =
          mainField === undefined || prev.edit?.mainField === mainField;
        if (descriptionSettled && labelSettled && mainFieldSettled) continue;

        metadatas[field] = {
          ...prev,
          edit: {
            ...(prev.edit ?? {}),
            ...(description === undefined ? {} : { description }),
            ...(label === undefined ? {} : { label }),
            ...(mainField === undefined ? {} : { mainField }),
          },
          // The list header reads metadatas[field].list.label, a separate key
          // from the edit one — set both or the table column keeps the
          // auto-derived "Published On".
          list: {
            ...(prev.list ?? {}),
            ...(label === undefined ? {} : { label }),
          },
        };
        changed = true;
      }

      if (!changed) continue;
      await service.updateConfiguration(contentType, {
        settings: config.settings,
        metadatas,
        layouts: config.layouts,
        options: config.options,
      });
      strapi.log.info(`[content-manager] field descriptions set for ${uid}`);
    } catch (err: any) {
      strapi.log.warn(
        `[content-manager] field descriptions for ${uid} failed: ${err?.message ?? err}`
      );
    }
  }
}
