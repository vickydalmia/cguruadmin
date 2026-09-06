// Header buttons of the UI Text page. Import/Export work on the selected
// language; the two translation triggers are hidden while the deployment
// does not translate (no Country Setup switch / TRANSLATION_* env).
import * as React from 'react';
import { Button, Flex } from '@strapi/design-system';

export function PageActions({
  isEnglish,
  translationActive,
  disabled,
  polling,
  onImport,
  onExport,
  onTranslate,
  onRetranslate,
}: {
  isEnglish: boolean;
  translationActive: boolean;
  disabled: boolean;
  polling: boolean;
  onImport: () => void;
  onExport: () => void;
  onTranslate: () => void;
  onRetranslate: () => void;
}) {
  return (
    <Flex gap={2} wrap="wrap">
      <Button variant="tertiary" disabled={disabled} onClick={onImport}>
        Import JSON
      </Button>
      <Button variant="tertiary" disabled={disabled} onClick={onExport}>
        Export JSON
      </Button>
      {translationActive ? (
        <>
          <Button variant="secondary" disabled={disabled || polling} onClick={onTranslate}>
            {isEnglish ? 'Translate missing/stale (all languages)' : 'Translate missing/stale'}
          </Button>
          <Button variant="danger-light" disabled={disabled || polling} onClick={onRetranslate}>
            Re-translate all
          </Button>
        </>
      ) : null}
    </Flex>
  );
}
