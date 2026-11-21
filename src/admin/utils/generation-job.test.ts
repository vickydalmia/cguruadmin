import { afterEach, describe, expect, it, vi } from 'vitest';
import { generationFailure, jobFailure, rememberJob, rememberedJob } from './generation-job';

describe('generation job helpers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the server error and its problems', () => {
    expect(generationFailure({ response: { status: 400, data: { error: 'Fix the form.', problems: ['Label is required.'] } } }, 'nope'))
      .toEqual({ message: 'Fix the form.', problems: ['Label is required.'], forbidden: false });
  });

  it('explains a 403 with the feature permission', () => {
    expect(generationFailure({ response: { status: 403, data: { error: { message: 'Policy Failed' } } } }, 'Needs the grant.'))
      .toEqual({ message: 'Needs the grant.', problems: [], forbidden: true });
  });

  it('turns a failed job into the notice the page shows', () => {
    const job = { id: 'j', status: 'failed', attempt: 3, maxAttempts: 3, startedAt: '', error: { message: 'Still invalid.', problems: ['H1 too long'] } } as const;
    expect(jobFailure(job)).toEqual({ message: 'Still invalid.', problems: ['H1 too long'], forbidden: false });
    expect(jobFailure({ ...job, error: undefined }).message).toBe('Generation failed. Try again.');
  });

  it('remembers the running job per key and survives blocked storage', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', { sessionStorage: {
      setItem: (k: string, v: string) => store.set(k, v), getItem: (k: string) => store.get(k) ?? null, removeItem: (k: string) => store.delete(k),
    } });
    rememberJob('a', 'job-1');
    expect(rememberedJob('a')).toBe('job-1');
    expect(rememberedJob('b')).toBeNull();
    rememberJob('a', null);
    expect(rememberedJob('a')).toBeNull();

    vi.stubGlobal('window', { get sessionStorage(): Storage { throw new Error('blocked'); } });
    expect(() => rememberJob('a', 'x')).not.toThrow();
    expect(rememberedJob('a')).toBeNull();
  });
});
