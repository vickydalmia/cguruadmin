import { createHash } from 'node:crypto';
import { ADS_LLM_LIMITS, ADS_PROMPT_VERSION, type AdsGeneratorResult } from '../constants/ads-generator';
import type { AdsForm } from './form';

/**
 * Short-lived in-memory cache so a double-click or an identical resubmit
 * returns the previous result instead of paying for a new call.
 */

type Entry = { expiresAt: number; result: Omit<AdsGeneratorResult, 'cached'> };

export class ResultCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number = ADS_LLM_LIMITS.resultCacheMs,
    private readonly now: () => number = Date.now,
  ) {}

  static key(form: AdsForm, model: string): string {
    return createHash('sha256').update(JSON.stringify({ form, model, version: ADS_PROMPT_VERSION })).digest('hex');
  }

  get(key: string): Omit<AdsGeneratorResult, 'cached'> | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.result;
  }

  set(key: string, result: Omit<AdsGeneratorResult, 'cached'>): void {
    const now = this.now();
    for (const [existing, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(existing);
    }
    this.entries.set(key, { expiresAt: now + this.ttlMs, result });
  }
}
