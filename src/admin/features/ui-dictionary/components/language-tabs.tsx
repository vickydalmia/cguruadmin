// English + one tab per enabled language, each with a small count badge:
// overrides for English, missing/out-of-date for a target language.
import * as React from 'react';
import { Badge, Flex, Tabs, Typography } from '@strapi/design-system';

import { ENGLISH_CODE, type UiDictionaryStatus, type UiLanguage } from '../types';

function tabCount(status: UiDictionaryStatus | null, code: string): { label: string; alert: boolean } | null {
  if (!status) return null;
  if (code === ENGLISH_CODE) {
    const overridden = status.perLocale.catalogue.overridden;
    return overridden > 0 ? { label: `${overridden} overridden`, alert: false } : null;
  }
  const counts = status.perLocale.locales[code];
  if (!counts) return null;
  const pending = counts.missing + counts.stale;
  return pending > 0
    ? { label: `${pending} to translate`, alert: true }
    : { label: `${counts.translated} done`, alert: false };
}

export function LanguageTabs({
  languages,
  locale,
  status,
  onChange,
}: {
  languages: UiLanguage[];
  locale: string;
  status: UiDictionaryStatus | null;
  onChange: (code: string) => void;
}) {
  return (
    <Tabs.Root value={locale} onValueChange={onChange} variant="simple">
      <Tabs.List aria-label="Languages">
        {languages.map((language) => {
          const count = tabCount(status, language.code);
          const running =
            status?.jobs?.[language.code]?.status === 'pending' ||
            status?.jobs?.[language.code]?.status === 'processing';
          return (
            <Tabs.Trigger key={language.code} value={language.code}>
              <Flex gap={2} alignItems="center">
                <Typography fontWeight={language.code === locale ? 'bold' : 'regular'}>
                  {language.name}
                </Typography>
                {language.code !== ENGLISH_CODE ? (
                  <Typography variant="pi" textColor="neutral600" dir={language.dir}>
                    {language.nativeName}
                  </Typography>
                ) : null}
                {running ? <Badge active>Translating…</Badge> : null}
                {count ? (
                  <Badge variant={count.alert ? 'warning' : 'neutral'} size="S">
                    {count.label}
                  </Badge>
                ) : null}
              </Flex>
            </Tabs.Trigger>
          );
        })}
      </Tabs.List>
    </Tabs.Root>
  );
}
