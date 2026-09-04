import { describe, expect, it } from 'vitest';
import {
  formatUsd,
  queueBusy,
  queueSummary,
  shortUid,
  unwrapBackfillEstimate,
  unwrapBackfillResult,
  unwrapOutboxStatus,
} from './backfill-api';

describe('translation backfill client helpers', () => {
  it('unwraps the status envelope and summarises the queue', () => {
    const status = unwrapOutboxStatus({
      data: {
        enabled: true,
        ok: true,
        dispatcher: { running: true, stopped: false, lastError: null },
        outbox: {
          counts: { pending: 12, processing: 2, failed: 3, delivered: 900 },
          deliveredToday: 40,
          costTodayUsd: 1.234,
          estimatedCostTodayUsd: 1.5,
          dailyBudgetUsd: 25,
        },
      },
    });
    const summary = queueSummary(status);
    expect(summary).toEqual({
      pending: 12,
      processing: 2,
      blocked: 0,
      failed: 3,
      delivered: 900,
      deliveredToday: 40,
      costTodayUsd: 1.234,
      dailyBudgetUsd: 25,
    });
    expect(queueBusy(summary)).toBe(true);
  });

  it('treats an inactive runtime as an empty, idle queue', () => {
    const status = unwrapOutboxStatus({ ok: true, enabled: false, dispatcher: null, outbox: null });
    const summary = queueSummary(status);
    expect(summary.pending).toBe(0);
    expect(summary.dailyBudgetUsd).toBeNull();
    expect(queueBusy(summary)).toBe(false);
  });

  it('rejects malformed envelopes', () => {
    expect(() => unwrapOutboxStatus({ data: { nope: true } })).toThrow(/unexpected/);
    expect(() => unwrapBackfillEstimate({ data: {} })).toThrow(/unexpected/);
    expect(() => unwrapBackfillResult({})).toThrow(/unexpected/);
  });

  it('unwraps estimate and result payloads', () => {
    expect(
      unwrapBackfillEstimate({
        data: { entries: 3, translatableChars: 10, estimatedCalls: 6, estimatedInputTokens: 1, estimatedOutputTokens: 1, estimatedUsd: 0.5, perUid: { 'api::coupon.coupon': 3 }, locales: ['ar'] },
      }).estimatedUsd,
    ).toBe(0.5);
    expect(
      unwrapBackfillResult({ data: { enqueued: 9, perUid: {}, locales: ['ar'] } }).enqueued,
    ).toBe(9);
  });

  it('formats money and uids for the card', () => {
    expect(formatUsd(0.5)).toBe('$0.50');
    expect(formatUsd(123.4)).toBe('$123');
    expect(formatUsd(Number.NaN)).toBe('$0.00');
    expect(shortUid('api::coupon.coupon')).toBe('coupon');
    expect(shortUid('plugin::ui-dictionary')).toBe('plugin::ui-dictionary');
  });
});
