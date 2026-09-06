import type { PanelComponent } from '@strapi/content-manager/strapi-admin';
import {
  Badge,
  Box,
  Button,
  Flex,
  Typography,
} from '@strapi/design-system';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';
import * as React from 'react';

import {
  translationError,
  unwrapEntryStatus,
  type EntryTranslationStatus,
  type LocaleTranslationStatus,
} from '../api';

/**
 * "Translation" side panel: per-target-locale status of the AI translation
 * for the open entry, with manual Translate / Re-translate triggers.
 *
 * The panel self-hides on deployments with translation off (the status
 * endpoint reports enabled:false), on non-localized models (400), and while
 * creating — an unsaved entry has nothing to translate. English is the
 * source of truth: a manual Arabic edit here survives only until the next
 * English save, which the hint spells out.
 */

const STATE_LABEL: Record<LocaleTranslationStatus['state'], string> = {
  missing: 'Not translated',
  synced: 'Up to date',
  stale: 'Out of date',
  'in-progress': 'Translating…',
  blocked: 'Waiting on dependencies',
  failed: 'Failed',
};

const STATE_VARIANT: Record<
  LocaleTranslationStatus['state'],
  'success' | 'warning' | 'danger' | 'secondary'
> = {
  missing: 'secondary',
  synced: 'success',
  stale: 'warning',
  'in-progress': 'secondary',
  blocked: 'warning',
  failed: 'danger',
};

// Poll only while a job is running; the queue usually lands in seconds.
const ACTIVE_POLL_MS = 8_000;

function LocaleRow({
  status,
  busy,
  onTranslate,
}: {
  status: LocaleTranslationStatus;
  busy: boolean;
  onTranslate: (force: boolean) => void;
}) {
  const retranslate = status.state === 'synced' || status.state === 'stale';
  return (
    <Flex direction="column" alignItems="stretch" gap={2}>
      <Flex justifyContent="space-between" alignItems="center" gap={2}>
        <Typography variant="pi" fontWeight="bold">
          {status.localeName} ({status.locale})
        </Typography>
        <Badge
          backgroundColor={`${STATE_VARIANT[status.state]}100`}
          textColor={`${STATE_VARIANT[status.state]}600`}
        >
          {STATE_LABEL[status.state]}
        </Badge>
      </Flex>
      {status.needsReview ? (
        <Typography variant="pi" textColor="warning600">
          Automated quality warning{status.reviewNotes ? `: ${status.reviewNotes}` : ''}
        </Typography>
      ) : null}
      {status.lastError && (status.state === 'failed' || status.state === 'blocked') ? (
        <Typography variant="pi" textColor={status.state === 'failed' ? 'danger600' : 'warning600'}>
          {status.lastError}
        </Typography>
      ) : null}
      {status.state !== 'in-progress' ? (
        <Button
          size="S"
          variant={retranslate ? 'secondary' : 'default'}
          loading={busy}
          onClick={() => onTranslate(retranslate)}
        >
          {retranslate ? 'Re-translate' : 'Translate now'}
        </Button>
      ) : null}
    </Flex>
  );
}

const TranslationPanel: PanelComponent = ({ model, documentId }) => {
  const { get, post } = useFetchClient();
  const { toggleNotification } = useNotification();
  const [status, setStatus] = React.useState<EntryTranslationStatus | null>(null);
  const [hidden, setHidden] = React.useState(false);
  const [busyLocale, setBusyLocale] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!model || !documentId) return;
    try {
      setStatus(
        unwrapEntryStatus(
          await get(`/translation/status/${model}/${documentId}`),
        ),
      );
    } catch (error: any) {
      // 400/404 = not a localized model on this deployment: hide quietly.
      // Any other failure also hides — the panel is informational, and a
      // broken panel must never block editing.
      setHidden(true);
    }
  }, [get, model, documentId]);

  React.useEffect(() => {
    setStatus(null);
    setHidden(false);
    void load();
  }, [load]);

  const anyInProgress = Boolean(
    status?.locales.some((locale) => locale.state === 'in-progress'),
  );
  React.useEffect(() => {
    if (!anyInProgress) return;
    const timer = setInterval(() => void load(), ACTIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [anyInProgress, load]);

  if (hidden || !documentId || !status || !status.enabled) return null;
  if (status.locales.length === 0) return null;

  const translate = async (targetLocale: string, force: boolean) => {
    setBusyLocale(targetLocale);
    try {
      await post('/translation/enqueue', {
        uid: model,
        documentId,
        targetLocale,
        force,
      });
      toggleNotification({
        type: 'success',
        message: force
          ? 'Re-translation queued — the current translation will be replaced shortly.'
          : 'Translation queued.',
      });
      await load();
    } catch (error: any) {
      toggleNotification({
        type: 'danger',
        message: translationError(error),
      });
    } finally {
      setBusyLocale(null);
    }
  };

  return {
    title: 'Translation',
    content: (
      <Flex direction="column" alignItems="stretch" gap={4} width="100%">
        {status.locales.map((locale) => (
          <LocaleRow
            key={locale.locale}
            status={locale}
            busy={busyLocale === locale.locale}
            onTranslate={(force) => translate(locale.locale, force)}
          />
        ))}
        <Box>
          <Typography variant="pi" textColor="neutral600">
            English is the source of truth: saving the English entry
            re-translates automatically, replacing any manual edits made in
            the translated locale.
          </Typography>
        </Box>
      </Flex>
    ),
  };
};

export default TranslationPanel;
