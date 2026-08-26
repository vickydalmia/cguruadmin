import type { DocumentActionComponent } from '@strapi/content-manager/strapi-admin';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';
import { Link } from '@strapi/icons';
import * as React from 'react';
import { useIntl } from 'react-intl';

import {
  PUBLIC_OFFER_ROUTE_BY_MODEL,
  buildPublicOfferUrl,
} from '../utils/public-offer-url';
import { loadRuntimePublicSiteUrl } from '../features/public-offer-link/runtime-config';

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
  const { get } = useFetchClient();
  const numericId = Number(entry?.id);
  const isPublicOffer = model in PUBLIC_OFFER_ROUTE_BY_MODEL;

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

      let configuredSiteUrl: string | null;
      try {
        configuredSiteUrl = await loadRuntimePublicSiteUrl(get);
      } catch {
        toggleNotification({
          type: 'danger',
          title: formatMessage({
            id: 'couponzguru.public-offer-link.config-load-failed-title',
            defaultMessage: 'Could not load the public site URL',
          }),
          message: formatMessage({
            id: 'couponzguru.public-offer-link.config-load-failed-message',
            defaultMessage:
              'The running Strapi configuration could not be read. Check the connection and try again.',
          }),
        });
        return;
      }

      const publicUrl = buildPublicOfferUrl(
        model,
        entry?.id,
        configuredSiteUrl ?? undefined,
      );
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
              'Set PUBLIC_SITE_URL on the running Strapi container and restart it.',
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
