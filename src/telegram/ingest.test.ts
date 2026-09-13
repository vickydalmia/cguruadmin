import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { prepareTransparentDealImage } from '../utils/deal-image-background';

vi.mock('../utils/deal-image-background', () => ({
  DEAL_IMAGE_PROCESSOR_VERSION: 'fal-bria-rmbg-2.0-v1',
  prepareTransparentDealImage: vi.fn(async ({ outputDirectory }: any) => ({
    pngPath: path.join(outputDirectory, 'prepared.png'), png: Buffer.from('prepared-png'), sourceHash: 'source-hash',
  })),
}));

vi.mock('./feed-refresh', () => ({ enqueueTelegramFeedRefresh: vi.fn(async () => undefined) }));

import { channelUsernameFor, messageMatchesChannel, runTelegramIngest } from './ingest';
import * as stateModule from './state';
import * as pendingStore from './pending-store';
import { ingestionCms } from './ingest-test-cms.test-utils';
import { TelegramApiError } from './bot-api';
import { PHOTO_DIAGNOSIS_REQUEST } from './photo-diagnostics';
const databases: any[] = [];
afterEach(async () => { for (const db of databases.splice(0)) await db.destroy(); });

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const NOW = new Date('2026-09-12T10:00:00.000Z');

function message(id: number, overrides: Record<string, unknown> = {}) {
  return {
    message_id: id,
    date: 1_789_000_000 + id,
    chat: { id: -1001234, type: 'channel', username: 'couponzguru' },
    caption: `Deal ${id}\nRs. 499 only https://www.amazon.in/dp/${id}`,
    caption_entities: [],
    photo: [{ file_id: `small-${id}`, file_unique_id: `u-small-${id}`, width: 90, height: 90, file_size: 1000 }, { file_id: `big-${id}`, file_unique_id: `u-big-${id}`, width: 800, height: 800, file_size: 50_000 }],
    ...overrides,
  };
}

async function harness(options: { config?: any; existing?: any[]; updates?: any[][] } = {}) {
  const config = { enabled: true, botToken: TOKEN, channel: '@couponzguru', channelUsername: null,
    pollIntervalMinutes: 5, maxStoredPosts: 60, ...options.config };
  const cms = await ingestionCms(config, options.existing);
  databases.push(cms.db);
  const pages = [...(options.updates ?? [[]])];
  const api = {
    getUpdates: vi.fn(async () => pages.shift() ?? []),
    getChatMemberCount: vi.fn(async () => 12_942),
    getFile: vi.fn(async (fileId: string) => ({ file_id: fileId, file_unique_id: `u-${fileId}`, file_path: `photos/${fileId}.jpg` })),
    downloadFile: vi.fn(async () => ({ bytes: Buffer.from('jpegbytes'), contentType: 'image/jpeg' })),
  };
  return { ...cms, api };
}

describe('runTelegramIngest', () => {
  it('skips when ingestion is disabled or unconfigured', async () => {
    const disabled = await harness({ config: { enabled: false } });
    expect((await runTelegramIngest(disabled.strapi, { now: NOW })).skipped).toBe('disabled');
    const noToken = await harness({ config: { botToken: null } });
    expect((await runTelegramIngest(noToken.strapi, { now: NOW })).skipped).toBe('unconfigured');
    expect(noToken.strapi.log.warn).toHaveBeenCalled();
  });

  it('creates rows for matching channel posts, re-hosts the largest photo and advances the offset', async () => {
    const { strapi, api, created, uploads } = await harness({
      updates: [[
        { update_id: 10, channel_post: message(1) },
        { update_id: 11, channel_post: message(2, { chat: { id: -999, type: 'channel', username: 'other' } }) },
        { update_id: 12, channel_post: message(3, { photo: undefined, caption: undefined, text: '' }) },
      ]],
    });
    const result = await runTelegramIngest(strapi, { now: NOW, createApi: () => api as any });

    expect(result).toMatchObject({ skipped: null, created: 1, updated: 0, error: null });
    expect(created[0]).toMatchObject({
      messageId: 1,
      chatId: '-1001234',
      title: 'Deal 1',
      salePrice: 499,
      ctaUrl: 'https://www.amazon.in/dp/1',
      storeDomain: 'amazon.in',
      permalink: 'https://t.me/couponzguru/1',
      photo: 101,
      photoFileUniqueId: 'u-big-1',
      hidden: false,
    });
    expect(api.getFile).toHaveBeenCalledWith('big-1');
    expect(uploads[0].data.fileInfo).toMatchObject({ folder: 7, alternativeText: 'Deal 1' });
    expect(uploads[0].files[0]).toMatchObject({ mimetype: 'image/png', size: 12 });
    expect(prepareTransparentDealImage).toHaveBeenCalledWith(expect.objectContaining({ source: Buffer.from('jpegbytes'), sourceMime: 'image/jpeg' }));

    const state = await stateModule.readTelegramIngestState(strapi);
    expect(state.updateOffset).toBe(13);
    expect(state.memberCount).toBe(12_942);
    expect(state.lastError).toBeNull();
    expect(api.getUpdates).toHaveBeenCalledWith(expect.objectContaining({ allowed_updates: ['channel_post', 'edited_channel_post'] }));
  });

  it('updates an existing row on an edited post and only re-hosts when the photo changed', async () => {
    const existing = { documentId: 'doc-1', chatId: '-1001234', messageId: 1, postedAt: '2026-09-01T00:00:00.000Z', photoFileUniqueId: 'u-big-1', photo: { id: 55 } };
    const { strapi, api, updated, removedFiles } = await harness({
      existing: [existing],
      updates: [[{ update_id: 20, edited_channel_post: message(1, { edit_date: 1_757_700_000, caption: 'Deal 1 updated\nRs. 399' }) }]],
    });
    const result = await runTelegramIngest(strapi, { now: NOW, createApi: () => api as any });
    expect(result).toMatchObject({ created: 0, updated: 1 });
    expect(updated[0].data).toMatchObject({ title: 'Deal 1 updated', salePrice: 399, editedAt: new Date(1_757_700_000 * 1000).toISOString() });
    expect(updated[0].data.photo).toBeUndefined();
    expect(api.getFile).not.toHaveBeenCalled();
    expect(removedFiles).toEqual([]);
  });

  it('enforces the retention cap after new posts and deletes the orphaned photos', async () => {
    const existing = Array.from({ length: 3 }, (_, index) => ({
      documentId: `old-${index}`, chatId: '-1001234', messageId: 100 + index, postedAt: `2026-08-0${index + 1}T00:00:00.000Z`, photo: { id: 200 + index },
    }));
    const { strapi, api, deleted, removedFiles } = await harness({
      config: { maxStoredPosts: 2 },
      existing,
      updates: [[{ update_id: 30, channel_post: message(500) }]],
    });
    const result = await runTelegramIngest(strapi, { now: NOW, createApi: () => api as any });
    expect(result.created).toBe(1);
    expect(result.deleted).toBe(2);
    expect(deleted.sort()).toEqual(['old-0', 'old-1']);
    expect(removedFiles.map((file) => file.id).sort()).toEqual([200, 201]);
  });

  it('respects the poll interval unless forced', async () => {
    const { strapi, api } = await harness({ updates: [[], []] });
    await runTelegramIngest(strapi, { now: NOW, createApi: () => api as any });
    const soon = new Date(NOW.getTime() + 60_000);
    expect((await runTelegramIngest(strapi, { now: soon, createApi: () => api as any })).skipped).toBe('not-due');
    expect((await runTelegramIngest(strapi, { now: soon, force: true, createApi: () => api as any })).skipped).toBeNull();
    expect(api.getUpdates).toHaveBeenCalledTimes(2);
  });

  it('records a redacted error and keeps the previous offset when Telegram fails', async () => {
    const { strapi, api } = await harness();
    api.getUpdates.mockRejectedValueOnce(new Error(`boom ${TOKEN}`));
    const result = await runTelegramIngest(strapi, { now: NOW, createApi: () => api as any });
    expect(result.error).toBe('boom <bot-token>');
    const state = await stateModule.readTelegramIngestState(strapi);
    expect(state.lastError).toBe('boom <bot-token>');
    expect(state.updateOffset).toBeNull();
    expect(strapi.log.error).toHaveBeenCalledWith(expect.objectContaining({ event: 'telegram.ingest_failed' }));
  });
});

describe('ingestion reliability', () => {
  it('durably acknowledges a failed photo while keeping it unpublished for retry', async () => {
    vi.mocked(prepareTransparentDealImage).mockRejectedValueOnce(new Error('Background removal unavailable'));
    const { strapi, api, created, uploads } = await harness({ updates: [[{ update_id: 1, channel_post: message(1) }]] });
    const result = await runTelegramIngest(strapi, { now: NOW, createApi: () => api });
    expect(result.error).toBeNull();
    expect(await strapi.db.connection(pendingStore.TELEGRAM_PENDING_TABLE).first()).toMatchObject({ attempts: 1, error_code: 'TELEGRAM_PHOTO_FAILED' });
    expect(created).toEqual([]);
    expect(uploads).toEqual([]);
    expect((await stateModule.readTelegramIngestState(strapi)).updateOffset).toBe(2);
  });

  it('persists the first batch before acknowledging it to request another', async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({ update_id: index + 1, channel_post: message(index + 1, { photo: [] }) }));
    const { strapi, api, created } = await harness({ updates: [first, []] });
    api.getUpdates.mockImplementationOnce(async () => first).mockImplementationOnce(async () => {
      expect(created).toHaveLength(0);
      expect(await strapi.db.connection(pendingStore.TELEGRAM_PENDING_TABLE)).toHaveLength(60);
      expect((await stateModule.readTelegramIngestState(strapi)).updateOffset).toBe(101);
      throw new Error('second page failed');
    });
    const result = await runTelegramIngest(strapi, { now: NOW, createApi: () => api });
    expect(result.error).toBe('second page failed');
    expect((await stateModule.readTelegramIngestState(strapi)).updateOffset).toBe(101);
  });

  it('does not acknowledge another batch when durable message storage fails', async () => {
    const updates = Array.from({ length: 100 }, (_, i) => ({ update_id: i + 1, channel_post: message(i + 1, { photo: [] }) }));
    const { strapi, api } = await harness({ updates: [updates, []] });
    const save = pendingStore.savePendingMessages;
    vi.spyOn(pendingStore, 'savePendingMessages').mockImplementationOnce(save).mockRejectedValueOnce(new Error('save failed'));
    expect((await runTelegramIngest(strapi, { now: NOW, createApi: () => api })).error).toBe('save failed');
    expect(api.getUpdates).toHaveBeenCalledTimes(1);
    expect((await stateModule.readTelegramIngestState(strapi)).updateOffset).toBeNull();
  });

  it('excludes overlapping ticks before async settings reads complete', async () => {
    const { strapi, api } = await harness();
    let release!: () => void;
    api.getUpdates.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve([]); }));
    const first = runTelegramIngest(strapi, { now: NOW, createApi: () => api });
    expect((await runTelegramIngest(strapi, { now: NOW, createApi: () => api })).skipped).toBe('running');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await first;
  });

  it('does not overwrite editor corrections on replayed identical messages', async () => {
    const msg = message(1, { photo: [] });
    const { strapi, api, updated } = await harness({ existing: [{
      documentId: 'post', chatId: String(msg.chat.id), messageId: 1,
      text: msg.caption, editedAt: null, permalink: 'https://t.me/couponzguru/1',
      photoFileUniqueId: null, title: 'Editor title', salePrice: 300,
    }], updates: [[{ update_id: 1, channel_post: msg }]] });
    await runTelegramIngest(strapi, { now: NOW, createApi: () => api });
    expect(updated).toHaveLength(0);
  });

  it('enqueues a repaint when only the member count changes', async () => {
    const { enqueueTelegramFeedRefresh } = await import('./feed-refresh');
    vi.mocked(enqueueTelegramFeedRefresh).mockClear();
    const { strapi, api } = await harness();
    await runTelegramIngest(strapi, { now: NOW, createApi: () => api });
    expect(enqueueTelegramFeedRefresh).toHaveBeenCalledWith(strapi);
  });
});

describe('channel helpers', () => {
  it('matches by username for @channels and by id otherwise', () => {
    const msg = message(1) as any;
    expect(messageMatchesChannel(msg, '@CouponzGuru')).toBe(true);
    expect(messageMatchesChannel(msg, '-1001234')).toBe(true);
    expect(messageMatchesChannel(msg, '@other')).toBe(false);
    expect(messageMatchesChannel(msg, '-1009999')).toBe(false);
  });

  it('derives the permalink username', () => {
    expect(channelUsernameFor({ channel: '@couponzguru', channelUsername: null })).toBe('couponzguru');
    expect(channelUsernameFor({ channel: '-1001234', channelUsername: 'cgdeals' })).toBe('cgdeals');
    expect(channelUsernameFor({ channel: '-1001234', channelUsername: null })).toBeNull();
  });
});


it('continues past a failed photo and does not retry it on quiet ticks before its backoff', async () => {
  vi.mocked(prepareTransparentDealImage).mockRejectedValueOnce(new Error('provider failed'));
  const { strapi, api, created, db } = await harness({ updates: [[
    { update_id: 1, channel_post: message(1) },
    { update_id: 2, channel_post: message(2, { photo: [] }) },
  ]] });
  const before = vi.mocked(prepareTransparentDealImage).mock.calls.length;
  await runTelegramIngest(strapi, { now: NOW, createApi: () => api });
  expect(created.map(row => row.messageId)).toEqual([2]);
  expect((await stateModule.readTelegramIngestState(strapi)).updateOffset).toBe(3);
  expect(await db(pendingStore.TELEGRAM_PENDING_TABLE)).toHaveLength(1);
  await runTelegramIngest(strapi, { now: NOW, createApi: () => api });
  expect(vi.mocked(prepareTransparentDealImage).mock.calls.length).toBe(before + 1);
});

it('keeps the feed and pending backlog bounded after 1000 updates and drains without more Telegram fetches', async () => {
  const updates = Array.from({ length: 10 }, (_, page) => Array.from({ length: 100 }, (_, i) => {
    const id = page * 100 + i + 1;
    return { update_id: id, channel_post: message(id, { photo: [] }) };
  }));
  const { strapi, api, db, rows } = await harness({ updates });
  await runTelegramIngest(strapi, { now: NOW, createApi: () => api });
  expect(await rows()).toHaveLength(20);
  expect(await db(pendingStore.TELEGRAM_PENDING_TABLE)).toHaveLength(40);
  await runTelegramIngest(strapi, { now: NOW, createApi: () => api });
  await runTelegramIngest(strapi, { now: NOW, createApi: () => api });
  expect(await rows()).toHaveLength(60);
  expect((await rows()).every(row => row.messageId >= 941)).toBe(true);
  expect(await db(pendingStore.TELEGRAM_PENDING_TABLE)).toHaveLength(0);
  expect(api.getUpdates).toHaveBeenCalledTimes(10);
});

it('drains an existing oversized feed in bounded transactions while pausing new publication', async () => {
  const existing = Array.from({ length: 260 }, (_, i) => ({ documentId: `old-${i}`, chatId: '-1001234', messageId: i,
    postedAt: new Date(1_700_000_000_000 + i * 1000).toISOString(), text: 'Old post' }));
  const { strapi, api, rows, created } = await harness({ existing, updates: [[{ update_id: 1, channel_post: message(500, { photo: [] }) }]] });
  const first = await runTelegramIngest(strapi, { now: NOW, createApi: () => api });
  expect(first.deleted).toBe(100);
  expect(created).toHaveLength(0);
  await runTelegramIngest(strapi, { now: NOW, createApi: () => api });
  await runTelegramIngest(strapi, { now: NOW, createApi: () => api });
  expect(await rows()).toHaveLength(60);
  expect(created).toHaveLength(1);
});

it('checks a failing photo without changing its retry budget, schedule, uploads or public feed', async () => {
  vi.mocked(prepareTransparentDealImage).mockRejectedValueOnce(new Error('initial failure'));
  const { strapi, api, db, created, uploads } = await harness({ updates: [[{ update_id: 1, channel_post: message(1) }]] });
  await runTelegramIngest(strapi, { now: NOW, createApi: () => api });
  const next = new Date(Date.now() + 3_600_000);
  await db(pendingStore.TELEGRAM_PENDING_TABLE).update({ attempts: 4, next_attempt_at: next, error_details: PHOTO_DIAGNOSIS_REQUEST });
  api.getFile.mockRejectedValueOnce(new TelegramApiError('Bad Request: wrong file_id or the file is temporarily unavailable', { status: 400 }));
  await runTelegramIngest(strapi, { now: NOW, createApi: () => api });
  const row = await db(pendingStore.TELEGRAM_PENDING_TABLE).first();
  expect(row.attempts).toBe(4);
  expect(new Date(row.next_attempt_at).getTime()).toBe(next.getTime());
  expect(JSON.parse(row.error_details)).toMatchObject({ step: 'telegram-file', status: 400, type: 'TelegramApiError' });
  expect(created).toHaveLength(0);
  expect(uploads).toHaveLength(0);
  expect(api.getUpdates).toHaveBeenCalledTimes(1);
});

it.each([false, true])('fences an in-flight image against replacement=%s while accepting caption edits', async replaced => {
  const original = message(1);
  const { strapi, api, db, created, uploads } = await harness({ updates: [[{ update_id: 1, channel_post: original }]] });
  api.getFile.mockImplementationOnce(async () => {
    const job = await db(pendingStore.TELEGRAM_PENDING_TABLE).first();
    await pendingStore.savePendingMessages(db, job.connection_key, [{ update_id: 2, edited_channel_post: {
      ...original, caption: 'New caption', photo: original.photo.map(photo => ({ ...photo, file_id: 'rotated',
        file_unique_id: replaced ? `replacement-${photo.file_unique_id}` : photo.file_unique_id })),
    } }], 60, new Date());
    return { file_id: 'first', file_unique_id: 'u-big-1', file_path: 'photos/first.jpg' };
  });
  await runTelegramIngest(strapi, { now: NOW, createApi: () => api });
  if (replaced) {
    expect(created).toHaveLength(0); expect(uploads).toHaveLength(0);
    expect(await db(pendingStore.TELEGRAM_PENDING_TABLE).first()).toMatchObject({ update_id: 2, stage: 'pending' });
  } else {
    expect(created).toHaveLength(1); expect(uploads).toHaveLength(1);
    expect(created[0]).toMatchObject({ title: 'New caption', photoFileUniqueId: 'u-big-1' });
    expect(await db(pendingStore.TELEGRAM_PENDING_TABLE)).toHaveLength(0);
  }
});

it('discards obsolete pending photos before download without changing the retained feed', async () => {
  const msg = message(1);
  const existing = Array.from({ length: 60 }, (_, index) => ({ documentId: `new-${index}`, chatId: '-1001234', messageId: 10 + index,
    postedAt: new Date((msg.date + 1 + index) * 1000).toISOString(), hidden: index === 0, text: 'Newer post' }));
  const { strapi, api, created, deleted, db, uploads } = await harness({ existing, updates: [[{ update_id: 1, channel_post: msg }]] });
  const { enqueueTelegramFeedRefresh } = await import('./feed-refresh');
  await stateModule.writeTelegramIngestState(strapi, { ...stateModule.EMPTY_TELEGRAM_INGEST_STATE, memberCount: 12942, memberCountAt: NOW.toISOString() });
  vi.mocked(enqueueTelegramFeedRefresh).mockClear();
  await runTelegramIngest(strapi, { now: NOW, createApi: () => api });
  expect(api.getFile).not.toHaveBeenCalled(); expect(uploads).toHaveLength(0);
  expect(created).toHaveLength(0); expect(deleted).toHaveLength(0);
  expect(await db(pendingStore.TELEGRAM_PENDING_TABLE)).toHaveLength(0);
  expect(enqueueTelegramFeedRefresh).not.toHaveBeenCalled();
});

it('keeps the retention boundary eligible for caption edits', async () => {
  const msg = message(1, { photo: [] });
  const existing = Array.from({ length: 60 }, (_, index) => ({ documentId: `post-${index}`, chatId: String(msg.chat.id), messageId: 1 + index,
    postedAt: new Date((msg.date + index) * 1000).toISOString(), text: 'Previous caption' }));
  const { strapi, api, created, updated, deleted } = await harness({ existing, updates: [[{ update_id: 1, edited_channel_post: msg }]] });
  await runTelegramIngest(strapi, { now: NOW, createApi: () => api });
  expect(created).toHaveLength(0); expect(deleted).toHaveLength(0);
  expect(updated).toHaveLength(1); expect(updated[0].data.title).toBe('Deal 1');
});

it('stops a successful image check before upload or publication and does not repeat it on quiet ticks', async () => {
  vi.mocked(prepareTransparentDealImage).mockRejectedValueOnce(new Error('initial failure'));
  const { strapi, api, db, created, uploads } = await harness({ updates: [[{ update_id: 1, channel_post: message(1) }]] });
  await runTelegramIngest(strapi, { now: NOW, createApi: () => api });
  await db(pendingStore.TELEGRAM_PENDING_TABLE).update({ error_details: PHOTO_DIAGNOSIS_REQUEST });
  await runTelegramIngest(strapi, { now: NOW, createApi: () => api });
  const row = await db(pendingStore.TELEGRAM_PENDING_TABLE).first();
  expect(JSON.parse(row.error_details)).toMatchObject({ step: 'image-upload', type: 'PhotoCheckComplete' });
  expect(created).toHaveLength(0);
  expect(uploads).toHaveLength(0);
  api.getFile.mockClear();
  await runTelegramIngest(strapi, { now: NOW, createApi: () => api });
  expect(api.getFile).not.toHaveBeenCalled();
});
