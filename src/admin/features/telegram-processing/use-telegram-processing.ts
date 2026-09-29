import { useCallback, useEffect, useRef, useState } from 'react';
import { useFetchClient } from '@strapi/strapi/admin';

export type ProcessingJob = { id: string; revision: number; messageId: number; stage: string; attempts: number; error: string | null;
  nextAttemptAt?: string; checking?: boolean;
  errorDetails?: { step: string; message: string; occurredAt: string; type: string; status?: number; code?: string; contentType?: string; detectedType?: string } | null;
  title?: string; postedAt?: string; permalink?: string; photo?: { url: string; alt: string } | null };
export function useTelegramProcessing(view: 'pending' | 'posts' = 'pending') {
  const { get, post } = useFetchClient();
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ jobs: ProcessingJob[]; total: number }>({ jobs: [], total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setBusy(true);
    try {
      const response = await get(`/telegram-processing${view === 'posts' ? '/posts' : ''}?page=${page}`);
      if (request === generation.current) { setData(response.data); setError(null); }
    }
    catch { if (request === generation.current) setError('Unable to load image processing status.'); }
    finally { if (request === generation.current) setBusy(false); }
  }, [get, page, view]);
  useEffect(() => { void refresh(); return () => { generation.current++; }; }, [refresh]);
  const retry = async (job: ProcessingJob, newProcessing: boolean) => {
    setBusy(true);
    try {
      await post(`/telegram-processing/${job.id}/retry`, { revision: job.revision, newProcessing });
      await refresh();
    } catch { setError('The worker is busy or the message changed. Refresh and try again.'); }
    finally { setBusy(false); }
  };
  const check = async (job: ProcessingJob) => {
    setBusy(true);
    try { await post(`/telegram-processing/${job.id}/check`, { revision: job.revision }); await refresh(); }
    catch { setError('Unable to request the check. Refresh and try again.'); }
    finally { setBusy(false); }
  };
  return { ...data, page, setPage, error, busy, refresh, retry, check };
}
