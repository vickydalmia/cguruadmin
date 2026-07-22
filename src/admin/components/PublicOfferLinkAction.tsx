import type { DocumentActionComponent } from '@strapi/content-manager/strapi-admin';
import { useNotification } from '@strapi/strapi/admin';
import { Link } from '@strapi/icons';
import * as React from 'react';
import { useIntl } from 'react-intl';

import {
  PUBLIC_OFFER_ROUTE_BY_MODEL,
  buildPublicOfferUrl,
} from '../utils/public-offer-url';

const PUBLIC_SITE_URL = process.env.STRAPI_ADMIN_PUBLIC_SITE_URL;

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textArea = document.createElement('textarea');
  textArea.value = value;
  textArea.setAttribute('readonly', '');
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.appendChild(textArea);
  textArea.select();

  try {
    if (!document.execCommand('copy')) {
      throw new Error('The browser rejected the copy command.');
    }
  } finally {
    textArea.remove();
  }
}

const PublicOfferLinkAction: DocumentActionComponent = ({ model, document: entry }) => {
  const { formatMessage } = useIntl();
  const { toggleNotification } = useNotification();
  const numericId = Number(entry?.id);
  const isPublicOffer = model in PUBLIC_OFFER_ROUTE_BY_MODEL;
  const publicUrl = buildPublicOfferUrl(model, entry?.id, PUBLIC_SITE_URL);

  if (!isPublicOffer || !Number.isSafeInteger(numericId) || numericId <= 0) {
    return null;
  }

  return {
    label: formatMessage({
      id: 'couponzguru.public-offer-link.copy',
      defaultMessage: 'Copy public link',
    }),
    icon: <Link />,
    position: 'table-row',
    onClick: async (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (!publicUrl) {
        toggleNotification({
          type: 'danger',
          title: formatMessage({
            id: 'couponzguru.public-offer-link.not-configured-title',
            defaultMessage: 'Public site URL is not configured',
          }),
          message: formatMessage({
            id: 'couponzguru.public-offer-link.not-configured-message',
            defaultMessage:
              'Set STRAPI_ADMIN_PUBLIC_SITE_URL and rebuild the Strapi admin panel.',
          }),
        });
        return;
      }

      try {
        await copyText(publicUrl);
        toggleNotification({
          type: 'success',
          title: formatMessage({
            id: 'couponzguru.public-offer-link.copied-title',
            defaultMessage: 'Public link copied',
          }),
          message: publicUrl,
          link: {
            label: formatMessage({
              id: 'couponzguru.public-offer-link.open',
              defaultMessage: 'Open page',
            }),
            url: publicUrl,
            target: '_blank',
          },
        });
      } catch {
        toggleNotification({
          type: 'danger',
          title: formatMessage({
            id: 'couponzguru.public-offer-link.copy-failed-title',
            defaultMessage: 'Could not copy the public link',
          }),
          message: formatMessage({
            id: 'couponzguru.public-offer-link.copy-failed-message',
            defaultMessage: 'Please allow clipboard access and try again.',
          }),
        });
      }
    },
  };
};

PublicOfferLinkAction.position = 'table-row';

export default PublicOfferLinkAction;
