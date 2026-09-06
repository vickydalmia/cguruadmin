import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
const { TABLES } = require('../../database/migrations/2026.09.08T00.00.00.preserve-legacy-english-content.js');
it('covers every localized content table in the release schema', () => {
  const root = join(process.cwd(), 'src/api');
  const localized = readdirSync(root).flatMap((name) => {
    try {
      const schema = JSON.parse(readFileSync(join(root, name, 'content-types', name, 'schema.json'), 'utf8'));
      return schema.pluginOptions?.i18n?.localized ? [schema.collectionName] : [];
    } catch { return []; }
  });
  expect([...TABLES].sort()).toEqual(localized.sort());
  expect(TABLES).toHaveLength(24);
});
