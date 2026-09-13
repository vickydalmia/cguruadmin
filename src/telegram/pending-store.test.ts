import { expect, it } from 'vitest';
import { ingestionCms } from './ingest-test-cms.test-utils';
import { savePendingMessages, TELEGRAM_PENDING_TABLE } from './pending-store';

it.each(['submitted', 'uploaded', 'blocked'])('preserves %s work and backoff when only caption/download handles change', async stage => {
  const { db } = await ingestionCms({});
  try {
    const message = { message_id: 1, date: 1700000000, chat: { id: -1001, type: 'channel' }, caption: 'Original',
      photo: [{ file_id: 'first', file_unique_id: 'stable', width: 800, height: 800 }] };
    await savePendingMessages(db, 'fixture', [{ update_id: 1, channel_post: message }], 60, new Date());
    const retryAt = new Date(Date.now() + 3600000);
    await db(TELEGRAM_PENDING_TABLE).update({ stage, request_id: 'saved-request', media_id: 7, attempts: 3, next_attempt_at: retryAt });
    const edited = { ...message, caption: 'Edited', photo: [{ ...message.photo[0], file_id: 'rotated' }, { file_id: 'new-small', file_unique_id: 'small', width: 90, height: 90 }] };
    expect(await savePendingMessages(db, 'fixture', [{ update_id: 2, edited_channel_post: edited }], 60, new Date())).toEqual([]);
    const row = await db(TELEGRAM_PENDING_TABLE).first();
    expect(row).toMatchObject({ update_id: 2, stage, request_id: 'saved-request', media_id: 7, attempts: 3 });
    expect(new Date(row.next_attempt_at).getTime()).toBe(retryAt.getTime());
    expect(JSON.parse(row.message).caption).toBe('Edited');
    const replacement = { ...edited, photo: [{ ...message.photo[0], file_unique_id: 'replacement' }] };
    expect(await savePendingMessages(db, 'fixture', [{ update_id: 3, edited_channel_post: replacement }], 60, new Date())).toHaveLength(1);
    expect(await db(TELEGRAM_PENDING_TABLE).first()).toMatchObject({ stage: 'pending', request_id: null, media_id: null, attempts: 0 });
  } finally { await db.destroy(); }
});
