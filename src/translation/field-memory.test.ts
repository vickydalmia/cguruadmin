import { describe, expect, it } from 'vitest';
import { fieldFingerprints, selectTranslationFields } from './field-memory';
import type { TranslatableLeaf } from './field-map';

const leaf = (path: string, text: string, maxLength = 80) => ({ path, value: text, kind: 'plain', maxLength }) as TranslatableLeaf;
describe('field translation memory', () => {
  it('pays only for edited leaves and drops removed fields', () => {
    const before = [leaf('title', 'Sale'), leaf('body', 'Terms'), leaf('old', 'Removed')];
    const after = [leaf('title', 'New sale'), leaf('body', 'Terms')];
    const result = selectTranslationFields(after, fieldFingerprints(after, 'p1'), fieldFingerprints(before, 'p1'),
      { title: 'عنوان', body: 'الشروط', old: 'قديم' }, false);
    expect(result.changed.map((item) => item.path)).toEqual(['title']);
    expect(Object.fromEntries(result.reused)).toEqual({ body: 'الشروط' });
  });
  it('invalidates on prompt, constraints, missing memory, force, and component reorder', () => {
    const before = [leaf('blocks.0.title', 'Sale')];
    const hashes = fieldFingerprints(before, 'p1');
    const memory = { 'blocks.0.title': 'عنوان' };
    for (const [after, prompt, stored, force] of [
      [before, 'p2', memory, false],
      [[leaf('blocks.0.title', 'Sale', 20)], 'p1', memory, false],
      [[leaf('blocks.1.title', 'Sale')], 'p1', memory, false],
      [before, 'p1', {}, false],
      [before, 'p1', memory, true],
    ] as const) {
      expect(selectTranslationFields(after, fieldFingerprints(after, prompt), hashes, stored, force).changed).toHaveLength(1);
    }
  });
});
