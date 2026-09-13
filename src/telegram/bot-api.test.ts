import { describe, expect, it, vi } from 'vitest';
import { createBotApi, redactBotToken, TelegramApiError } from './bot-api';

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('bot api client', () => {
  it('posts JSON to the bot method URL and unwraps the envelope', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, result: [{ update_id: 1 }] }));
    const api = createBotApi({ token: TOKEN, fetchImpl: fetchImpl as any });
    await expect(api.getUpdates({ offset: 5, limit: 100 })).resolves.toEqual([{ update_id: 1 }]);
    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ offset: 5, limit: 100 });
  });

  it('retries once on a retriable status and then reports a redacted error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: false, description: `bad ${TOKEN}` }, 502));
    const api = createBotApi({ token: TOKEN, fetchImpl: fetchImpl as any });
    const failure = await api.getChatMemberCount('@chan').catch((error) => error);
    expect(failure).toBeInstanceOf(TelegramApiError);
    expect(failure.message).toContain('<bot-token>');
    expect(failure.message).not.toContain(TOKEN);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a client error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: false, description: 'Unauthorized', error_code: 401 }, 401));
    const api = createBotApi({ token: TOKEN, fetchImpl: fetchImpl as any });
    await expect(api.getUpdates({})).rejects.toMatchObject({ status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('downloads file bytes without exposing the token URL to callers', async () => {
    const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
    const fetchImpl = vi.fn(async () => new Response(photo, { headers: { 'content-type': 'image/jpeg' } }));
    const api = createBotApi({ token: TOKEN, fetchImpl: fetchImpl as any });
    const result = await api.downloadFile('photos/file_1.jpg');
    expect(result.bytes).toEqual(photo);
    expect(result.contentType).toBe('image/jpeg');
    expect((fetchImpl.mock.calls[0] as any)[0]).toBe(`https://api.telegram.org/file/bot${TOKEN}/photos/file_1.jpg`);
  });

  it('redacts every token occurrence', () => {
    expect(redactBotToken(`a ${TOKEN} b ${TOKEN}`, TOKEN)).toBe('a <bot-token> b <bot-token>');
    expect(redactBotToken('plain', null)).toBe('plain');
  });
});

describe('Telegram download boundaries', () => {
  it.each(['photos/file_123', 'photos/file_1.preview.jpg', 'photos.v2/file-1.jpg'])('accepts the safe opaque path %s', async path => {
    const photo = new Uint8Array([0xff, 0xd8, 0xff]);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(photo, { headers: { 'content-type': 'application/octet-stream' } }));
    const api = createBotApi({ token: TOKEN, fetchImpl });
    await expect(api.downloadFile(path)).resolves.toMatchObject({ contentType: 'image/jpeg' });
    expect(fetchImpl).toHaveBeenCalledWith(`https://api.telegram.org/file/bot${TOKEN}/${path}`, expect.objectContaining({ redirect: 'error' }));
  });
  it.each([
    ['jpeg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16])],
    ['png', 'image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
    ['webp', 'image/webp', Buffer.from('RIFF\x04\x00\x00\x00WEBP', 'binary')],
  ])('detects %s photos delivered as generic binary', async (extension, contentType, photo) => {
    const api = createBotApi({ token: TOKEN, fetchImpl: vi.fn().mockResolvedValue(new Response(photo, { headers: { 'content-type': 'application/octet-stream' } })) });
    await expect(api.downloadFile(`photos/file.${extension}`)).resolves.toEqual({ bytes: photo, contentType });
  });
  it('detects photos when the Content-Type header is absent', async () => {
    const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
    const api = createBotApi({ token: TOKEN, fetchImpl: vi.fn().mockResolvedValue(new Response(photo)) });
    await expect(api.downloadFile('photos/file.jpg')).resolves.toMatchObject({ contentType: 'image/jpeg' });
  });
  it.each(['application/octet-stream', 'image/jpeg'])('rejects HTML disguised as %s', async contentType => {
    const api = createBotApi({ token: TOKEN, fetchImpl: vi.fn().mockResolvedValue(new Response('<html>not a photo</html>', { headers: { 'content-type': contentType } })) });
    await expect(api.downloadFile('photos/file.jpg')).rejects.toThrow('invalid image content');
  });
  it('rejects a declared image type that disagrees with the bytes', async () => {
    const api = createBotApi({ token: TOKEN, fetchImpl: vi.fn().mockResolvedValue(new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/png' } })) });
    await expect(api.downloadFile('photos/file.png')).rejects.toMatchObject({
      code: 'TELEGRAM_PHOTO_TYPE_MISMATCH', contentType: 'image/png', detectedType: 'image/jpeg',
    });
  });
  it('rejects absolute and traversal paths before making a request', async () => {
    const fetchImpl = vi.fn();
    const api = createBotApi({ token: TOKEN, fetchImpl });
    for (const path of [
      'https://evil.test/file.jpg', '//evil.test/file.jpg', '../file.jpg', '/file.jpg',
      'photos/../../file.jpg', './photos/file.jpg', 'photos/./file.jpg', 'photos/%2e%2e/file.jpg',
      'photos%2Ffile.jpg', 'photos\\file.jpg', 'photos/file.jpg?redirect=evil', 'photos/file.jpg#fragment',
      '', 'photos//file.jpg', 'photos/', 'photos/file\n.jpg', 'photos/file.jpg\n',
    ]) {
      await expect(api.downloadFile(path)).rejects.toThrow('Invalid Telegram file path');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('does not retain a token-bearing original error cause', async () => {
    const api = createBotApi({ token: TOKEN, fetchImpl: vi.fn().mockRejectedValue(new Error(`network ${TOKEN}`)) });
    const error = await api.getUpdates({}).catch(error => error);
    expect(error.cause).toBeUndefined();
    expect(String(error)).not.toContain(TOKEN);
  });
  it('bounds a chunked response even without content-length', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; },
    });
    const api = createBotApi({ token: TOKEN, fetchImpl: vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'image/jpeg' } })) });
    await expect(api.downloadFile('photos/large.jpg')).rejects.toThrow('size limit');
    expect(cancelled).toBe(true);
  });
  it('rejects non-image responses and disables redirects on token-bearing requests', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>secret</html>', { headers: { 'content-type': 'text/html' } }));
    const api = createBotApi({ token: TOKEN, fetchImpl });
    await expect(api.downloadFile('photos/file.jpg')).rejects.toThrow('unsupported content type');
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('error');
  });
  it('does not retain secret or arbitrary Content-Type values in download errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('bad', { headers: { 'content-type': `application/${TOKEN}` } }));
    const failure = await createBotApi({ token: TOKEN, fetchImpl }).downloadFile('photos/file.jpg').catch(error => error);
    expect(failure).toMatchObject({ code: 'TELEGRAM_PHOTO_CONTENT_TYPE', contentType: 'unknown' });
    expect(JSON.stringify(failure)).not.toContain(TOKEN);
    expect(String(failure)).not.toContain(TOKEN);
  });
});
