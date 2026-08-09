import type { Core } from '@strapi/strapi';

import {
  changedFieldHints,
  changedFieldSeoHints,
} from '../../utils/changed-field-validation';
import { BENEFIT_TEXT_FIELDS, WORD_LIMITS } from '../../utils/offer-field-validation';
import {
  benefitFieldHint,
  offerAmountFieldHint,
} from '../../utils/offer-word-limits';
import { textFieldHints } from '../../utils/text-field-validation';
import { COMPONENT_FIELD_DESCRIPTIONS } from './component-field-hints';

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
        'not add Store membership, ownership, search matching, or Store-page placement.',
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
        'ownership or search matching.',
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
  // Mirrors affiliate-brand-validation.ts: an affiliate brand is an offer's
  // only merchant (no Store, no other brands, no conflicting checkout
  // merchant), and flipping the toggle ON sweeps existing offers clean.
  {
    uid: 'api::brand.brand',
    field: 'isAffiliate',
    hint:
      "Affiliate brands are an offer's ONLY merchant — never combined with a " +
      'Store or other brands on a Coupon/Product Deal. Turning this ON ' +
      'immediately detaches this brand from every offer that has a Store or ' +
      'other brands, and clears conflicting checkout merchants.',
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
// Exported for hint-coverage.test.ts only.
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
  //
  // NOTE this MUTATES component-field-hints.ts's exported table from another
  // module. Safe today because everything reaches that table through this
  // module (src/index.ts and bootstrap-application import both); an import of
  // component-field-hints ALONE would see the unmerged seeds. See the note on
  // COMPONENT_FIELD_DESCRIPTIONS.
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
  },
  'api::deal.deal': {
    publishedOn: 'Published date',
    logoStore: 'Logo Store (image only)',
    checkoutMerchant: 'Checkout merchant (Store or Brand)',
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
    ['store', 'brand', 'category', 'bank'].map((name) => [
      `api::${name}.${name}`,
      { showTrendingDeals: 'Show Trending Deals' },
    ]),
  ),
  // Spread AFTER the fan-out: a later duplicate key replaces the whole object,
  // so the shared label must be restated here.
  'api::brand.brand': {
    showTrendingDeals: 'Show Trending Deals',
    isAffiliate: 'Affiliate brand',
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
