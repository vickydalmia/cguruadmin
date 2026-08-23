import { describe, expect, it } from 'vitest';
import { COMPONENT_FIELD_DESCRIPTIONS } from '../../bootstrap/field-hints';
import sliderSlideSchema from './slider-slide.json';

describe('homepage slider link schema', () => {
  const link = sliderSlideSchema.attributes.link;
  const linkPattern = new RegExp(link.regex);

  it('keeps the banner destination optional and bounded', () => {
    expect(link).toMatchObject({
      type: 'string',
      maxLength: 500,
    });
    expect(link).not.toHaveProperty('required');
  });

  it.each([
    '/',
    '/stores/amazon/',
    '/search/?q=summer#offers',
    'https://merchant.example/sale',
    'http://merchant.example:8080/offers?type=deal#featured',
  ])('accepts safe banner destination %s', (url) => {
    expect(linkPattern.test(url)).toBe(true);
  });

  it.each([
    '',
    'stores/amazon',
    '//merchant.example/sale',
    '/\\merchant.example/sale',
    'javascript:alert(1)',
    'data:text/html,unsafe',
    'mailto:help@example.com',
    '/search path',
  ])('rejects unsafe or malformed banner destination %s', (url) => {
    expect(linkPattern.test(url)).toBe(false);
  });

  it('explains internal, external, and empty-link behaviour to editors', () => {
    const description =
      COMPONENT_FIELD_DESCRIPTIONS['homepage.slider-slide']?.link;

    expect(description).toContain('/path/');
    expect(description).toContain('external links open in a new tab');
    expect(description).toContain('nofollow');
    expect(description).toContain('Leave empty');
  });
});
