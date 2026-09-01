import { describe, expect, it } from 'vitest';

import { FEATURE_FORM_DEFINITIONS } from './types';

describe('Country Setup feature form definitions', () => {
  it('contains only switch-owned features', () => {
    expect(FEATURE_FORM_DEFINITIONS).toHaveLength(16);
    expect(FEATURE_FORM_DEFINITIONS.map(({ key }) => key)).not.toContain(
      'dealOfTheDay',
    );
    expect(FEATURE_FORM_DEFINITIONS.map(({ key }) => key)).not.toContain(
      'independenceDaySale',
    );
  });
});
