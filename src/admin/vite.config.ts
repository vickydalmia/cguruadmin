import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mergeConfig, type UserConfig } from 'vite';

export default (config: UserConfig) => {
  // Vite hashes dependency versions, but patch-package changes code without
  // changing versions. A patched save handler must get a fresh dependency cache.
  const patchRevision = createHash('sha256')
    .update(readFileSync(resolve(process.cwd(), 'patches/@strapi+content-manager+5.50.0.patch')))
    .update(readFileSync(resolve(process.cwd(), 'patches/@strapi+upload+5.50.0.patch')))
    .digest('hex').slice(0, 12);
  return mergeConfig(config, {
    resolve: { alias: { '@cguru/festival-slide-title': resolve(process.cwd(), 'src/admin/features/festival/use-slide-title.ts'), '@cguru/upload-quality': resolve(process.cwd(), 'src/admin/features/upload-quality/upload-quality-field.tsx') } },
    cacheDir: `${config.cacheDir ?? 'node_modules/.strapi/vite'}-${patchRevision}`,
  });
};
