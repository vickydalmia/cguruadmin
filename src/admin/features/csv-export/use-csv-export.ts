import * as React from 'react';
import { getFetchClient } from '@strapi/strapi/admin';

import type { CsvExportUid } from '../../../constants/csv-export';
import { downloadBlob } from '../../utils/download-blob';
import {
  csvBlob,
  exportErrorMessage,
  isAbortError,
  runCsvExport,
  type ExportProgress,
} from './api';

export type CsvExportState =
  | { status: 'idle' }
  | { status: 'running'; progress: ExportProgress | null }
  | { status: 'done'; fileName: string; rows: number }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

/**
 * Component-state adapter around `runCsvExport`. Owns the AbortController so
 * the modal's Cancel (and closing the modal mid-run) stops the page loop, and
 * hands the finished file to the browser.
 */
export function useCsvExport(uid: CsvExportUid) {
  const [state, setState] = React.useState<CsvExportState>({ status: 'idle' });
  const controllerRef = React.useRef<AbortController | null>(null);

  const cancel = React.useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  const start = React.useCallback(async () => {
    cancel();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ status: 'running', progress: null });

    try {
      const result = await runCsvExport(getFetchClient(), uid, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (controller.signal.aborted) return;
          setState({ status: 'running', progress });
        },
      });
      if (controller.signal.aborted) return;
      downloadBlob(result.fileName, csvBlob(result.text));
      setState({ status: 'done', fileName: result.fileName, rows: result.rows });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        setState({ status: 'cancelled' });
        return;
      }
      setState({ status: 'error', message: exportErrorMessage(error, uid) });
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [cancel, uid]);

  const reset = React.useCallback(() => {
    cancel();
    setState({ status: 'idle' });
  }, [cancel]);

  // Leaving the list view mid-export must not leave a request loop running.
  React.useEffect(() => cancel, [cancel]);

  return { state, start, cancel, reset };
}
