import { describe, expect, it } from 'vitest';
import {
  REDIRECT_MAX_HOPS,
  classifyTarget,
  isRedirectUid,
  isWireSafeFromPath,
  normalizeRedirectPath,
  redirectKey,
  validateRedirect,
} from './redirect-validation';

const UID = 'api::redirect.redirect';

type EntityRow = { name: string; slug: string };
type RedirectRow = { documentId: string; from: string; to: string; active?: boolean };

type Seed = {
  stores?: EntityRow[];
  brands?: EntityRow[];
  categories?: EntityRow[];
  banks?: EntityRow[];
  redirects?: RedirectRow[];
  storedRedirect?: Record<string, unknown> | null;
  // Overrides the active-redirect COUNT (guard 2b) without seeding thousands of
  // rows; defaults to the number of active `redirects`.
  activeRedirectCount?: number;
};

const ENTITY_UIDS = {
  'api::store.store': 'stores',
  'api::brand.brand': 'brands',
  'api::category.category': 'categories',
  'api::bank.bank': 'banks',
} as const;

// Minimal stand-in for the document service. `$eqi` is matched case-
// insensitively, exactly as Postgres does, so a test that relies on folded
// matching is actually exercising folded matching.
function makeStrapi(seed: Seed) {
  const queries: string[] = [];

  const strapi = {
    documents(uid: string) {
      return {
        async findMany(params: any) {
          queries.push(uid);

          if (uid === UID) {
            return (seed.redirects ?? [])
              .filter((row) => row.active !== false)
              .map((row) => ({ ...row }));
          }

          const key = ENTITY_UIDS[uid as keyof typeof ENTITY_UIDS];
          const rows = key ? (seed[key] ?? []) : [];
          if (!params?.filters?.$or) {
            const start = Number(params?.start) || 0;
            const limit = Number(params?.limit) || rows.length;
            return rows.slice(start, start + limit);
          }
          const wanted: string[] = (params?.filters?.$or ?? []).map(
            (clause: any) => String(clause.slug.$eqi).toLowerCase(),
          );
          return rows.filter((row) => wanted.includes(row.slug.toLowerCase()));
        },
        async findOne() {
          queries.push(`${uid}:findOne`);
          return seed.storedRedirect ?? null;
        },
        async count() {
          queries.push(`${uid}:count`);
          if (uid === UID) {
            return (
              seed.activeRedirectCount ??
              (seed.redirects ?? []).filter((row) => row.active !== false).length
            );
          }
          return 0;
        },
      };
    },
  } as any;

  return { strapi, queries };
}

async function expectRejection(
  seed: Seed,
  data: Record<string, unknown>,
  options: { action?: string; documentId?: string; strict?: boolean } = {},
): Promise<{ message: string; paths: string[] }> {
  const { strapi } = makeStrapi(seed);
  try {
    await validateRedirect(
      strapi,
      UID,
      options.action ?? 'create',
      data,
      options.documentId,
      options.strict ?? false,
    );
  } catch (error: any) {
    return {
      message: String(error?.message ?? ''),
      paths: (error?.details?.errors ?? []).flatMap((entry: any) => entry.path),
    };
  }
  throw new Error('expected validateRedirect to reject, but it resolved');
}

async function expectAccepted(
  seed: Seed,
  data: Record<string, unknown>,
  options: { action?: string; documentId?: string; strict?: boolean } = {},
): Promise<void> {
  const { strapi } = makeStrapi(seed);
  await validateRedirect(
    strapi,
    UID,
    options.action ?? 'create',
    data,
    options.documentId,
    options.strict ?? false,
  );
}

describe('normalizeRedirectPath', () => {
  it('collapses the forms that all name the same request path', () => {
    expect(normalizeRedirectPath('/winter-sale')).toBe('/winter-sale');
    expect(normalizeRedirectPath('/winter-sale/')).toBe('/winter-sale');
    expect(normalizeRedirectPath('  /winter-sale  ')).toBe('/winter-sale');
    expect(normalizeRedirectPath('winter-sale')).toBe('/winter-sale');
    expect(normalizeRedirectPath('/winter-sale?utm_source=x')).toBe('/winter-sale');
    expect(normalizeRedirectPath('/winter-sale#top')).toBe('/winter-sale');
    expect(normalizeRedirectPath('//winter//sale//')).toBe('/winter/sale');
  });

  it('keeps the site root addressable and returns empty for non-strings', () => {
    expect(normalizeRedirectPath('/')).toBe('/');
    expect(normalizeRedirectPath('')).toBe('');
    expect(normalizeRedirectPath(undefined)).toBe('');
    expect(normalizeRedirectPath(null)).toBe('');
    expect(normalizeRedirectPath(42)).toBe('');
  });

  it('folds casing only in the matching key, not in the stored path', () => {
    expect(normalizeRedirectPath('/Winter-Sale')).toBe('/Winter-Sale');
    expect(redirectKey('/Winter-Sale/')).toBe('/winter-sale');
  });
});

describe('redirectKey — unicode and percent-encoding', () => {
  // The middleware passes the request path in WIRE form (percent-encoded),
  // while editors author `from` in whichever form they pasted. These MUST
  // agree byte for byte with redirectKey in
  // cguru-ui/src/features/routing/api/get-redirects.ts.
  it('folds a unicode from and its percent-encoded wire form to one key', () => {
    expect(redirectKey('/café')).toBe(redirectKey('/caf%C3%A9'));
    expect(redirectKey('/CAFÉ')).toBe(redirectKey('/caf%c3%a9'));
    expect(redirectKey('/CAF%C3%89')).toBe(redirectKey('/café'));
  });

  it('leaves a malformed percent sequence as ordinary bytes instead of throwing', () => {
    expect(() => redirectKey('/legacy%zz')).not.toThrow();
    expect(redirectKey('/legacy%zz')).toBe('/legacy%zz');
    expect(() => redirectKey('/lone%c3')).not.toThrow();
  });

  // ASCII escapes stay authored: %2F as a path byte is data, not a segment
  // separator, and the schema regex forbids a literal space anyway.
  it('does not decode ASCII escapes', () => {
    expect(redirectKey('/retired%2Foffer')).not.toBe(redirectKey('/retired/offer'));
    expect(redirectKey('/old%20page')).not.toBe(redirectKey('/old page'));
  });
});

describe('classifyTarget', () => {
  it('accepts internal paths and absolute http(s) URLs', () => {
    expect(classifyTarget('/nike/')).toMatchObject({ kind: 'internal', path: '/nike' });
    expect(classifyTarget('/search?q=nike')).toMatchObject({
      kind: 'internal',
      path: '/search',
      raw: '/search?q=nike',
    });
    expect(classifyTarget('https://partner.example/offer')).toMatchObject({
      kind: 'external',
    });
  });

  // An editor typing "//partner.example" means "the partner site" but writes
  // something that looks like a path. Browsers treat it as off-site.
  it('rejects a protocol-relative target as the open redirect it is', () => {
    const result = classifyTarget('//partner.example/offer');
    expect(result.kind).toBe('invalid');
    expect(result.kind === 'invalid' && result.reason).toContain('ANOTHER');
  });

  // WHATWG URL parsing folds "\" to "/" in http(s) contexts, so a target of
  // "/\evil.example" resolves to https://evil.example/ — an off-site redirect
  // spelled so it slips past the "//" check.
  it('rejects a backslash target as the open redirect it becomes', () => {
    for (const value of ['/\\evil.example', '\\/evil.example', '/\\/\\evil.example']) {
      const result = classifyTarget(value);
      expect(result.kind).toBe('invalid');
      expect(result.kind === 'invalid' && result.reason).toContain('backslash');
      expect(result.kind === 'invalid' && result.reason).toContain('DIFFERENT site');
    }
  });

  it('rejects header-splitting and unroutable targets', () => {
    expect(classifyTarget('/ok\r\nX-Injected: 1').kind).toBe('invalid');
    expect(classifyTarget('javascript:alert(1)').kind).toBe('invalid');
    expect(classifyTarget('nike').kind).toBe('invalid');
    expect(classifyTarget('').kind).toBe('invalid');
    expect(classifyTarget(undefined).kind).toBe('invalid');
  });
});

describe('validateRedirect — scope', () => {
  it('ignores every other content type', async () => {
    const { strapi, queries } = makeStrapi({});
    await validateRedirect(strapi, 'api::store.store', 'update', { from: '/x' }, 'd1');
    expect(queries).toEqual([]);
  });

  it('exports a uid predicate matching only the redirect type', () => {
    expect(isRedirectUid(UID)).toBe(true);
    expect(isRedirectUid('api::store.store')).toBe(false);
  });

  // Rule 4: partial payloads. A note-only or statusCode-only edit must not
  // read anything, so it can never fail on a value the editor did not touch.
  it('returns before any query when the payload touches no routing field', async () => {
    const { strapi, queries } = makeStrapi({
      stores: [{ name: 'Nike', slug: 'nike' }],
      storedRedirect: { documentId: 'd1', from: '/nike', to: '/x', active: true },
    });
    await validateRedirect(strapi, UID, 'update', { note: 'checked with SEO' }, 'd1');
    await validateRedirect(strapi, UID, 'update', { statusCode: 302 }, 'd1');
    expect(queries).toEqual([]);
  });
});

describe('validateRedirect — guard 1: self redirect', () => {
  it('rejects from === to after normalisation', async () => {
    const result = await expectRejection({}, { from: '/winter-sale', to: '/winter-sale/' });
    expect(result.paths).toContain('to');
    expect(result.message).toContain('redirects the URL to itself');
  });

  it('rejects a self redirect that differs only in casing or query string', async () => {
    const cased = await expectRejection({}, { from: '/Winter-Sale', to: '/winter-sale' });
    expect(cased.message).toContain('itself');

    const queried = await expectRejection({}, { from: '/winter-sale', to: '/winter-sale?utm=1' });
    expect(queried.message).toContain('itself');
  });

  it('allows a genuinely different destination', async () => {
    await expectAccepted({}, { from: '/winter-sale', to: '/sale' });
  });
});

describe('validateRedirect — guard 2: shadowing a live page', () => {
  const LIVE: Seed = {
    stores: [{ name: 'Amazon', slug: 'Amazon-Coupons' }],
    brands: [{ name: 'Nike', slug: 'nike' }],
    categories: [{ name: 'Mobile Recharge', slug: 'categories/mobile-recharge' }],
  };

  it('rejects a redirect whose from is a live entity slug', async () => {
    const result = await expectRejection(LIVE, { from: '/nike', to: '/sale' });
    expect(result.paths).toContain('from');
    expect(result.message).toContain('live page of the brand "Nike"');
  });

  it('rejects a redirect whose from is a generated entity Deal-page slug', async () => {
    const result = await expectRejection({
      categories: [{ name: 'Mobile', slug: 'mobile' }],
    }, {
      from: '/mobile-deals/',
      to: '/offers/',
      active: true,
    });

    expect(result.paths).toContain('from');
    expect(result.message).toContain(
      'generated Product Deal page of the category "Mobile"',
    );
  });

  // The whole point of the guard: the collision is invisible to every other
  // part of the stack, so a casing or namespace difference must not slip past.
  it('catches a live slug stored with different casing', async () => {
    const result = await expectRejection(LIVE, { from: '/amazon-coupons/', to: '/sale' });
    expect(result.message).toContain('Amazon');
  });

  it('catches a live slug stored behind its type namespace', async () => {
    const result = await expectRejection(LIVE, { from: '/mobile-recharge', to: '/sale' });
    expect(result.message).toContain('Mobile Recharge');
    expect(result.message).toContain('stored as "categories/mobile-recharge"');
  });

  it('rejects a redirect that shadows a reserved Astro page', async () => {
    const result = await expectRejection(LIVE, { from: '/search', to: '/' });
    expect(result.paths).toContain('from');
    expect(result.message).toContain('the search page');
  });

  it('rejects a redirect that claims the internal API namespace', async () => {
    const result = await expectRejection(LIVE, {
      from: '/api/route-inventory.json',
      to: '/',
    });
    expect(result.paths).toContain('from');
    expect(result.message).toContain('internal API namespace');
  });

  it('rejects a reserved page regardless of request-path casing', async () => {
    const result = await expectRejection(LIVE, { from: '/SEARCH/', to: '/' });
    expect(result.paths).toContain('from');
    expect(result.message).toContain('the search page');
  });

  it('allows a retired URL that matches nothing live', async () => {
    await expectAccepted(LIVE, { from: '/old-nike-offers', to: '/nike/' });
  });

  // #2: the site root is always a live, durable page. It has no path segment for
  // the reserved/entity lookups, so it is rejected explicitly.
  it('rejects a redirect from the site root "/"', async () => {
    const result = await expectRejection(LIVE, { from: '/', to: '/sale' });
    expect(result.paths).toContain('from');
    expect(result.message).toContain('home page');
  });

  // #9: an active create/activation is refused once the table is at the cap, so
  // a rule can never be saved-but-never-run.
  it('rejects a new active redirect once the table is at the cap', async () => {
    const result = await expectRejection(
      { ...LIVE, activeRedirectCount: 2000 },
      { from: '/old-thing', to: '/sale' },
    );
    expect(result.paths).toContain('active');
    expect(result.message).toContain('2,000');
  });

  it('allows a new active redirect while below the cap', async () => {
    await expectAccepted(
      { ...LIVE, activeRedirectCount: 1999 },
      { from: '/old-thing', to: '/sale' },
    );
  });

  it('does not run the live check for an inactive row', async () => {
    const { strapi, queries } = makeStrapi(LIVE);
    await validateRedirect(strapi, UID, 'create', {
      from: '/nike',
      to: '/sale',
      active: false,
    });
    expect(queries).toEqual([]);
  });

  // Grandfathering: the row was legal when written and an entity later took
  // the slug. Editing an unrelated field must still save.
  it('does not block an unrelated edit to a row that has gone stale', async () => {
    await expectAccepted(
      { ...LIVE, storedRedirect: { documentId: 'd1', from: '/nike', to: '/sale', active: true } },
      { to: '/sale-2' },
      { action: 'update', documentId: 'd1' },
    );
  });

  // ...but switching a stale row back ON is a deliberate act, and it is the
  // moment the shadowing starts, so it is re-checked.
  it('re-checks when an inactive shadowing row is switched on', async () => {
    const result = await expectRejection(
      { ...LIVE, storedRedirect: { documentId: 'd1', from: '/nike', to: '/sale', active: false } },
      { active: true },
      { action: 'update', documentId: 'd1' },
    );
    expect(result.message).toContain('live page of the brand "Nike"');
  });
});

describe('validateRedirect — guard 3: cycles', () => {
  it('rejects a two-row loop', async () => {
    const result = await expectRejection(
      { redirects: [{ documentId: 'a', from: '/b', to: '/a' }] },
      { from: '/a', to: '/b' },
    );
    expect(result.paths).toContain('to');
    expect(result.message).toContain('closes a redirect loop');
    expect(result.message).toContain('/a → /b → /a');
  });

  it('rejects a three-row loop no single row reveals', async () => {
    const result = await expectRejection(
      {
        redirects: [
          { documentId: 'a', from: '/b', to: '/c' },
          { documentId: 'b', from: '/c', to: '/a' },
        ],
      },
      { from: '/a', to: '/b' },
    );
    expect(result.message).toContain('closes a redirect loop');
  });

  it('detects a loop across differing casing and trailing slashes', async () => {
    const result = await expectRejection(
      { redirects: [{ documentId: 'a', from: '/B/', to: '/A' }] },
      { from: '/a', to: '/b' },
    );
    expect(result.message).toContain('loop');
  });

  it('accepts a chain that terminates on a real page', async () => {
    await expectAccepted(
      {
        redirects: [
          { documentId: 'a', from: '/b', to: '/c' },
          { documentId: 'b', from: '/c', to: '/final' },
        ],
      },
      { from: '/a', to: '/b' },
    );
  });

  it('accepts a chain that terminates on an external URL', async () => {
    await expectAccepted(
      { redirects: [{ documentId: 'a', from: '/b', to: 'https://partner.example/' }] },
      { from: '/a', to: '/b' },
    );
  });

  // Anything the frontend resolver cannot follow to the end would strand the
  // visitor on an intermediate hop, so the two limits are kept identical.
  it(`rejects a chain deeper than the resolver's ${REDIRECT_MAX_HOPS} hops`, async () => {
    // REDIRECT_MAX_HOPS stored edges + the pending one = the first chain the
    // resolver cannot finish, so this pins the exact boundary.
    const redirects = Array.from({ length: REDIRECT_MAX_HOPS }, (_, index) => ({
      documentId: `r${index}`,
      from: `/h${index}`,
      to: `/h${index + 1}`,
    }));
    const result = await expectRejection({ redirects }, { from: '/start', to: '/h0' });
    expect(result.message).toContain('longer than');
  });

  it(`accepts a chain exactly ${REDIRECT_MAX_HOPS} hops long`, async () => {
    const redirects = Array.from({ length: REDIRECT_MAX_HOPS - 1 }, (_, index) => ({
      documentId: `r${index}`,
      from: `/h${index}`,
      to: `/h${index + 1}`,
    }));
    await expectAccepted({ redirects }, { from: '/start', to: '/h0' });
  });

  // Editing a row must compare against the graph WITHOUT its own stored edge,
  // otherwise every save would report the row looping with its former self.
  it('excludes the row being edited from the graph', async () => {
    await expectAccepted(
      {
        redirects: [{ documentId: 'd1', from: '/a', to: '/b' }],
        storedRedirect: { documentId: 'd1', from: '/a', to: '/b', active: true },
      },
      { to: '/c' },
      { action: 'update', documentId: 'd1' },
    );
  });

  it('ignores inactive rows when walking the graph', async () => {
    await expectAccepted(
      { redirects: [{ documentId: 'a', from: '/b', to: '/a', active: false }] },
      { from: '/a', to: '/b' },
    );
  });

  // The graph walk and the frontend resolver must agree that /café and
  // /caf%C3%A9 are the same URL, or a chain proved acyclic here could still
  // loop at read time.
  it('detects a loop across unicode and percent-encoded spellings', async () => {
    const result = await expectRejection(
      { redirects: [{ documentId: 'a', from: '/café', to: '/a' }] },
      { from: '/a', to: '/caf%C3%A9' },
    );
    expect(result.message).toContain('loop');
  });
});

describe('validateRedirect — duplicate from', () => {
  it('rejects a second active rule for the same URL, folded', async () => {
    const result = await expectRejection(
      { redirects: [{ documentId: 'a', from: '/Winter-Sale', to: '/sale' }] },
      { from: '/winter-sale/', to: '/other' },
    );
    expect(result.paths).toContain('from');
    expect(result.message).toContain('Another active redirect already sends');
  });

  it('keeps the source rule in duplicate checks for an empty active clone', async () => {
    const source = {
      documentId: 'a',
      from: '/winter-sale',
      to: '/sale',
      active: true,
    };
    const result = await expectRejection(
      {
        redirects: [source],
        storedRedirect: source,
      },
      {},
      { action: 'clone', documentId: 'a' },
    );
    expect(result.paths).toContain('from');
    expect(result.message).toContain('Another active redirect already sends');
  });

  it('accepts a clone when its route override is unique', async () => {
    const source = {
      documentId: 'a',
      from: '/winter-sale',
      to: '/sale',
      active: true,
    };
    await expectAccepted(
      {
        redirects: [source],
        storedRedirect: source,
      },
      { from: '/winter-sale-archive' },
      { action: 'clone', documentId: 'a' },
    );
  });

  it('detects a duplicate across unicode and percent-encoded spellings', async () => {
    const result = await expectRejection(
      { redirects: [{ documentId: 'a', from: '/café', to: '/coffee' }] },
      { from: '/caf%C3%A9', to: '/other' },
    );
    expect(result.paths).toContain('from');
    expect(result.message).toContain('Another active redirect already sends');
  });

  // A legacy row whose `from` case-folds onto another active row slipped past
  // the byte-exact unique index. The editor fixing its `to` never touched
  // `from`, so the duplicate must not block the save — blocking it would also
  // block ever repairing the row.
  it('allows a to-only edit on a row whose from case-folds onto another active row', async () => {
    await expectAccepted(
      {
        redirects: [{ documentId: 'other', from: '/Legacy-Sale', to: '/sale' }],
        storedRedirect: { documentId: 'd1', from: '/legacy-sale', to: '/old', active: true },
      },
      { to: '/new-sale' },
      { action: 'update', documentId: 'd1' },
    );
  });

  // ...but a changed `to` can genuinely close a NEW cycle, so the cycle walk
  // still re-arms on a to-only edit.
  it('still rejects a to-only edit that closes a cycle', async () => {
    const result = await expectRejection(
      {
        redirects: [{ documentId: 'other', from: '/b', to: '/a' }],
        storedRedirect: { documentId: 'd1', from: '/a', to: '/old', active: true },
      },
      { to: '/b' },
      { action: 'update', documentId: 'd1' },
    );
    expect(result.paths).toContain('to');
    expect(result.message).toContain('closes a redirect loop');
  });

  // Switching a duplicating row ON is a deliberate act on the row, so the
  // duplicate check still re-arms even though `from` is untouched.
  it('still rejects activating a row whose from duplicates another active row', async () => {
    const result = await expectRejection(
      {
        redirects: [{ documentId: 'other', from: '/Legacy-Sale', to: '/sale' }],
        storedRedirect: { documentId: 'd1', from: '/legacy-sale', to: '/old', active: false },
      },
      { active: true },
      { action: 'update', documentId: 'd1' },
    );
    expect(result.paths).toContain('from');
    expect(result.message).toContain('Another active redirect already sends');
  });
});

describe('isWireSafeFromPath (F5)', () => {
  it('accepts unreserved characters and already-percent-encoded bytes', () => {
    for (const path of ['/mens-sale', '/caf%C3%A9', '/a/b-c.d', '/', '/x%2Fy']) {
      expect(isWireSafeFromPath(path)).toBe(true);
    }
  });

  it('rejects raw characters a browser would percent-encode', () => {
    for (const path of ["/men's", '/win (2024)', '/a,b', '/old page', '/café']) {
      expect(isWireSafeFromPath(path)).toBe(false);
    }
  });
});

describe('validateRedirect — from wire-safety (F5)', () => {
  // The classic failure: an authored /men's never matches the request /men%27s
  // because the fold leaves the ASCII apostrophe raw. Reject it at write time
  // with a message that points the editor at the encoded form.
  it("rejects a from with a raw apostrophe and names the encoded form", async () => {
    const result = await expectRejection({}, { from: "/men's", to: '/mens-sale/' });
    expect(result.paths).toContain('from');
    expect(result.message).toContain('percent-encoded');
    expect(result.message).toContain('%27');
  });

  it('rejects a from with raw parentheses, a comma or a space', async () => {
    for (const from of ['/win (2024)', '/a,b', '/old page']) {
      const result = await expectRejection({}, { from, to: '/sale/' });
      expect(result.paths).toContain('from');
    }
  });

  it('rejects a raw unicode from and points at the encoded spelling', async () => {
    const result = await expectRejection({}, { from: '/café', to: '/coffee/' });
    expect(result.paths).toContain('from');
    expect(result.message).toContain('%C3%A9');
  });

  it('accepts the percent-encoded spelling of the same paths', async () => {
    await expectAccepted({}, { from: '/men%27s', to: '/mens-sale/' });
    await expectAccepted({}, { from: '/caf%C3%A9', to: '/coffee/' });
  });

  it('does not re-check wire-safety on an unrelated edit to a stale row', async () => {
    // Grandfathering: a legacy row whose stored `from` is not wire-safe must
    // still accept an unrelated edit, exactly like the other from-guards.
    await expectAccepted(
      { storedRedirect: { documentId: 'd1', from: "/men's", to: '/sale', active: true } },
      { note: 'checked' },
      { action: 'update', documentId: 'd1' },
    );
  });
});

describe('validateRedirect — asset sources', () => {
  // The ISR gateway serves static assets before the redirect table is
  // consulted, so a rule from an asset path validates but never fires.
  it('rejects a from that is an unambiguous asset path', async () => {
    for (const from of ['/favicon.ico', '/_astro/app.css', '/images/logo.PNG', '/fonts/inter.woff2']) {
      const result = await expectRejection({}, { from, to: '/sale/' });
      expect(result.paths).toContain('from');
      expect(result.message).toContain('never run');
    }
  });

  // WordPress-migrated legacy page URLs keep document-ish extensions; those
  // are real redirect sources and must keep saving.
  it('accepts legacy document-style sources (.html and friends)', async () => {
    await expectAccepted({}, { from: '/legacy-page.html', to: '/new-page/' });
    await expectAccepted({}, { from: '/feed.xml', to: '/deals/' });
    await expectAccepted({}, { from: '/old-notes.txt', to: '/about-us-archive/' });
  });

  it('does not re-check an untouched stored asset from on an unrelated edit', async () => {
    // Grandfathering, same as the other from-guards: a legacy asset row must
    // still accept a note-only edit.
    await expectAccepted(
      { storedRedirect: { documentId: 'd1', from: '/favicon.ico', to: '/sale', active: true } },
      { note: 'checked' },
      { action: 'update', documentId: 'd1' },
    );
  });
});

describe('validateRedirect — target format', () => {
  it('rejects an invalid to when to is the field being written', async () => {
    const result = await expectRejection({}, { from: '/a', to: '//partner.example' });
    expect(result.paths).toContain('to');
  });

  // Grandfathering: an unusable stored `to` must not block a `from` fix.
  it('does not report a stored invalid to when only from changes', async () => {
    await expectAccepted(
      { storedRedirect: { documentId: 'd1', from: '/a', to: 'nonsense', active: true } },
      { from: '/b' },
      { action: 'update', documentId: 'd1' },
    );
  });

  it('rejects a from that is not a path', async () => {
    const result = await expectRejection({}, { from: '   ', to: '/a' });
    expect(result.paths).toContain('from');
  });
});

describe('validateRedirect — strict ("clean as you touch") mode', () => {
  // Under strict every guard runs against the whole effective (merged) record,
  // so a note-only human edit on a legacy row whose UNTOUCHED `from`/`to` is now
  // dirty is blocked until the record is clean. Under non-strict the same edit
  // early-returns (the cron/programmatic path), exactly as today.

  const LIVE_STORED = {
    brands: [{ name: 'Nike', slug: 'nike' }],
    storedRedirect: { documentId: 'd1', from: '/nike', to: '/sale', active: true },
  } as const;

  it('blocks a note-only edit when the untouched stored from now shadows a live page', async () => {
    const result = await expectRejection(
      { ...LIVE_STORED },
      { note: 'checked' },
      { action: 'update', documentId: 'd1', strict: true },
    );
    expect(result.paths).toContain('from');
    expect(result.message).toContain('live page of the brand "Nike"');
  });

  it('non-strict returns before any query for the same note-only edit', async () => {
    const { strapi, queries } = makeStrapi({ ...LIVE_STORED });
    await validateRedirect(
      strapi,
      UID,
      'update',
      { note: 'checked' },
      'd1',
      false,
    );
    expect(queries).toEqual([]);
  });

  it('blocks a note-only edit when the untouched stored to is invalid', async () => {
    const result = await expectRejection(
      { storedRedirect: { documentId: 'd1', from: '/a', to: 'nonsense', active: true } },
      { note: 'checked' },
      { action: 'update', documentId: 'd1', strict: true },
    );
    expect(result.paths).toContain('to');
  });

  it('non-strict grandfathers the same untouched invalid stored to', async () => {
    await expectAccepted(
      { storedRedirect: { documentId: 'd1', from: '/a', to: 'nonsense', active: true } },
      { note: 'checked' },
      { action: 'update', documentId: 'd1', strict: false },
    );
  });

  it('strict still accepts a note-only edit on an already-clean row', async () => {
    await expectAccepted(
      { storedRedirect: { documentId: 'd1', from: '/retired', to: '/live', active: true } },
      { note: 'checked' },
      { action: 'update', documentId: 'd1', strict: true },
    );
  });
});
