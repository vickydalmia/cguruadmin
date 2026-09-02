import { describe, expect, it, vi } from 'vitest';

const migration = require(
  '../../database/migrations/2026.09.03T00.00.00.make-localized-document-identity-locale-aware.js',
);

describe('localized document identity migration', () => {
  it('replaces every legacy document-only index without touching queue state', async () => {
    const raw = vi.fn().mockResolvedValue(undefined);
    const hasTable = vi.fn().mockResolvedValue(true);

    await migration.up({ schema: { hasTable }, raw });

    expect(hasTable).toHaveBeenCalledTimes(
      migration.LOCALIZED_DOCUMENT_TABLES.length,
    );
    expect(raw).toHaveBeenCalledTimes(
      migration.LOCALIZED_DOCUMENT_TABLES.length * 3,
    );

    for (const table of migration.LOCALIZED_DOCUMENT_TABLES) {
      expect(raw).toHaveBeenCalledWith(
        `DROP INDEX IF EXISTS "${table}_document_id_uq"`,
      );
      expect(raw).toHaveBeenCalledWith(
        expect.stringContaining(`UPDATE "${table}"`),
        ['en'],
      );
      expect(raw).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(
            `CREATE UNIQUE INDEX IF NOT EXISTS "${table}_document_id_locale_uq"[\\s\\S]+` +
              `\\("document_id", "locale"\\)`,
          ),
        ),
      );
    }

    expect(raw.mock.calls.flat().join('\n')).not.toContain('translation_outbox');
    expect(raw.mock.calls.flat().join('\n')).not.toContain('translation_state');
  });

  it('leaves tables that do not exist for schema sync or preflight to handle', async () => {
    const raw = vi.fn().mockResolvedValue(undefined);
    const hasTable = vi.fn().mockResolvedValue(false);

    await migration.up({ schema: { hasTable }, raw });

    expect(raw).not.toHaveBeenCalled();
  });
});
