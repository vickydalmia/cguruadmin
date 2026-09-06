import * as React from 'react';
import {
  Badge,
  Box,
  Button,
  Field,
  Flex,
  MultiSelect,
  MultiSelectOption,
  Typography,
} from '@strapi/design-system';
import { useFetchClient } from '@strapi/strapi/admin';

import {
  countrySetupError,
  parseTranslationLocales,
  serializeTranslationLocales,
  unwrapLanguages,
} from '../api';
import type { SelectableLanguage } from '../types';

type Props = {
  /** The stored csv (`translationLocales`). */
  value: string;
  /** True while the translation master switch is off. */
  disabled: boolean;
  onChange: (csv: string) => void;
};

type LanguageLoad =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; languages: SelectableLanguage[] };

function useSelectableLanguages(): [LanguageLoad, () => void] {
  const { get } = useFetchClient();
  const [load, setLoad] = React.useState<LanguageLoad>({ state: 'loading' });
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setLoad({ state: 'loading' });
    get('/country-setup/languages')
      .then((response) => {
        if (!cancelled) {
          setLoad({ state: 'ready', languages: unwrapLanguages(response) });
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setLoad({ state: 'error', message: countrySetupError(caught) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [get, attempt]);

  return [load, () => setAttempt((count) => count + 1)];
}

function SelectedLanguageRow({
  code,
  language,
}: {
  code: string;
  language: SelectableLanguage | undefined;
}) {
  return (
    <Flex gap={3} alignItems="center" wrap="wrap">
      <Typography fontWeight="bold">{language?.name ?? code}</Typography>
      {language ? (
        <Typography dir={language.dir} textColor="neutral600">
          {language.nativeName}
        </Typography>
      ) : (
        <Typography variant="pi" textColor="danger600">
          Not a selectable language — saving will reject it.
        </Typography>
      )}
      {language?.dir === 'rtl' ? <Badge active>RTL</Badge> : null}
      {language?.script ? <Badge>{language.script}</Badge> : null}
      <Typography variant="pi" textColor="neutral600">{`/${code}/`}</Typography>
    </Flex>
  );
}

export function TranslationLanguagesField({ value, disabled, onChange }: Props) {
  const [load, retry] = useSelectableLanguages();
  const selected = parseTranslationLocales(value);
  const languages = load.state === 'ready' ? load.languages : [];
  const byCode = new Map(languages.map((language) => [language.code, language]));
  const loading = load.state === 'loading';
  const errorMessage = load.state === 'error' ? load.message : undefined;

  const hint = disabled
    ? 'Turn translation on to pick languages.'
    : 'Each language is served under its own URL prefix (/xx/). Saving applies to this CMS instance at once; restart any other CMS containers.';

  return (
    <Field.Root name="translationLocales" hint={hint} error={errorMessage}>
      <Field.Label>Target languages</Field.Label>
      <MultiSelect
        withTags
        value={selected}
        disabled={disabled || loading || load.state === 'error'}
        loading={loading}
        placeholder={loading ? 'Loading languages…' : 'Pick one or more languages'}
        onChange={(codes: string[]) => onChange(serializeTranslationLocales(codes))}
        onClear={() => onChange('')}
        clearLabel="Clear languages"
      >
        {languages.map((language) => (
          <MultiSelectOption key={language.code} value={language.code}>
            {`${language.name} · ${language.nativeName} (${language.code})`}
          </MultiSelectOption>
        ))}
      </MultiSelect>
      <Field.Hint />
      <Field.Error />
      {load.state === 'error' ? (
        <Box paddingTop={2}>
          <Button variant="tertiary" size="S" onClick={retry}>
            Retry loading languages
          </Button>
        </Box>
      ) : null}
      {load.state === 'ready' && selected.length > 0 ? (
        <Flex paddingTop={3} direction="column" alignItems="stretch" gap={2}>
          {selected.map((code) => (
            <SelectedLanguageRow key={code} code={code} language={byCode.get(code)} />
          ))}
        </Flex>
      ) : null}
    </Field.Root>
  );
}
