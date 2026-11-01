import { describe, expect, it, vi } from 'vitest';
import { evergreenForm, evergreenOutput, parsedForm, validOutput } from './__fixtures__/ads-fixtures';
import { AdsGenerationError, generateAds } from './generate-ads';
import type { CreativeModelCall } from './openai-client';
import type { AdsModelOutput } from './prompt/output-schema';
import { EVERGREEN_SYSTEM_PROMPT } from './prompt/evergreen-prompts';
import { OFFER_SYSTEM_PROMPT } from './prompt/offer-prompts';

function model(...outputs: AdsModelOutput[]) {
  const call = vi.fn<CreativeModelCall>();
  for (const output of outputs) {
    call.mockResolvedValueOnce({ output, inputTokens: 100, outputTokens: 50, model: 'test-model' });
  }
  return call;
}

/** Mechanically valid, but every headline repeats the brand. */
function brandStuffedOutput(): AdsModelOutput {
  const output = validOutput();
  const brandLines = [
    'Myntra Coupons & Discounts', 'Myntra Flat 40% Off On Shoes', 'Myntra Extra 10% Off STYLE10',
    'Myntra Shoe Savings For You', 'Myntra Styles For Less Money', 'Myntra Sneakers And Sandals',
    'Myntra Shoe Offers Together', 'Myntra Code For Checkout', 'Myntra Orders From 999 Count',
    'Myntra Footwear Savings Now',
  ];
  output.ads.forEach((ad) => { ad.headlines = [...brandLines]; });
  return output;
}

function badOutput(): AdsModelOutput {
  const output = validOutput();
  output.ads[0].headlines[2] = 'Too Short Headline';
  return output;
}

describe('generateAds', () => {
  it('returns ads, keywords and a CSV after one valid call', async () => {
    const call = model(validOutput());
    const result = await generateAds(parsedForm(), call);

    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0].system).toBe(OFFER_SYSTEM_PROMPT);
    expect(call.mock.calls[0][0].prompt).toContain('Brand name: Myntra');
    expect(result.usage).toEqual({ calls: 1, inputTokens: 100, outputTokens: 50 });
    expect(result.keywords).toHaveLength(10);
    expect(result.csv).toMatchObject({ filename: 'google-ads-test-myntra.csv', rows: 14 });
    expect(result.manualSteps.length).toBeGreaterThanOrEqual(2);
  });

  it('sends validator problems back in a repair call', async () => {
    const call = model(badOutput(), validOutput());
    const result = await generateAds(parsedForm(), call);

    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][0].prompt).toContain('- Ad 1 headline 3 is 18 characters');
    expect(result.usage.calls).toBe(2);
  });

  it('stops after the repair budget and produces no CSV', async () => {
    const call = model(badOutput(), badOutput(), badOutput(), validOutput());
    await expect(generateAds(parsedForm(), call)).rejects.toMatchObject({
      status: 422,
      problems: [expect.stringContaining('Ad 1 headline 3')],
    });
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('does not repair when the model reports insufficient evidence', async () => {
    const call = model(validOutput({ status: 'insufficient_evidence', reason: 'Offers are for Nike', ads: [] }));
    await expect(generateAds(parsedForm(), call)).rejects.toBeInstanceOf(AdsGenerationError);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('warns that offer copy goes stale and that shared lists must exist', async () => {
    const result = await generateAds(parsedForm(), model(validOutput()));
    expect(result.warnings).toEqual([
      expect.stringContaining('regenerate or pause these ads when the offer changes'),
      expect.stringContaining('Item not found'),
    ]);
  });

  it('uses the evergreen prompts and categories for an evergreen form', async () => {
    const call = model(evergreenOutput());
    const result = await generateAds(evergreenForm(), call);

    expect(call.mock.calls[0][0].system).toBe(EVERGREEN_SYSTEM_PROMPT);
    expect(call.mock.calls[0][0].prompt).toContain('Fashion, shoes, ethnic wear, beauty');
    expect(result).toMatchObject({ adType: 'evergreen', csv: { rows: 14 } });
    expect(result.warnings).toEqual([expect.stringContaining('Item not found')]);
  });

  it('repairs evergreen copy that names a number or a date', async () => {
    const dated = evergreenOutput();
    dated.ads[0].headlines[1] = 'Up To 40% Off Shoes Today';
    const call = model(dated, evergreenOutput());
    await generateAds(evergreenForm(), call);

    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][0].prompt).toContain('evergreen ads must not contain numbers');
    expect(call.mock.calls[1][0].prompt).toContain('Revise the previous JSON using the original evergreen ad brief');
  });

  it('repairs editorial issues and accepts the repaired copy', async () => {
    const call = model(brandStuffedOutput(), validOutput());
    const result = await generateAds(parsedForm(), call);

    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][0].prompt).toContain('uses "Myntra" in 10 headlines');
    expect(result.warnings.filter((warning) => warning.startsWith('Copy review:'))).toEqual([]);
  });

  it('still returns the CSV when editorial issues survive the repair budget', async () => {
    const call = model(brandStuffedOutput(), brandStuffedOutput(), brandStuffedOutput());
    const result = await generateAds(parsedForm(), call);

    expect(call).toHaveBeenCalledTimes(3);
    expect(result.csv.rows).toBe(14);
    expect(result.warnings).toContainEqual(expect.stringMatching(/^Copy review: Ad 1 uses "Myntra" in 10 headlines/));
  });

  it('keeps a valid answer when a later repair breaks a mechanical rule', async () => {
    const call = model(brandStuffedOutput(), badOutput(), badOutput());
    const result = await generateAds(parsedForm(), call);
    expect(result.ads[0].headlines[2]).toBe('Myntra Extra 10% Off STYLE10');
    expect(result.warnings).toContainEqual(expect.stringContaining('Copy review:'));
  });

  it('sends debug lines for each prompt, response and problem list', async () => {
    const debug = vi.fn();
    await generateAds(parsedForm(), model(badOutput(), validOutput()), debug);
    const lines = debug.mock.calls.map(([line]) => line as string);
    expect(lines.filter((line) => line.includes('prompt:'))).toHaveLength(2);
    expect(lines.filter((line) => line.includes('response:'))).toHaveLength(2);
    expect(lines.filter((line) => line.includes('problems:'))).toHaveLength(1);
  });
});
