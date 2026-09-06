import { describe, expect, it, vi } from 'vitest';
import { catalogueEntryHash } from './hash';
import { UiDictionaryError, UiDictionaryStore } from './store';

type Row = Record<string, any>;

/**
 * Minimal in-memory knex: supports the chain shapes store-queries.ts uses
 * (select/where/whereNull/whereNotNull/whereIn/first/insert/update/delete)
 * and records raw statements. Enough to assert the store's decisions.
 */
function fakeDb(tables: Record<string, Row[]>) {
  const raws: Array<{ sql: string; bindings: any[] }> = [];
  const inserts: Array<{ table: string; rows: Row[] }> = [];
  let rawRowCount = (sql: string, bindings: any[]) =>
    sql.startsWith('INSERT') ? bindings.length / 7 : 0;

  const builder = (table: string) => {
    const state = {
      wheres: [] as Row[],
      nulls: [] as string[],
      notNulls: [] as string[],
      ins: [] as Array<{ col: string; values: any[] }>,
      op: 'select',
      payload: undefined as any,
      first: false,
    };
    const matches = (row: Row) =>
      state.wheres.every((where) => Object.entries(where).every(([k, v]) => row[k] === v)) &&
      state.nulls.every((column) => row[column] == null) &&
      state.notNulls.every((column) => row[column] != null) &&
      state.ins.every(({ col, values }) => values.includes(row[col]));
    const execute = async () => {
      const rows = (tables[table] ??= []);
      if (state.op === 'insert') {
        inserts.push({ table, rows: state.payload });
        return undefined;
      }
      const hit = rows.filter(matches);
      if (state.op === 'update') {
        for (const row of hit) Object.assign(row, state.payload);
        return hit.length;
      }
      if (state.op === 'delete') {
        for (const row of hit) rows.splice(rows.indexOf(row), 1);
        return hit.length;
      }
      return state.first ? hit[0] : hit;
    };
    const chain: any = {
      select: () => chain,
      orderBy: () => chain,
      onConflict: () => chain,
      merge: () => chain,
      where: (arg: Row | string, value?: any) => {
        state.wheres.push(typeof arg === 'string' ? { [arg]: value } : arg);
        return chain;
      },
      whereNull: (column: string) => (state.nulls.push(column), chain),
      whereNotNull: (column: string) => (state.notNulls.push(column), chain),
      whereIn: (col: string, values: any[]) => (state.ins.push({ col, values }), chain),
      first: () => ((state.first = true), chain),
      insert: (rows: Row[]) => ((state.op = 'insert'), (state.payload = rows), chain),
      update: (values: Row) => ((state.op = 'update'), (state.payload = values), chain),
      delete: () => ((state.op = 'delete'), chain),
      then: (resolve: any, reject: any) => execute().then(resolve, reject),
    };
    return chain;
  };
  const db: any = (table: string) => builder(table);
  db.raw = vi.fn(async (sql: string, bindings: any[]) => {
    raws.push({ sql, bindings });
    return { rowCount: rawRowCount(sql, bindings) };
  });
  return {
    db,
    raws,
    inserts,
    tables,
    setRawRowCount(fn: typeof rawRowCount) {
      rawRowCount = fn;
    },
  };
}

const CORE_STORE = 'strapi_core_store_settings';
const META_KEY = 'plugin_ui-dictionary_catalogue';

function makeStore(tables: Record<string, Row[]>, meta: Row | null = null) {
  if (meta) {
    tables[CORE_STORE] = [{ key: META_KEY, value: JSON.stringify(meta), type: 'object' }];
  }
  const fake = fakeDb(tables);
  const strapi = {
    db: {
      connection: fake.db,
      transaction: async (callback: any) => callback({ trx: fake.db, onCommit: () => {} }),
    },
  } as any;
  // Meta is read back the way Strapi's core store would see it: the row in
  // the table (updated in place) or the last insert into the core-store table.
  const readMeta = (): Row | null => {
    const inserted = fake.inserts.filter((entry) => entry.table === CORE_STORE).at(-1)?.rows[0];
    const row = inserted ?? fake.tables[CORE_STORE]?.find((entry) => entry.key === META_KEY);
    return row ? JSON.parse(String(row.value)) : null;
  };
  return { store: new UiDictionaryStore(strapi), fake, meta: readMeta, strapi };
}

function catalogue(key: string, text: string, extra: Row = {}): Row {
  const effective = catalogueEntryHash(extra.override_text ?? text, extra.max_length ?? null);
  return {
    key,
    text,
    description: null,
    max_length: null,
    plural_of: null,
    hash: catalogueEntryHash(text, extra.max_length ?? null),
    override_text: null,
    effective_hash: effective,
    override_updated_by: null,
    override_updated_at: null,
    removed_at: null,
    ...extra,
  };
}

function translation(locale: string, key: string, text: string, extra: Row = {}): Row {
  return {
    locale,
    key,
    text,
    source_hash: extra.source_hash ?? catalogueEntryHash(key, null),
    origin: 'ai',
    updated_by: null,
    updated_at: new Date('2026-08-31T00:00:00Z'),
    ...extra,
  };
}

const VERSION = 'b'.repeat(64);

describe('UiDictionaryStore.syncCatalogue', () => {
  it('short-circuits on an unchanged version without touching the tables', async () => {
    const { store, fake, meta } = makeStore(
      { ui_catalogue: [] },
      { version: VERSION, pushedAt: 'earlier', counts: { total: 0, added: 0, changed: 0, removed: 0 } },
    );
    await expect(
      store.syncCatalogue({ version: VERSION, entries: { 'common.viewAll': { text: 'View all' } } }),
    ).resolves.toEqual({ unchanged: true, added: 0, changed: 0, removed: 0, touchedKeys: [], version: VERSION });
    expect(fake.raws).toEqual([
      { sql: 'SELECT pg_advisory_xact_lock(hashtext(?))', bindings: ['ui-dictionary:catalogue'] },
    ]);
    expect(fake.inserts).toEqual([]);
    expect(meta()!.pushedAt).toBe('earlier');
  });

  it('upserts pushed keys, soft-removes absent ones, revives re-pushed ones and writes meta', async () => {
    const { store, fake, meta } = makeStore({
      ui_catalogue: [
        catalogue('common.viewAll', 'View all'),
        catalogue('common.old', 'Old'),
        catalogue('common.back', 'Back', { removed_at: new Date('2026-08-01T00:00:00Z') }),
      ],
    });
    const result = await store.syncCatalogue({
      version: VERSION,
      entries: {
        'common.viewAll': { text: 'View all' },
        'common.back': { text: 'Back' },
        'common.new': { text: 'New', maxLength: 12 },
      },
    });
    expect(result).toEqual({
      unchanged: false,
      added: 1,
      changed: 0,
      removed: 1,
      touchedKeys: ['common.back', 'common.new'],
      version: VERSION,
    });
    expect(fake.inserts[0].table).toBe('ui_catalogue');
    expect(fake.inserts[0].rows.map((row) => row.key)).toEqual(['common.back', 'common.new', 'common.viewAll']);
    expect(fake.inserts[0].rows[1]).toMatchObject({
      max_length: 12,
      hash: catalogueEntryHash('New', 12),
      effective_hash: catalogueEntryHash('New', 12),
      removed_at: null,
    });
    const old = fake.tables.ui_catalogue.find((row) => row.key === 'common.old')!;
    expect(old.removed_at).toBeInstanceOf(Date);
    expect(meta()).toMatchObject({ version: VERSION, counts: { total: 3, added: 1, changed: 0, removed: 1 } });
  });
});

describe('UiDictionaryStore.writeEnglishOverride', () => {
  it('stores the override and recomputes effective_hash; clearing restores the source hash', async () => {
    const { store, fake } = makeStore({
      ui_catalogue: [catalogue('common.viewAll', 'View all', { max_length: 40 })],
    });
    const row = fake.tables.ui_catalogue[0];

    await expect(store.writeEnglishOverride('common.viewAll', 'See everything', 7)).resolves.toEqual({
      key: 'common.viewAll',
      overrideText: 'See everything',
      effectiveHash: catalogueEntryHash('See everything', 40),
      changed: true,
    });
    expect(row).toMatchObject({
      override_text: 'See everything',
      effective_hash: catalogueEntryHash('See everything', 40),
      override_updated_by: 7,
    });
    expect(row.override_updated_at).toBeInstanceOf(Date);
    expect(fake.raws[0].bindings).toEqual(['ui-dictionary:catalogue']);

    await expect(store.writeEnglishOverride('common.viewAll', null, 7)).resolves.toMatchObject({
      overrideText: null,
      effectiveHash: catalogueEntryHash('View all', 40),
      changed: true,
    });
    expect(row).toMatchObject({ override_text: null, override_updated_by: null, override_updated_at: null });

    // Text identical to the pushed English is no override at all.
    await expect(store.writeEnglishOverride('common.viewAll', 'View all', 7)).resolves.toMatchObject({
      overrideText: null,
      changed: false,
    });
  });

  it('rejects unknown keys and blank or over-budget text', async () => {
    const { store } = makeStore({
      ui_catalogue: [catalogue('common.viewAll', 'View all', { max_length: 10 })],
    });
    await expect(store.writeEnglishOverride('common.nope', 'x', 1)).rejects.toMatchObject({
      code: 'UNKNOWN_KEY',
    });
    await expect(store.writeEnglishOverride('common.viewAll', '   ', 1)).rejects.toBeInstanceOf(UiDictionaryError);
    await expect(store.writeEnglishOverride('common.viewAll', 'x'.repeat(11), 1)).rejects.toMatchObject({
      code: 'INVALID_TEXT',
    });
  });
});

describe('UiDictionaryStore.writeAiTranslations', () => {
  const rows = [
    catalogue('common.viewAll', 'View all'),
    catalogue('common.moved', 'Moved (new English)'),
    catalogue('offers.count.one', '{count} offer', { plural_of: 'offers.count' }),
    catalogue('offers.count.other', '{count} offers', { plural_of: 'offers.count' }),
    catalogue('common.gone', 'Gone', { removed_at: new Date('2026-08-01T00:00:00Z') }),
  ];
  const hashOf = (key: string) => rows.find((row) => row.key === key)!.effective_hash;

  it('drops rows whose English moved, resolves plural expansions, and guards manual rows in SQL', async () => {
    const { store, fake } = makeStore({ ui_catalogue: rows.map((row) => ({ ...row })) });
    const result = await store.writeAiTranslations('ar', [
      { key: 'common.viewAll', text: 'عرض الكل', sourceHash: hashOf('common.viewAll') },
      { key: 'common.moved', text: 'old', sourceHash: catalogueEntryHash('Moved (old English)', null) },
      { key: 'offers.count.few', text: '{count} عروض', sourceHash: hashOf('offers.count.other') },
      { key: 'offers.count.few', text: 'wrong base', sourceHash: hashOf('offers.count.one') },
      { key: 'common.gone', text: 'x', sourceHash: hashOf('common.gone') },
      { key: 'unknown.key', text: 'x', sourceHash: 'whatever' },
    ]);
    expect(result).toEqual({
      written: 2,
      staleDropped: ['common.moved', 'offers.count.few', 'common.gone', 'unknown.key'],
      guarded: 0,
    });
    expect(fake.raws[0].bindings).toEqual(['ui-dictionary:ar']);
    const insert = fake.raws[1];
    expect(insert.sql).toContain('INSERT INTO ui_translations');
    expect(insert.sql).toContain('ON CONFLICT (locale, key) DO UPDATE SET');
    expect(insert.sql).toContain(
      "WHERE ui_translations.origin <> 'manual' OR ui_translations.source_hash <> excluded.source_hash",
    );
    expect(insert.bindings.filter((_: unknown, index: number) => index % 7 === 1)).toEqual([
      'common.viewAll',
      'offers.count.few',
    ]);
    expect(insert.bindings.filter((_: unknown, index: number) => index % 7 === 4)).toEqual(['ai', 'ai']);
  });

  it('reports rows the manual guard kept, refuses English, and is a no-op for zero rows', async () => {
    const { store, fake } = makeStore({ ui_catalogue: rows.map((row) => ({ ...row })) });
    fake.setRawRowCount((sql) => (sql.startsWith('INSERT') ? 1 : 0));
    await expect(
      store.writeAiTranslations('ar', [
        { key: 'common.viewAll', text: 'a', sourceHash: hashOf('common.viewAll') },
        { key: 'offers.count.one', text: 'b', sourceHash: hashOf('offers.count.one') },
      ]),
    ).resolves.toEqual({ written: 1, staleDropped: [], guarded: 1 });

    await expect(store.writeAiTranslations('en', [{ key: 'a.b', text: 'x', sourceHash: 'h' }])).rejects.toMatchObject({
      code: 'INVALID_LOCALE',
    });
    fake.raws.length = 0;
    await expect(store.writeAiTranslations('ar', [])).resolves.toEqual({ written: 0, staleDropped: [], guarded: 0 });
    expect(fake.raws).toEqual([]);
  });
});

describe('UiDictionaryStore.writeManualTranslation / deleteTranslation', () => {
  it('writes origin manual with the editor id and no merge guard', async () => {
    const { store, fake } = makeStore({ ui_catalogue: [catalogue('common.viewAll', 'View all')] });
    await expect(store.writeManualTranslation('ar', 'common.viewAll', 'عرض الكل', 42)).resolves.toEqual({
      key: 'common.viewAll',
      sourceHash: catalogueEntryHash('View all', null),
    });
    const insert = fake.raws[1];
    expect(insert.sql).not.toContain('WHERE ui_translations.origin');
    expect(insert.bindings.slice(0, 6)).toEqual([
      'ar',
      'common.viewAll',
      'عرض الكل',
      catalogueEntryHash('View all', null),
      'manual',
      42,
    ]);
    await expect(store.writeManualTranslation('ar', 'common.nope', 'x', 42)).rejects.toMatchObject({ code: 'UNKNOWN_KEY' });
    await expect(store.writeManualTranslation('ar', 'common.viewAll', ' ', 42)).rejects.toMatchObject({ code: 'INVALID_TEXT' });
    await expect(store.writeManualTranslation('en', 'common.viewAll', 'x', 42)).rejects.toMatchObject({ code: 'INVALID_LOCALE' });
  });

  it('deletes one locale row and reports whether it existed', async () => {
    const { store, fake } = makeStore({
      ui_translations: [translation('ar', 'common.viewAll', 'x'), translation('hi', 'common.viewAll', 'y')],
    });
    await expect(store.deleteTranslation('ar', 'common.viewAll')).resolves.toBe(true);
    await expect(store.deleteTranslation('ar', 'common.viewAll')).resolves.toBe(false);
    expect(fake.tables.ui_translations.map((row) => row.locale)).toEqual(['hi']);
  });
});

describe('UiDictionaryStore.publicMessages', () => {
  const home = catalogue('common.home', 'Home', {
    override_text: 'Start',
    override_updated_at: new Date('2026-09-01T10:00:00Z'),
  });
  const rows = [
    catalogue('common.viewAll', 'View all'),
    home,
    catalogue('offers.count.one', '{count} offer', { plural_of: 'offers.count' }),
    catalogue('offers.count.other', '{count} offers', { plural_of: 'offers.count' }),
    catalogue('common.gone', 'Gone', { removed_at: new Date('2026-08-01T00:00:00Z'), override_text: 'Was here' }),
  ];
  const translations = [
    translation('ar', 'common.viewAll', 'عرض الكل'),
    translation('ar', 'common.home', 'الرئيسية', { updated_at: new Date('2026-09-01T12:00:00Z') }),
    translation('ar', 'offers.count.few', '{count} عروض'),
    translation('ar', 'common.gone', 'ذهب'),
    translation('ar', 'unknown.key', 'x'),
    translation('hi', 'common.viewAll', 'सभी देखें'),
  ];

  it('serves English overrides only for en — an empty object when there are none', async () => {
    const { store } = makeStore({ ui_catalogue: rows, ui_translations: translations });
    await expect(store.publicMessages('en')).resolves.toEqual({ 'common.home': 'Start' });
    const { store: bare } = makeStore({ ui_catalogue: [catalogue('common.viewAll', 'View all')] });
    await expect(bare.publicDictionary('en')).resolves.toEqual({
      locale: 'en',
      version: null,
      updatedAt: null,
      messages: {},
    });
  });

  it('layers the locale rows (stale or not, plural expansions included) over the overrides', async () => {
    const { store } = makeStore(
      { ui_catalogue: rows, ui_translations: translations },
      { version: VERSION, pushedAt: '2026-09-01T09:00:00.000Z', counts: { total: 4, added: 4, changed: 0, removed: 0 } },
    );
    await expect(store.publicDictionary('ar')).resolves.toEqual({
      locale: 'ar',
      version: VERSION,
      updatedAt: '2026-09-01T12:00:00.000Z',
      messages: {
        'common.viewAll': 'عرض الكل',
        'common.home': 'الرئيسية',
        'offers.count.few': '{count} عروض',
      },
    });
    // A locale with fewer rows still inherits the English overrides.
    await expect(store.publicMessages('hi')).resolves.toEqual({
      'common.home': 'Start',
      'common.viewAll': 'सभी देखें',
    });
  });
});

describe('UiDictionaryStore.summary / importMessages / exportMessages', () => {
  const rows = () => [
    catalogue('common.viewAll', 'View all'),
    catalogue('common.home', 'Home', { override_text: 'Start' }),
    catalogue('common.gone', 'Gone', { removed_at: new Date('2026-08-01T00:00:00Z') }),
  ];

  it('counts per locale with the shared staleness rule and zero-fills requested locales', async () => {
    const { store } = makeStore({
      ui_catalogue: rows(),
      ui_translations: [
        translation('ar', 'common.viewAll', 'x', { source_hash: catalogueEntryHash('View all', null), origin: 'manual' }),
        translation('ar', 'common.home', 'y', { source_hash: 'old' }),
      ],
    });
    await expect(store.summary(['hi'])).resolves.toEqual({
      catalogue: { total: 2, overridden: 1, removed: 1 },
      locales: {
        ar: { translated: 2, ai: 0, manual: 1, stale: 1, missing: 0 },
        hi: { translated: 0, ai: 0, manual: 0, stale: 0, missing: 2 },
      },
    });
  });

  it('imports manual rows for a locale, skipping unknown keys and bad text', async () => {
    const { store, fake } = makeStore({ ui_catalogue: rows() });
    await expect(
      store.importMessages('ar', { 'common.viewAll': 'عرض الكل', 'common.nope': 'x', 'common.home': '', 'common.gone': 'x' }, 3),
    ).resolves.toEqual({
      written: 1,
      skipped: [
        { key: 'common.gone', reason: 'key is not in the catalogue' },
        { key: 'common.home', reason: 'text must be a non-empty string' },
        { key: 'common.nope', reason: 'key is not in the catalogue' },
      ],
    });
    expect(fake.raws[0].bindings).toEqual(['ui-dictionary:ar']);
    expect(fake.raws[1].bindings.slice(0, 6)).toEqual([
      'ar',
      'common.viewAll',
      'عرض الكل',
      catalogueEntryHash('View all', null),
      'manual',
      3,
    ]);
  });

  it('imports English as overrides and exports effective English / stored translations', async () => {
    const { store, fake } = makeStore({
      ui_catalogue: rows(),
      ui_translations: [translation('ar', 'common.viewAll', 'عرض الكل')],
    });
    await expect(store.importMessages('en', { 'common.viewAll': 'See all', 'common.home': 'Home' }, 3)).resolves.toEqual({
      written: 2,
      skipped: [],
    });
    const byKey = Object.fromEntries(fake.tables.ui_catalogue.map((row) => [row.key, row]));
    expect(byKey['common.viewAll'].override_text).toBe('See all');
    // Importing the pushed text clears the override instead of storing a copy.
    expect(byKey['common.home'].override_text).toBeNull();
    await expect(store.exportMessages('en')).resolves.toEqual({ 'common.home': 'Home', 'common.viewAll': 'See all' });
    await expect(store.exportMessages('ar')).resolves.toEqual({ 'common.viewAll': 'عرض الكل' });
  });
});
