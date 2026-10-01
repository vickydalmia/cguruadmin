import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { parsePatchFile } = require('patch-package/dist/patch/parse');
const patchesDirectory = resolve('patches');

// A malformed patch aborts yarn install before any other CI check can run.
// Use the installer's parser: git/patch accept some whitespace it rejects.
describe('dependency patch format', () => {
  for (const name of readdirSync(patchesDirectory).filter(name => name.endsWith('.patch'))) {
    it(`${name} is accepted by patch-package`, () => {
      const source = readFileSync(resolve(patchesDirectory, name), 'utf8');
      expect(parsePatchFile(source).length).toBeGreaterThan(0);
    });
  }
});
