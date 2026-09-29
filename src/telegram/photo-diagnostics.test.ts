import { expect, it } from 'vitest';
import { photoDiagnostic, readPhotoDiagnostic } from './photo-diagnostics';

it('keeps the failure step and safe network cause without copying any secret text', () => {
  const token = `123456789:${'a'.repeat(35)}`;
  const error = Object.assign(new Error(`fetch failed https://api.telegram.org/bot${token}/getFile Authorization: Bearer private-key`), {
    body: { token }, cause: { code: 'ECONNRESET', message: 'private-key' },
  });
  const details = photoDiagnostic(error, 'telegram-file', new Date('2026-09-13T00:00:00Z'));
  expect(details).toMatchObject({ step: 'telegram-file', type: 'Error', code: 'ECONNRESET', message: 'The network request failed.' });
  expect(JSON.stringify(details)).not.toMatch(/123456789|api\.telegram|private-key|Authorization/);
});

it('never copies arbitrary error names, codes, bodies, stacks or strings', () => {
  const error = { name: 'SECRET', code: 'SECRET', status: 'SECRET', message: 'SECRET', body: 'SECRET', stack: 'SECRET' };
  expect(JSON.stringify(photoDiagnostic(error, 'fal-upload'))).not.toContain('SECRET');
  expect(JSON.stringify(photoDiagnostic('SECRET', 'fal-upload'))).not.toContain('SECRET');
});

it('preserves safe HTTP status and identifies a rejected Telegram file', () => {
  const error = { name: 'TelegramApiError', status: 400, message: 'Telegram getFile failed: Bad Request: wrong file_id or the file is temporarily unavailable' };
  const details = photoDiagnostic(error, 'telegram-file');
  expect(details).toMatchObject({ status: 400, message: 'Telegram rejected the photo identifier or the photo is temporarily unavailable.' });
  expect(readPhotoDiagnostic(JSON.stringify(details))).toEqual(details);
});

it('rejects malformed stored diagnostics and strips unapproved properties', () => {
  const details = photoDiagnostic(new Error('fetch failed'), 'telegram-download');
  expect(readPhotoDiagnostic('{')).toBeNull();
  expect(readPhotoDiagnostic(JSON.stringify({ ...details, message: 'SECRET' }))).toBeNull();
  expect(readPhotoDiagnostic(JSON.stringify({ ...details, stack: 'SECRET', token: 'SECRET' }))).toEqual(details);
});
