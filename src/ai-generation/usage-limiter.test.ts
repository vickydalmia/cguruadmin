import { describe, expect, it } from 'vitest';
import { UsageLimiter } from './usage-limiter';

function limiter(limits = { maxRequestsPerUserPerHour: 2, maxRequestsPerDay: 3 }) {
  let now = Date.parse('2026-10-29T10:00:00Z');
  const instance = new UsageLimiter(limits, () => now);
  return { instance, advance: (ms: number) => { now += ms; } };
}

describe('UsageLimiter', () => {
  it('allows one in-flight request per user', () => {
    const { instance } = limiter();
    expect(instance.acquire('1')).toEqual({ ok: true });
    expect(instance.acquire('1')).toMatchObject({ ok: false });
    expect(instance.acquire('2')).toEqual({ ok: true });
    instance.release('1');
    expect(instance.acquire('1')).toEqual({ ok: true });
  });

  it('caps requests per user per rolling hour', () => {
    const { instance, advance } = limiter();
    for (let i = 0; i < 2; i += 1) { expect(instance.acquire('1').ok).toBe(true); instance.release('1'); }
    expect(instance.acquire('1')).toMatchObject({ ok: false, message: expect.stringContaining('per hour') });
    advance(60 * 60_000);
    expect(instance.acquire('1').ok).toBe(true);
  });

  it('caps requests per UTC day across users and resets at midnight', () => {
    const { instance, advance } = limiter({ maxRequestsPerUserPerHour: 10, maxRequestsPerDay: 2 });
    expect(instance.acquire('1').ok).toBe(true);
    expect(instance.acquire('2').ok).toBe(true);
    expect(instance.acquire('3')).toMatchObject({ ok: false, message: expect.stringContaining('daily') });
    advance(14 * 60 * 60_000);
    expect(instance.acquire('3').ok).toBe(true);
  });
});
