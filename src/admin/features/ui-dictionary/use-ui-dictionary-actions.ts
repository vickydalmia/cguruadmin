// Mutations of the UI Text screen: save/reset one entry, import/export a
// language, trigger translation. Each reports through the notification
// tray and asks the page to re-read — statuses and job state are computed
// server-side, so what is on screen must come back from the server.
import * as React from 'react';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';

import { downloadBlob } from '../../utils/download-blob';
import {
  entryPath,
  exportFileName,
  exportPath,
  importPath,
  translatePath,
  uiDictionaryError,
  unwrapExport,
  unwrapImportResult,
} from './api';
import { ENGLISH_CODE, type ImportResult, type UiDictionaryEntry } from './types';

export function useUiDictionaryActions(locale: string, reload: () => void) {
  const { put, del, post, get } = useFetchClient();
  const { toggleNotification } = useNotification();
  const [busy, setBusy] = React.useState(false);

  const fail = (caught: unknown) =>
    toggleNotification({ type: 'danger', message: uiDictionaryError(caught) });

  const run = async <T,>(work: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    try {
      return await work();
    } catch (caught) {
      fail(caught);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const isEnglish = locale === ENGLISH_CODE;

  const save = (entry: UiDictionaryEntry, text: string) =>
    run(async () => {
      await put(entryPath(locale, entry.key), { text });
      toggleNotification({
        type: 'success',
        message: isEnglish ? 'English override saved.' : 'Translation saved.',
      });
      reload();
      return true;
    });

  const reset = (entry: UiDictionaryEntry) =>
    run(async () => {
      await del(entryPath(locale, entry.key));
      toggleNotification({
        type: 'success',
        message: isEnglish
          ? 'Override cleared — the catalogue English is shown again.'
          : 'Manual text removed — the AI will re-translate this key.',
      });
      reload();
      return true;
    });

  const importMessages = async (messages: Record<string, string>): Promise<ImportResult | null> => {
    const result = await run(async () =>
      unwrapImportResult(await post(importPath(), { locale, messages })),
    );
    if (result) reload();
    return result;
  };

  const exportMessages = () =>
    run(async () => {
      const payload = unwrapExport(await get(exportPath(locale)));
      const blob = new Blob([JSON.stringify(payload.messages, null, 2)], {
        type: 'application/json',
      });
      downloadBlob(exportFileName(payload.locale), blob);
      return true;
    });

  /** English tab → every language; a language tab → that language only. */
  const translate = (force: boolean) =>
    run(async () => {
      await post(translatePath(), { locale: isEnglish ? undefined : locale, force });
      toggleNotification({
        type: 'success',
        message: force
          ? 'Re-translation queued. Manual texts are kept.'
          : 'Translation of missing and out-of-date texts queued.',
      });
      reload();
      return true;
    });

  return { busy, save, reset, importMessages, exportMessages, translate };
}
