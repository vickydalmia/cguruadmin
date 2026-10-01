import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mergeConfig, type UserConfig } from 'vite';

export default (config: UserConfig) => {
  // Vite hashes dependency versions, but patch-package changes code without
  // changing versions. A patched save handler must get a fresh dependency cache.
  const patchRevision = createHash('sha256')
    .update(readFileSync(resolve(process.cwd(), 'patches/@strapi+content-manager+5.50.0.patch')))
    .digest('hex').slice(0, 12);
  return mergeConfig(config, {
    cacheDir: `${config.cacheDir ?? 'node_modules/.strapi/vite'}-${patchRevision}`,
  });
};
