import { expect, it } from 'vitest';
import policy from './content-api-custom-token-only';

const withToken = (strategy: string, type: string | undefined) =>
  ({ state: { auth: { strategy: { name: strategy }, credentials: { id: 1, type } } } });

it('admits only Custom-type Content API tokens', () => {
  expect(policy(withToken('content-api-token', 'custom'))).toBe(true);
  expect(policy(withToken('api-token', 'custom'))).toBe(true);
  expect(policy(withToken('content-api-token', 'full-access'))).toBe(false);
  expect(policy(withToken('content-api-token', 'read-only'))).toBe(false);
  expect(policy(withToken('content-api-token', undefined))).toBe(false);
});

it('fails closed for admin sessions and unauthenticated calls', () => {
  expect(policy({ state: { user: { id: 1 }, auth: { strategy: { name: 'admin' }, credentials: { type: 'custom' } } } })).toBe(false);
  expect(policy({ state: {} })).toBe(false);
  expect(policy({})).toBe(false);
  expect(policy(undefined)).toBe(false);
});
