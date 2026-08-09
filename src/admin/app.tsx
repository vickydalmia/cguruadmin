import type { PanelComponent } from '@strapi/content-manager/strapi-admin';
import { Earth } from '@strapi/icons';
import type { StrapiApp } from '@strapi/strapi/admin';
import * as React from 'react';

import {
  CHECKOUT_MERCHANT_CUSTOM_FIELD_NAME,
} from '../constants/checkout-merchant';
import BooleanConfirmInput from './components/BooleanConfirmInput';
import BumpToTopAction from './components/BumpToTopAction';
import DateTimeInput from './components/DateTimeInput';
import OfferBenefitsPanel from './components/OfferBenefitsPanel';
import OfferStatusTabs from './components/OfferStatusTabs';
import PublicOfferLinkAction from './components/PublicOfferLinkAction';
import PublishingPanel from './components/PublishingPanel';
import RecordLockPanel from './components/RecordLockPanel';
import RichTextEditor from './components/RichTextEditor';
import Logo from './extensions/logo-icon.svg';
import { couponLayoutPanel } from './features/coupon-layout/components/coupon-layout-panel';
import { createDealAwareMediaInput } from './features/deal-image/components/deal-aware-media-input';
import {
  INJECT_COLUMN_IN_TABLE,
  linkifyFirstColumnHook,
} from './features/list-entry-links/linkify-first-column';
import { RelationMultiSelectPanel } from './features/offer-relations/relation-multi-select-panel';
import { UniqueCodeImportPanel } from './features/unique-code-import/unique-code-import-panel';
import { ValidationProblemsPanel } from './features/validation-problems/validation-problems-panel';
import { bootstrapAdminDom } from './utils/bootstrap-admin-dom';
import { installRecordLockLeaseInterceptor } from './utils/record-lock-lease';

const EntityCouponLayoutPanel: PanelComponent = ({ model, documentId }) =>
  couponLayoutPanel(model, documentId);

export default {
  register(app: StrapiApp) {
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
    app.addFields({ type: 'datetime', Component: DateTimeInput } as any);
    app.addFields({ type: 'boolean', Component: BooleanConfirmInput } as any);

    // Checkout Merchant: one dropdown listing every Store AND every Brand, on
    // both Coupon and Product Deal. A custom field rather than a relation
    // because a relation targets exactly one content type, and rather than a
    // side panel because a custom field is the only supported seam that
    // renders inside the MAIN edit form — see
    // src/constants/checkout-merchant.ts for the alternatives and why they
    // lose. The server half (src/lifecycles/register-application.ts) must
    // declare the same name, or the two `global::` uids diverge and the field
    // renders as "missing custom field".
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
          return {
            default: module.default as unknown as React.ComponentType,
          };
        },
      },
    });

    // Generated Product Deal pages (/<slugified-entity-name>-deals/) have no
    // content type of their own — they are derived from the four entity
    // collections — so there is nothing for the Content Manager to list. This
    // screen is the only surface for them. `permissions: []` gates nothing on
    // its own: the endpoints behind it are Super-Admin-only server-side, and
    // the page renders the resulting 403 as an explanation rather than an
    // empty table.
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
    auth: {
      logo: Logo,
    },
    menu: {
      logo: Logo,
    },
    locales: ['en'],
    translations: {
      en: {
        'Auth.form.welcome.title': 'Welcome to CouponzGuru',
        'Auth.form.welcome.subtitle': 'Log in to your account',
        'global.finish': 'Confirm',
        'content-manager.validation.error':
          'Some required fields are empty or invalid. See the "Validation problems" panel on the right — problem fields are marked in red and their rows open automatically.',
      },
    },
  },

  bootstrap(app: StrapiApp) {
    installRecordLockLeaseInterceptor();
    const contentManager = app.getPlugin('content-manager') as any;
    const apis = contentManager.apis;
    apis.addDocumentAction([PublicOfferLinkAction, BumpToTopAction]);
    contentManager.injectComponent('listView', 'actions', {
      name: 'offer-status-tabs',
      Component: OfferStatusTabs,
    });
    // Panel order = the order editors read them. Strapi's own "Entry" panel
    // (Save, Publish) is always first; RecordLock is next so the "someone
    // else is editing" warning is the first custom thing an editor sees (it
    // also owns the heartbeat that holds the edit lock), and Publishing sits
    // directly under it because scheduling is what an editor checks right
    // before saving.
    apis.addEditViewSidePanel([
      RecordLockPanel,
      PublishingPanel,
      OfferBenefitsPanel,
      RelationMultiSelectPanel,
      EntityCouponLayoutPanel,
      UniqueCodeImportPanel,
      ValidationProblemsPanel,
    ]);
    app.registerHook(INJECT_COLUMN_IN_TABLE, linkifyFirstColumnHook);
    bootstrapAdminDom();
  },
};
