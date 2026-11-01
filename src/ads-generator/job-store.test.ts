import { describe, expect, it } from 'vitest';
import { AdsJobStore } from './job-store';

function store() {
  let now = Date.parse('2026-11-01T10:00:00Z');
  let next = 0;
  const jobs = new AdsJobStore(30 * 60_000, () => now, () => `job-${(next += 1)}`);
  return { jobs, advance: (ms: number) => { now += ms; } };
}

const RESULT = { cached: false } as any;

describe('AdsJobStore', () => {
  it('tracks a running job, its progress and its result', () => {
    const { jobs } = store();
    const job = jobs.start('1');
    expect(job).toEqual({ id: 'job-1', status: 'running', attempt: 0, maxAttempts: 3, startedAt: '2026-11-01T10:00:00.000Z' });
    expect(jobs.runningFor('1')?.id).toBe('job-1');

    jobs.progress('job-1', 2);
    jobs.succeed('job-1', RESULT);
    expect(jobs.get('job-1', '1')).toMatchObject({ status: 'succeeded', attempt: 2, result: RESULT });
    expect(jobs.runningFor('1')).toBeNull();
  });

  it('never exposes the owner and hides jobs from other admins', () => {
    const { jobs } = store();
    jobs.start('1');
    expect(jobs.get('job-1', '1')).not.toHaveProperty('userId');
    expect(jobs.get('job-1', '2')).toBeNull();
    expect(jobs.runningFor('2')).toBeNull();
  });

  it('ignores updates after a job has finished', () => {
    const { jobs } = store();
    jobs.start('1');
    jobs.fail('job-1', { message: 'boom', problems: [] });
    jobs.succeed('job-1', RESULT);
    jobs.progress('job-1', 3);
    expect(jobs.get('job-1', '1')).toMatchObject({ status: 'failed', attempt: 0, error: { message: 'boom' } });
  });

  it('records a cache hit as an already finished job', () => {
    const { jobs } = store();
    expect(jobs.finished('1', RESULT)).toMatchObject({ status: 'succeeded', result: RESULT });
  });

  it('drops finished jobs after the retention window, never running ones', () => {
    const { jobs, advance } = store();
    jobs.start('1');
    jobs.succeed('job-1', RESULT);
    jobs.start('2');
    advance(30 * 60_000);
    expect(jobs.get('job-1', '1')).toBeNull();
    expect(jobs.get('job-2', '2')?.status).toBe('running');
  });
});
