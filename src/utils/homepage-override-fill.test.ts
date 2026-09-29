import { describe, expect, it } from 'vitest';

import { toPlainLabel } from './homepage-override-fill';

describe('toPlainLabel', () => {
  it('reduces a rich-text bank short description to a one-line subtitle', () => {
    expect(toPlainLabel('<p>Up to <strong>10%</strong> cashback&nbsp;on cards.</p><p>&nbsp;</p>')).toBe(
      'Up to 10% cashback on cards.',
    );
  });

  it('keeps plain titles as they are, trimmed', () => {
    expect(toPlainLabel('  Amazon Great Indian Sale  ')).toBe('Amazon Great Indian Sale');
  });

  it('returns null for blank or non-string values', () => {
    expect(toPlainLabel('<p></p>')).toBeNull();
    expect(toPlainLabel('   ')).toBeNull();
    expect(toPlainLabel(null)).toBeNull();
    expect(toPlainLabel(undefined)).toBeNull();
  });
});
