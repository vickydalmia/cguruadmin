import { expect, it } from 'vitest';
import { diagnosticMessage, pageDiagnostics } from './refresh-diagnostics';
it('retains useful failure details while removing credentials, URLs and stack traces', () => {
  expect(diagnosticMessage('HTTP 503 from https://user:pass@cms.test/path?token=abc Bearer xyz api_key=abcd\n at stack', ['abcd']))
    .toBe('HTTP 503 from [upstream URL] Bearer [redacted] api_key=[redacted]');
});
it('exposes actual cached timestamps and retry data without passing arbitrary upstream properties', () => {
  expect(pageDiagnostics([{ path: '/ar/amazon/', state: 'failed', renderedAt: 1700000000000, cachedHttpStatus: 200, targetVersion: 8, renderedVersion: 7, attemptsMade: 3, maxAttempts: 3, error: 'SSR returned 503', stack: 'private', body: 'private' }], '')[0])
    .toMatchObject({ path: '/ar/amazon/', generatedAt: '2023-11-14T22:13:20.000Z', error: 'SSR returned 503', attemptsMade: 3 });
  expect(JSON.stringify(pageDiagnostics([{ path: '/', state: 'rendered', renderedAt: 0, stack: 'private' }], ''))).not.toContain('private');
});
