import { expect, it, vi } from 'vitest';
import { onceOnCommit } from './once-on-commit';

it('guards each registration even after exceptions, without merging valid writes', () => {
  const strapi = { log: { warn: vi.fn() } } as any;
  const callback = vi.fn(() => { throw new Error('side effect'); });
  const first = onceOnCommit(strapi, callback);
  const second = onceOnCommit(strapi, callback);
  expect(first).toThrow('side effect');
  for (let i = 0; i < 100; i++) first();
  expect(second).toThrow('side effect');
  second();
  expect(callback).toHaveBeenCalledTimes(2);
  expect(strapi.log.warn).toHaveBeenCalledTimes(1);
});
