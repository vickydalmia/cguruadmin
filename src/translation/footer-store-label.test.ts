import { describe, expect, it } from 'vitest';
import { collectTranslatableLeaves } from './field-map';
import { validateTranslatedBatch } from './validate';
import { translationPopulate } from './populate';

const models: Record<string, any> = {
  'api::footer.footer': require('../api/footer/content-types/footer/schema.json'),
  'footer.link-section': require('../components/footer/link-section.json'),
  'nav.link': require('../components/nav/link.json'),
};
const strapi = { getModel: (uid: string) => models[uid] ?? { attributes: {} } } as any;
const store = { documentId: 'level-shoes', name: 'Level Shoes' };

describe('footer linked store names', () => {
  it('allows an exact official name but still translates navigation and promotional prose', () => {
    const entry = { sections: [{ links: [
      { label: 'Level Shoes', store },
      { label: 'View All Stores', store },
      { label: 'Level Shoes Sale', store },
      { label: 'Level Shoes', url: '/level-shoes-coupons/' },
    ] }] };
    const leaves = collectTranslatableLeaves(strapi, 'api::footer.footer', entry);
    const unchanged = Object.fromEntries(leaves.map((leaf) => [leaf.path, leaf.value]));
    const failures = validateTranslatedBatch(leaves, unchanged, /\p{Script=Arabic}/u);
    expect(failures.map((failure) => failure.path)).toEqual([
      'sections.0.links.1.label', 'sections.0.links.2.label', 'sections.0.links.3.label',
    ]);
    expect(leaves[0].linkedEntityName).toBe('Level Shoes');
    expect(leaves.slice(1).every((leaf) => !leaf.linkedEntityName)).toBe(true);
    expect(validateTranslatedBatch([leaves[0]], {
      [leaves[0].path]: 'Different Store',
    }, /\p{Script=Arabic}/u)).toEqual([
      expect.objectContaining({ problems: ['target-language-missing'] }),
    ]);
  });

  it('does not accept footer identity metadata on homepage titles', () => {
    expect(validateTranslatedBatch([{
      path: 'hero.products.0.titleOverride', kind: 'plain',
      value: 'Level Shoes', linkedEntityName: 'Level Shoes',
    }], { 'hero.products.0.titleOverride': 'Level Shoes' }, /\p{Script=Arabic}/u))
      .toHaveLength(1);
  });

  it('populates linked stores shallowly, making their names available to the walker', () => {
    const populate = translationPopulate(strapi, 'api::footer.footer') as any;
    expect(populate.sections.populate.links.populate.store).toBe(true);
  });
});
