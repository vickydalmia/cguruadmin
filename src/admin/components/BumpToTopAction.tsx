import type { DocumentActionComponent } from '@strapi/content-manager/strapi-admin';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';
import { ArrowUp } from '@strapi/icons';
import * as React from 'react';
import { useIntl } from 'react-intl';

import { isOfferModel } from '../utils/offer-status-filter';

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const response = (error as any).response?.data?.error?.message;
    if (typeof response === 'string' && response) return response;
    const message = (error as any).message;
    if (typeof message === 'string' && message) return message;
  }
  return 'Request failed';
}

/**
 * One-click "make this offer the newest one" — sets `publishedOn` to now, which
 * is the sort key behind every "newest first" listing on the site (see
 * NEWEST_FIRST in src/utils/offer-visibility.ts).
 *
 * Deliberately does NOT touch contentStatus: bumping an expired or scheduled
 * offer only moves it in the ordering, it never republishes it. The server
 * enforces the same rule (src/utils/offer-lifecycle-validation.ts).
 *
 * THE STRICT-VALIDATION CAVEAT: this is an HTTP write, so it counts as a human
 * save (src/utils/write-origin.ts) and triggers FULL-record validation — a
 * legacy/WordPress-migrated row with a past `scheduledAt`/`expiresAt` will be
 * rejected until those fields are cleaned. That is the intended "clean as you
 * touch" behaviour, so the failure toast surfaces the server's own message and
 * points the editor at the form rather than swallowing it.
 */
const BumpToTopAction: DocumentActionComponent = ({ model, documentId, collectionType }) => {
  const { formatMessage } = useIntl();
  const { toggleNotification } = useNotification();
  const { put } = useFetchClient();
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  // Undefined documentId means the entry is being created and has nothing to
  // bump yet — the lifecycle validator stamps publishedOn on first save.
  if (!isOfferModel(model) || !documentId) return null;

  return {
    label: formatMessage({
      id: 'couponzguru.bump-to-top.label',
      defaultMessage: 'Bump to top',
    }),
    icon: <ArrowUp />,
    disabled: isSubmitting,
    onClick: async () => {
      setIsSubmitting(true);
      try {
        // Sent a hair in the PAST on purpose. The server rejects a future
        // publishedOn, and this timestamp comes from the browser — a client
        // clock a few seconds fast would otherwise fail its own bump. The
        // server snaps anything within its grace window back to server-now, so
        // the stored value is server-authoritative either way (see
        // src/utils/offer-lifecycle-validation.ts).
        await put(`/content-manager/${collectionType}/${model}/${documentId}`, {
          publishedOn: new Date(Date.now() - 1000).toISOString(),
        });
        toggleNotification({
          type: 'success',
          title: formatMessage({
            id: 'couponzguru.bump-to-top.done-title',
            defaultMessage: 'Moved to the top',
          }),
          message: formatMessage({
            id: 'couponzguru.bump-to-top.done-message',
            defaultMessage:
              'Published date set to now — this offer now leads the "newest first" listings. Reload to see the updated date.',
          }),
        });
      } catch (error) {
        toggleNotification({
          type: 'danger',
          title: formatMessage({
            id: 'couponzguru.bump-to-top.failed-title',
            defaultMessage: 'Could not bump this offer',
          }),
          message: `${errorMessage(error)} — open the entry and fix the highlighted fields, then try again.`,
        });
      } finally {
        setIsSubmitting(false);
      }
    },
  };
};

// LIST ROWS ONLY. In the edit view the Publishing panel offers the same thing
// as plain form state ("Set to now"), which the editor can review and undo
// before saving. Offering both would mean two buttons where one writes
// immediately and the other waits for Save — the kind of split that gets
// clicked wrong. From a list row there is no form to hold the change, so the
// immediate write below is the only option there.
BumpToTopAction.position = ['table-row'];

export default BumpToTopAction;
