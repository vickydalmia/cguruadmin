import { describe, expect, it, vi } from 'vitest';

import plugin from './index';

const IMPORT_ACTION = 'plugin::unique-coupon.codes.import';

describe('unique-coupon plugin bootstrap', () => {
  it('registers the import permission action the routes enforce', async () => {
    const registerMany = vi.fn().mockResolvedValue(undefined);
    const strapi = {
      service: vi.fn(() => ({ actionProvider: { registerMany } })),
    } as any;

    await plugin.bootstrap({ strapi });

    expect(strapi.service).toHaveBeenCalledWith('admin::permission');
    expect(registerMany).toHaveBeenCalledWith([
      {
        section: 'plugins',
        displayName: 'Import unique codes',
        uid: 'codes.import',
        pluginName: 'unique-coupon',
      },
    ]);

    // Strapi derives the action id as `plugin::${pluginName}.${uid}` — it must
    // be exactly the id the upload/stats route policies check, or the grant in
    // Settings > Roles would never unlock the routes.
    const [{ pluginName, uid }] = registerMany.mock.calls[0][0];
    expect(`plugin::${pluginName}.${uid}`).toBe(IMPORT_ACTION);
  });
});
