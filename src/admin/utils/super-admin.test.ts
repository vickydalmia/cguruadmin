import { describe, expect, it } from 'vitest';

import { isSuperAdminUser } from './super-admin';

describe('isSuperAdminUser', () => {
  it('only recognises the strapi-super-admin role code', () => {
    expect(isSuperAdminUser({ roles: [{ code: 'strapi-super-admin' }] })).toBe(true);
    expect(isSuperAdminUser({ roles: [{ code: 'strapi-editor' }, { code: 'strapi-author' }] })).toBe(false);
    expect(isSuperAdminUser({ roles: [] })).toBe(false);
    expect(isSuperAdminUser(undefined)).toBe(false);
    expect(isSuperAdminUser({ roles: 'strapi-super-admin' })).toBe(false);
  });
});
