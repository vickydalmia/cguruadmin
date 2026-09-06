import { describe, expect, it, vi } from 'vitest';

vi.mock('./translation-hot-apply', () => ({
  applyTranslationSettings: vi.fn(async () => ({ ok: true, outbox: 'env-missing' })),
}));
vi.mock('./feature-readiness', () => ({
  getFeatureReadiness: vi.fn(async () => ({})),
}));

import { INDIA_DEFAULT_CONFIGURATION } from './country-registry';
import serviceFactory, {
  siteLanguages,
  validateSiteConfigurationForWrite,
} from './site-configuration';
import { applyTranslationSettings } from './translation-hot-apply';

const usStrapi = () => {
  const findFirst = vi.fn(async () => ({
    ...INDIA_DEFAULT_CONFIGURATION,
    countryCode: 'US',
    locale: 'en-US',
    currencyCode: 'USD',
    timezone: 'America/New_York',
    aboutEnabled: false,
  }));
  const documents = vi.fn(() => ({ findFirst }));
  return { strapi: { documents } as any, documents };
};

const uaeConfig = {
  ...INDIA_DEFAULT_CONFIGURATION,
  countryName: 'United Arab Emirates',
  countryCode: 'AE',
  locale: 'en-AE',
  currencyCode: 'AED',
  timezone: 'Asia/Dubai',
};

async function problemsOf(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise;
  } catch (error: any) {
    return error?.details?.problems ?? [error?.message ?? String(error)];
  }
  throw new Error('expected the write to be rejected');
}

describe('site configuration writes', () => {
  it('allows an incomplete feature to be enabled for authoring', async () => {
    const { strapi, documents } = usStrapi();

    const result = await validateSiteConfigurationForWrite(
      strapi,
      { aboutEnabled: true },
    );

    expect(result.aboutEnabled).toBe(true);
    // Readiness is a public-live gate, not a Country Setup write gate. The
    // validator therefore has no reason to query the missing About singleton.
    expect(documents).toHaveBeenCalledTimes(1);
    expect(documents).toHaveBeenCalledWith(
      'api::site-configuration.site-configuration',
    );
  });

  it('accepts any ICU-resolvable ISO 639-1 language as a target', async () => {
    const { strapi } = usStrapi();
    const result = await validateSiteConfigurationForWrite(strapi, {
      translationEnabled: true,
      translationLocales: 'hi, AR',
    });
    expect(result.translationLocales).toBe('hi,ar');
  });

  it('rejects codes ICU cannot name, naming the ISO 639-1 rule', async () => {
    const { strapi } = usStrapi();
    const problems = await problemsOf(
      validateSiteConfigurationForWrite(strapi, {
        translationEnabled: true,
        translationLocales: 'hi,zz',
      }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^translationLocales: /);
    expect(problems[0]).toContain('zz');
    expect(problems[0]).not.toContain('hi,');
    expect(problems[0]).toContain('ISO 639-1');
  });

  it('rejects English as a translation target', async () => {
    const { strapi } = usStrapi();
    const problems = await problemsOf(
      validateSiteConfigurationForWrite(strapi, {
        translationEnabled: true,
        translationLocales: 'en,ar',
      }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Unsupported translation locale(s): en.');
    expect(problems[0]).toContain('"en" is the source language');
  });

  it('still requires at least one target when translation is on', async () => {
    const { strapi } = usStrapi();
    const problems = await problemsOf(
      validateSiteConfigurationForWrite(strapi, {
        translationEnabled: true,
        translationLocales: '',
      }),
    );
    expect(problems[0]).toContain('no target locales are listed');
  });
});

describe('siteLanguages', () => {
  it('returns only the English row when translation is off (India/USA unchanged)', () => {
    expect(siteLanguages(INDIA_DEFAULT_CONFIGURATION)).toEqual([
      {
        code: 'en',
        name: 'English',
        nativeName: 'English',
        dir: 'ltr',
        ogLocale: null,
        default: true,
        pathPrefix: '',
      },
    ]);
    expect(
      siteLanguages({ ...INDIA_DEFAULT_CONFIGURATION, translationLocales: 'ar' }),
    ).toHaveLength(1);
  });

  it('resolves every enabled language against the site country', () => {
    expect(
      siteLanguages({
        ...uaeConfig,
        translationEnabled: true,
        translationLocales: 'ar,hi',
      }),
    ).toEqual([
      {
        code: 'en',
        name: 'English',
        nativeName: 'English',
        dir: 'ltr',
        ogLocale: null,
        default: true,
        pathPrefix: '',
      },
      {
        code: 'ar',
        name: 'Arabic',
        nativeName: 'العربية',
        dir: 'rtl',
        ogLocale: 'ar_AE',
        default: false,
        pathPrefix: '/ar',
      },
      {
        code: 'hi',
        name: 'Hindi',
        nativeName: 'हिन्दी',
        dir: 'ltr',
        ogLocale: 'hi_AE',
        default: false,
        pathPrefix: '/hi',
      },
    ]);
  });

  it('drops a stored code that no longer resolves instead of inventing a row', () => {
    const languages = siteLanguages({
      ...uaeConfig,
      translationEnabled: true,
      translationLocales: 'zz,ar',
    });
    expect(languages.map((language) => language.code)).toEqual(['en', 'ar']);
  });
});

describe('update() hot-apply', () => {
  function writableStrapi() {
    const order: string[] = [];
    let persisted = { ...uaeConfig, documentId: 'cfg-1' };
    const findFirst = vi.fn(async () => persisted);
    const findOne = vi.fn(async () => persisted);
    const update = vi.fn(async ({ data }) => {
      persisted = { ...persisted, ...data };
      order.push('write');
    });
    const create = vi.fn(async () => {
      order.push('create');
    });
    vi.mocked(applyTranslationSettings).mockImplementation(async () => {
      order.push('hot-apply');
      return { ok: true, outbox: 'started' };
    });
    const strapi = {
      documents: vi.fn(() => ({ findFirst, findOne, update, create })),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any;
    return { strapi, order, update, create };
  }

  it('applies the translation settings to this process AFTER the row is written', async () => {
    const { strapi, order, update } = writableStrapi();
    const result = await serviceFactory({ strapi }).update({
      translationEnabled: true,
      translationLocales: 'ar,hi',
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['write', 'hot-apply']);
    expect(applyTranslationSettings).toHaveBeenCalledWith(strapi);
    expect(result.languages.map((language: any) => language.code)).toEqual(['en', 'ar', 'hi']);
  });

  it('does not hot-apply when validation rejects the write', async () => {
    const { strapi, update } = writableStrapi();
    await expect(
      serviceFactory({ strapi }).update({ translationEnabled: true, translationLocales: 'zz' }),
    ).rejects.toBeTruthy();
    expect(update).not.toHaveBeenCalled();
    expect(applyTranslationSettings).not.toHaveBeenCalled();
  });

  it('still returns the saved settings when hot-apply reports a failure', async () => {
    const { strapi } = writableStrapi();
    vi.mocked(applyTranslationSettings).mockResolvedValueOnce({ ok: false, error: 'i18n down' });
    const result = await serviceFactory({ strapi }).update({ translationEnabled: false });
    expect(result.translationEnabled).toBe(false);
  });
});

describe('public vs admin settings bodies', () => {
  function strapiWith(config: Record<string, unknown>) {
    const findFirst = vi.fn(async () => config);
    return { documents: vi.fn(() => ({ findFirst })), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as any;
  }
  const translated = { ...uaeConfig, translationEnabled: true, translationLocales: 'ar', offerCountries: 'AE,SA' };

  it('keeps the raw Country Setup inputs off the anonymous body but on the admin body', async () => {
    const service = serviceFactory({ strapi: strapiWith(translated) });
    const publicBody: any = await service.publicSettings();
    expect(publicBody).not.toHaveProperty('translationEnabled');
    expect(publicBody).not.toHaveProperty('translationLocales');
    expect(publicBody).not.toHaveProperty('offerCountries');
    // The derived views the storefront and deploy tooling consume stay.
    expect(publicBody.countryCode).toBe('AE');
    expect(publicBody.languages.map((language: any) => language.code)).toEqual(['en', 'ar']);
    expect(publicBody.offerCountryOptions.map((option: any) => option.code)).toEqual(['AE', 'SA']);
    expect(publicBody).toHaveProperty('configurationRevision');

    const adminBody: any = await service.adminSettings();
    expect(adminBody).toMatchObject({ translationEnabled: true, translationLocales: 'ar', offerCountries: 'AE,SA' });
    expect(adminBody.languages).toEqual(publicBody.languages);
  });
});
