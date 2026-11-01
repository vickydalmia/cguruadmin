import { describe, expect, it } from 'vitest';
import { evergreenForm, parsedForm } from '../__fixtures__/ads-fixtures';
import { EVERGREEN_SYSTEM_PROMPT } from './evergreen-prompts';
import { OFFER_SYSTEM_PROMPT } from './offer-prompts';
import { renderBrief, renderRepair, renderTemplate, systemPromptFor } from './render-prompts';

describe('render prompts', () => {
  it('picks the system prompt by ad type', () => {
    expect(systemPromptFor('offer')).toBe(OFFER_SYSTEM_PROMPT);
    expect(systemPromptFor('evergreen')).toBe(EVERGREEN_SYSTEM_PROMPT);
  });

  it('fills the offer brief from the form', () => {
    const brief = renderBrief(parsedForm());
    expect(brief).toContain('Brand name: Myntra');
    expect(brief).toContain('Target countries: India, United Arab Emirates, United States');
    expect(brief).toContain('Flat 40% off on shoes.');
    expect(brief).toContain('TRUST SIGNALS (approved; optional, use where natural)');
    expect(brief).toContain('Terms: Today, Live Now, Working, Manually Verified');
    expect(brief).not.toMatch(/\{\{|\}\}/);
  });

  it('fills the evergreen brief with categories and the trust signals', () => {
    const brief = renderBrief(evergreenForm());
    expect(brief).toContain('EVERGREEN AD BRIEF');
    expect(brief).toContain('Fashion, shoes, ethnic wear, beauty');
    expect(brief).toContain('Terms: Today, Live Now, Working, Manually Verified');
    expect(brief).toContain('- CouponzGuru coupons and codes are manually verified by our team.');
    expect(brief).not.toContain('OFFER_DETAILS');
    expect(brief).not.toMatch(/\{\{|\}\}/);
  });

  it('uses the repair template of the ad type', () => {
    expect(renderRepair('offer', ['Ad 1 headline 2 is 31 characters'], { ads: [] }))
      .toContain('Revise the previous JSON using the original ad brief');
    const evergreen = renderRepair('evergreen', ['Ad 1 headline 2 uses 40'], { ads: [] });
    expect(evergreen).toContain('original evergreen ad brief');
    expect(evergreen).toContain('- Ad 1 headline 2 uses 40');
    expect(evergreen).toContain('"ads": []');
  });

  it('throws on a missing or unused placeholder value', () => {
    expect(() => renderTemplate('Hi {{name}}', {})).toThrow('{{name}} has no value');
    expect(() => renderTemplate('Hi', { name: 'x' })).toThrow('not used by the template: name');
  });
});
