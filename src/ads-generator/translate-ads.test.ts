import { describe, expect, it, vi } from 'vitest';
import type { GeneratedAd } from '../constants/ads-generator';
import { formInput, parsedForm, validOutput } from './__fixtures__/ads-fixtures';
import { createAdsGeneratorService } from './ads-generator-service';
import { numbersIn, withoutBrand } from './copy-text';
import { generateAds } from './generate-ads';
import { JobStore } from '../ai-generation/job-store';
import type { CreativeModelCall } from './openai-client';
import { ARABIC_FIDELITY_PROMPT, ARABIC_SYSTEM_PROMPT } from './prompt/arabic-prompts';
import { ResultCache } from './result-cache';
import { translateAds } from './translate-ads';
import { UsageLimiter } from '../ai-generation/usage-limiter';
import { validateArabic } from './validate-arabic';

const BRAND = 'Myntra';
const line = (source: string, index: number) => {
  const brand = source.toLowerCase().includes('myntra') ? `${BRAND} ` : '';
  const site = source.toLowerCase().includes('couponzguru') ? 'CouponzGuru ' : '';
  const codes = (withoutBrand(source, BRAND).match(/\b(?=[A-Z0-9]*[A-Z])[A-Z0-9]{3,}\b/g) ?? []).join(' ');
  const numbers = numbersIn(withoutBrand(source, BRAND).replace(/\b(?=[A-Z0-9]*[A-Z])[A-Z0-9]{3,}\b/g, ' ')).join(' ');
  return `${brand}${site}خصم${'ب'.repeat(index + 1)} ${numbers} ${codes}`.replace(/\s+/g, ' ').trim();
};
const translated = (ads: GeneratedAd[]): GeneratedAd[] => ads.map((ad) => ({
  headlines: ad.headlines.map(line),
  descriptions: ad.descriptions.map(line),
}));
const english = validOutput().ads;
const model = (ads: GeneratedAd[]) => ({ output: validOutput({ ads }), inputTokens: 1, outputTokens: 1, model: 'test-model' });

describe('validateArabic', () => {
  it('accepts a faithful translation', () => {
    expect(validateArabic(english, translated(english), parsedForm())).toEqual([]);
  });

  it('blocks changed numbers, Arabic digits, a lost brand, English copy and banned claims', () => {
    const edit = (index: number, text: string) => {
      const ads = translated(english);
      ads[0].headlines[index] = text;
      return validateArabic(english, ads, parsedForm()).join(' ');
    };
    expect(edit(0, 'كوبون')).toContain('brand');
    expect(edit(1, 'Plain English')).toContain('not in Arabic');
    expect(edit(1, 'خصم ٤٠')).toContain('Western digits');
    expect(edit(1, 'Myntra خصم 99')).toContain('exactly the numbers');
    expect(edit(1, 'أفضل سعر Myntra')).toContain('banned phrase');
    expect(edit(1, `${'ب'.repeat(31)}`)).toContain('characters');
  });
});

describe('validateArabic adversarial copy', () => {
  const evergreen = parsedForm({ adType: 'evergreen', offerDetails: '', brandCategories: ['Shoes'] });
  const check = (source: string, text: string, form = parsedForm()) => validateArabic(
    [{ headlines: [source], descriptions: [] }], [{ headlines: [text], descriptions: [] }], form,
  ).join(' ');

  it.each([
    ['Myntra كوبونات بأفضل الأسعار', 'banned'],
    ['Myntra كوبونات بأقل الأسعار', 'banned'],
    ['Myntra نضمن لك التوفير', 'banned'],
    ['Myntra لا تفوت العرض', 'banned'],
    ['Myntra كوبونات وتوصيل مجاني', 'adds the claim'],
    ['Myntra خصم خمسين بالمئة', 'spells out'],
  ])('blocks %s', (text, reason) => {
    expect(check('Myntra Shoe Coupons', text)).toContain(reason);
  });

  it('blocks invented events on evergreen ads without matching inside other words', () => {
    expect(check('Myntra Shoe Coupons', 'Myntra كوبونات رمضان', evergreen)).toContain('goes stale');
    expect(check('Myntra Shoe Coupons', 'Myntra عروض الجمعة البيضاء', evergreen)).toContain('goes stale');
    expect(check('Myntra Shoe Coupons', 'Myntra كوبونات سعيدة', evergreen)).toBe('');
  });

  it('protects any-case codes and lets acronyms be translated', () => {
    expect(check('Use Code Save20 On Myntra', 'Myntra استخدم وفر20')).toContain('Save20');
    const named = parsedForm({ offerDetails: 'Code: style for extra savings' });
    expect(check('Use code style at Myntra', 'Myntra استخدم الكود', named)).toContain('style');
    expect(check('Use code style at Myntra', 'Myntra استخدم الكود style', named)).toBe('');
    expect(check('Myntra Deals In USA', 'Myntra عروض في أمريكا')).toBe('');
  });
});

describe('translateAds', () => {
  it('repairs a translation the fidelity check rejects, and refuses one it keeps rejecting', async () => {
    const form = parsedForm();
    const source = await generateAds(form, async () => model(english));
    const unfaithful = { output: validOutput({ status: 'insufficient_evidence', reason: 'changed', ads: [], warnings: ['Ad 1 headline 2 adds a claim'] }), inputTokens: 1, outputTokens: 1, model: 'test-model' };
    const repaired = vi.fn<CreativeModelCall>(async ({ system, prompt }) => {
      if (system !== ARABIC_FIDELITY_PROMPT) return model(translated(english));
      return repaired.mock.calls.filter(([request]) => request.system === ARABIC_FIDELITY_PROMPT).length === 1 ? unfaithful : model([]);
    });
    await expect(translateAds(form, source, repaired)).resolves.toMatchObject({ usage: { calls: 4 } });
    expect(repaired.mock.calls[2][0].prompt).toContain('adds a claim');
    await expect(translateAds(form, source, async ({ system }) => (system === ARABIC_FIDELITY_PROMPT ? unfaithful : model(translated(english)))))
      .rejects.toThrow('No Arabic CSV');
  });

  it('translates validated English into a separate CSV with the same settings', async () => {
    const form = parsedForm();
    const source = await generateAds(form, async () => model(english));
    const arabic = await translateAds(form, source, async () => model(translated(english)));
    expect(arabic.csv.filename).toBe('google-ads-test-myntra-ar.csv');
    expect(arabic.csv.rows).toBe(source.csv.rows);
    expect(arabic.csv.content).toContain(arabic.ads[0].headlines[0]);
    expect(arabic.csv.content).not.toContain(english[0].headlines[0]);
    expect(arabic.csv.content.charCodeAt(0)).toBe(0xfeff);
  });

  it('repairs a bad translation and refuses one that stays bad', async () => {
    const form = parsedForm();
    const source = await generateAds(form, async () => model(english));
    const repaired = vi.fn<CreativeModelCall>()
      .mockResolvedValueOnce(model(english))
      .mockResolvedValueOnce(model(translated(english)))
      .mockResolvedValueOnce(model([]));
    await expect(translateAds(form, source, repaired)).resolves.toMatchObject({ usage: { calls: 3 } });
    await expect(translateAds(form, source, async () => model(english))).rejects.toThrow('No Arabic CSV');
  });
});

describe('Arabic batches', () => {
  function setup(perHour = 30) {
    let failTranslation = true;
    const call = vi.fn<CreativeModelCall>(async ({ system }) => {
      if (system !== ARABIC_SYSTEM_PROMPT) return model(english);
      if (failTranslation) return model(english);
      return model(translated(english));
    });
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = createAdsGeneratorService({
      config: { apiKey: 'x', model: 'test-model', reasoningEffort: 'low', maxOutputTokens: 16000, timeoutMs: 180000 },
      createModel: () => call,
      limiter: new UsageLimiter({ maxRequestsPerUserPerHour: perHour, maxRequestsPerDay: 100 }),
      cache: new ResultCache(),
      jobs: new JobStore({ retentionMs: 60_000, maxAttempts: 3 }),
      log,
    } as any);
    return { service, call, fix: () => { failTranslation = false; } };
  }
  const finish = async (service: ReturnType<typeof setup>['service'], response: any) => {
    for (let i = 0; i < 100; i += 1) {
      const job: any = service.job(response.body.id, '1').body;
      if (job.status !== 'running') return job;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error('job did not finish');
  };

  it('writes English first and a failed translation retries without paying for English again', async () => {
    const { service, call, fix } = setup();
    const first = await finish(service, service.generate({ campaigns: [formInput()], language: 'ar' }, '1'));
    expect(first.result.campaigns[0]).toMatchObject({ status: 'failed' });
    expect(call.mock.calls[0][0].system).not.toBe(ARABIC_SYSTEM_PROMPT);
    const englishCalls = () => call.mock.calls.filter(([request]) => request.system !== ARABIC_SYSTEM_PROMPT && request.system !== ARABIC_FIDELITY_PROMPT).length;
    expect(englishCalls()).toBe(1);
    fix();
    const retried = await finish(service, service.generate({ retryJobId: first.id, replacements: [{ index: 0, form: formInput() }] }, '1'));
    expect(retried.result.campaigns[0]).toMatchObject({ status: 'succeeded', result: { arabic: { csv: { filename: 'google-ads-test-myntra-ar.csv' } } } });
    expect(englishCalls()).toBe(1);
  });

  it('counts an Arabic campaign as one generation', () => {
    expect(setup(1).service.generate({ campaigns: [formInput()], language: 'ar' }, '1').status).toBe(202);
    const { service, call } = setup(1);
    expect(service.generate({ campaigns: [formInput(), formInput({ campaignName: 'Second' })], language: 'ar' }, '1').status).toBe(429);
    expect(call).not.toHaveBeenCalled();
    expect(setup().service.generate({ campaigns: [formInput()], language: 'fr' }, '1').status).toBe(400);
  });
});
