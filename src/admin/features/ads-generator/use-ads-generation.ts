import * as React from 'react';
import { ADS_LLM_LIMITS, type AdsGeneratorFormInput, type AdsGeneratorJob } from '../../../constants/ads-generator';
import {
  adsGeneratorError,
  jobFailure,
  rememberJob,
  rememberedJob,
  type AdsGeneratorFailure,
  type adsGeneratorApi,
} from './api';

type Api = ReturnType<typeof adsGeneratorApi>;

/**
 * Starts a generation and follows its background job: the POST returns at
 * once and this hook polls GET /jobs/:id until the job finishes. A job left
 * running by a page reload is picked up again from sessionStorage.
 */
export function useAdsGeneration(api: Api) {
  const [job, setJob] = React.useState<AdsGeneratorJob | null>(null);
  const [failure, setFailure] = React.useState<AdsGeneratorFailure | null>(null);
  const [starting, setStarting] = React.useState(false);

  const settle = React.useCallback((next: AdsGeneratorJob) => {
    setJob(next);
    if (next.status === 'running') return;
    rememberJob(null);
    if (next.status === 'failed') setFailure(jobFailure(next));
  }, []);

  // Reconnect to a job this tab started before a reload.
  React.useEffect(() => {
    const id = rememberedJob();
    if (!id) return;
    let active = true;
    api.job(id)
      .then((value) => { if (active) settle(value); })
      .catch(() => { if (active) rememberJob(null); });
    return () => { active = false; };
  }, [api, settle]);

  const running = job?.status === 'running';
  React.useEffect(() => {
    if (!running || !job) return;
    let active = true;
    const timer = setTimeout(() => {
      api.job(job.id)
        .then((value) => { if (active) settle(value); })
        .catch((error) => {
          if (!active) return;
          rememberJob(null);
          setJob(null);
          setFailure(adsGeneratorError(error));
        });
    }, ADS_LLM_LIMITS.jobPollMs);
    return () => { active = false; clearTimeout(timer); };
  }, [api, job, running, settle]);

  const start = React.useCallback(async (form: AdsGeneratorFormInput) => {
    setStarting(true); setFailure(null); setJob(null);
    try {
      const started = await api.generate(form);
      if (started.status === 'running') rememberJob(started.id);
      settle(started);
    } catch (error) {
      setFailure(adsGeneratorError(error));
    } finally {
      setStarting(false);
    }
  }, [api, settle]);

  return {
    job,
    failure,
    busy: starting || running,
    result: job?.status === 'succeeded' ? job.result ?? null : null,
    start,
  };
}
