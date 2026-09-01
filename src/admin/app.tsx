import Logo from './extensions/logo-icon.svg';

import type { StrapiApp } from '@strapi/strapi/admin';
import type { PanelComponent } from '@strapi/content-manager/strapi-admin';
import * as React from 'react';
import { Earth } from '@strapi/icons';

import { CHECKOUT_MERCHANT_CUSTOM_FIELD_NAME } from '../constants/checkout-merchant';
import RichTextEditor from './features/rich-text/rich-text-editor';
import DateTimeInput from './components/date-time-input';
import BooleanConfirmInput from './components/boolean-confirm-input';
import PublicOfferLinkAction from './components/public-offer-link-action';
import BumpToTopAction from './components/bump-to-top-action';
import OfferStatusTabs from './components/offer-status-tabs';
import CsvExportButton from './features/csv-export/components/csv-export-button';
import PublishingPanel from './components/publishing-panel';
import OfferBenefitsPanel from './components/offer-benefits-panel';
import RecordLockPanel from './features/record-lock/record-lock-panel';
import UniqueCodeImportPanel from './components/unique-code-import-panel';
import ValidationProblemsPanel from './components/validation-problems-panel';
import TranslationPanel from './features/translation/components/translation-panel';
import { installEnterKeyGuard, installTitleRewrite } from './utils/dom-behaviors';
import {
  INJECT_COLUMN_IN_TABLE,
  linkifyFirstColumnHook,
} from './utils/linkify-first-column';
import { installRecordLockLeaseInterceptor } from './utils/record-lock-lease';
import { createDealAwareMediaInput } from './features/deal-image/components/deal-aware-media-input';
import { couponLayoutPanel } from './features/coupon-layout/components/coupon-layout-panel';
import { RelationMultiSelectPanel } from './features/taxonomy-panel/components/taxonomy-panel';

/**
 * Top Picks and Ordered Coupons were two separate sidebar panels. They are now
 * one full-width dialog (features/coupon-layout): the two selections interact —
 * a Coupon may not appear in both, and the server rejects the ENTIRE save if it
 * does — so editing them apart is what made the conflict easy to create.
 */
const EntityCouponLayoutPanel: PanelComponent = ({ model, documentId }) =>
  couponLayoutPanel(model, documentId);

export default {
  register(app: StrapiApp) {
    // Strapi registers plugin fields before the application's register hook.
    // Keep the stock media input for every field except Product Deal.dealImage,
    // whose dedicated uploader guarantees transparent-only AWS persistence.
    const standardMediaInput = (app as any).library?.fields?.media;
    if (standardMediaInput) {
      app.addFields({
        type: 'media',
        Component: createDealAwareMediaInput(standardMediaInput),
      } as any);
    }
    // Replace the built-in markdown editor for ALL `richtext` fields with the
    // TipTap WYSIWYG (the fields store HTML, rendered raw on the site). NOTE:
    // in Strapi 5 the registry key must be the raw attribute type 'richtext'
    // — the v4 'wysiwyg' key silently does nothing.
    app.addFields({ type: 'richtext', Component: RichTextEditor } as any);
    // Same picker as Strapi's built-in datetime input, but with 5-minute time
    // steps (QC: coupon schedule needs finer granularity than 15 min).
    app.addFields({ type: 'datetime', Component: DateTimeInput } as any);
    // Confirmation dialog before any boolean toggle flips (QC: avoid accidental
    // ON/OFF from a stray click).
    app.addFields({ type: 'boolean', Component: BooleanConfirmInput } as any);
    // Slug fields are plain `string` attributes (schema-regex-validated, typed
    // by hand) — the former uid SlugInput and its Regenerate button are gone.

    // Checkout Merchant: one dropdown listing every Store AND every Brand, on
    // both Coupon and Product Deal. A custom field rather than a relation
    // because a relation targets exactly one content type, and rather than a
    // side panel because a custom field is the only supported seam that
    // renders inside the MAIN edit form — see
    // src/constants/checkout-merchant.ts for the alternatives and why they
    // lose. The server half (src/index.ts register) must declare the same
    // name, or the two `global::` uids diverge and the field renders as
    // "missing custom field".
    //
    // Input is lazy on purpose: the registry expects a loader, and this keeps
    // the picker's fetch code out of the initial admin bundle for the many
    // screens that never show the field.
    app.customFields.register({
      name: CHECKOUT_MERCHANT_CUSTOM_FIELD_NAME,
      type: 'string',
      intlLabel: {
        id: 'checkout-merchant.label',
        defaultMessage: 'Checkout merchant',
      },
      intlDescription: {
        id: 'checkout-merchant.description',
        defaultMessage: 'The Store or Brand the shopper checks out with',
      },
      components: {
        Input: async () => {
          const module = await import(
            './features/checkout-merchant/components/checkout-merchant-input'
          );
          // The registry types the loader as ComponentType<{}> — it renders
          // every custom field through one untyped slot and feeds it the
          // field's props at runtime — so a component declaring real required
          // props needs this widening to be assignable at all.
          return {
            default: module.default as unknown as React.ComponentType,
          };
        },
      },
    });

    // Generated Product Deal pages (/<slugified-entity-name>-deals/) have no content
    // type of their own — they are derived from the four entity collections —
    // so there is nothing for the Content Manager to list. This screen is the
    // only surface for them. `permissions: []` gates nothing on its own: the
    // endpoints behind it are Super-Admin-only server-side, and the page
    // renders the resulting 403 as an explanation rather than an empty table.
    app.addMenuLink({
      to: '/entity-deal-pages',
      icon: Earth,
      permissions: [],
      intlLabel: {
        id: 'entity-deal-pages.menu.label',
        defaultMessage: 'Deal page SEO',
      },
      Component: async () => {
        const page = await import(
          './features/entity-deal-page-seo/components/entity-deal-page-seo-page'
        );
        return { default: page.default };
      },
    });
  },

  config: {
    auth: { // Replace the Strapi logo in auth (login) views
      logo: Logo,
    },
    menu: { // Replace the Strapi logo in the main navigation
      logo: Logo,
    },
    locales: ['en'],
    translations: {
      en: {
        'Auth.form.welcome.title': 'Welcome to CouponzGuru',
        'Auth.form.welcome.subtitle': 'Log in to your account',
        // The media-library selection dialog uses this global action label.
        'global.finish': 'Confirm',
        // Shown when the pre-save (client-side) check finds empty required
        // fields — the request never reaches the server in that case, so the
        // detailed server toast can't appear. Point editors at the panel.
        'content-manager.validation.error':
          'Some required fields are empty or invalid. See the "Validation problems" panel on the right — problem fields are marked in red and their rows open automatically.',
      },
    }
  },
  bootstrap(app: StrapiApp) {
    app.addSettingsLink('global', {
      id: 'country-setup',
      to: '/settings/country-setup',
      permissions: [],
      intlLabel: {
        id: 'country-setup.settings.label',
        defaultMessage: 'Country Setup',
      },
      Component: async () => {
        const page = await import(
          './features/country-setup/components/country-setup-page'
        );
        return { default: page.default };
      },
    });
    // Storefront UI text (English overrides + every language). `permissions:
    // []` gates nothing on its own: the endpoints behind it require the
    // ui-dictionary.manage RBAC action server-side, and the page renders the
    // resulting 403 as an explanation rather than an empty table.
    app.addSettingsLink('global', {
      id: 'ui-dictionary',
      to: '/settings/ui-dictionary',
      permissions: [],
      intlLabel: {
        id: 'ui-dictionary.settings.label',
        defaultMessage: 'UI Text',
      },
      Component: async () => {
        const page = await import(
          './features/ui-dictionary/components/ui-dictionary-page'
        );
        return { default: page.default };
      },
    });
    installRecordLockLeaseInterceptor();
    const contentManager = app.getPlugin('content-manager') as any;
    const apis = contentManager.apis;
    apis.addDocumentAction([PublicOfferLinkAction, BumpToTopAction]);

    // Published / Scheduled / Expired shortcuts in the Coupon and Product Deal
    // list toolbars. `listView.actions` is the only list-view injection zone
    // Strapi 5 exposes — see the component for why that shapes the UI.
    contentManager.injectComponent('listView', 'actions', {
      name: 'offer-status-tabs',
      Component: OfferStatusTabs,
    });
    // Super-Admin-only "Export CSV" on the six main collection lists. Same
    // zone; the component hides itself on every other model and role.
    contentManager.injectComponent('listView', 'actions', {
      name: 'csv-export',
      Component: CsvExportButton,
    });
    // Panel order = the order editors read them. Strapi's own "Entry" panel
    // (Save, Publish) is always first; Publishing sits directly under it
    // because scheduling is what an editor checks right before saving.
    apis.addEditViewSidePanel([
      // First so the "someone else is editing" warning is the first thing an
      // editor sees; it also owns the heartbeat that holds the edit lock.
      RecordLockPanel,
      PublishingPanel,
      OfferBenefitsPanel,
      RelationMultiSelectPanel,
      EntityCouponLayoutPanel,
      UniqueCodeImportPanel,
      ValidationProblemsPanel,
      // Self-hides unless this deployment translates content (Country
      // Setup + TRANSLATION_* env) and the model is localized.
      TranslationPanel,
    ]);

    // Registered after every plugin's bootstrap, so this sees (and preserves)
    // any column i18n or review-workflows already injected.
    app.registerHook(INJECT_COLUMN_IN_TABLE, linkifyFirstColumnHook);

    installTitleRewrite();
    installEnterKeyGuard();
  },
};
