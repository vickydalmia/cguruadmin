// Import `{ "key": "text" }` JSON for the selected language — pasted or
// from a file. English → overrides; other languages → manual texts. Shows
// the server's written/skipped result so unknown keys are not silent.
import * as React from 'react';
import { Box, Button, Field, Flex, Modal, Textarea, Typography } from '@strapi/design-system';

import { parseImportJson } from '../api';
import type { ImportResult, UiLanguage } from '../types';

export function ImportDialog({
  language,
  busy,
  onClose,
  onImport,
}: {
  language: UiLanguage;
  busy: boolean;
  onClose: () => void;
  onImport: (messages: Record<string, string>) => Promise<ImportResult | null>;
}) {
  const [text, setText] = React.useState('');
  const [result, setResult] = React.useState<ImportResult | null>(null);

  let parsed: Record<string, string> | null = null;
  let parseError: string | undefined;
  if (text.trim()) {
    try {
      parsed = parseImportJson(text);
    } catch (caught: any) {
      parseError = caught?.message ?? 'Invalid JSON.';
    }
  }

  const readFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    file.text().then(setText, () => setText(''));
  };

  const submit = async () => {
    if (!parsed) return;
    setResult(await onImport(parsed));
  };

  return (
    <Modal.Root open onOpenChange={(open: boolean) => !open && onClose()}>
      <Modal.Content>
        <Modal.Header>
          <Modal.Title>{`Import JSON — ${language.name}`}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Flex direction="column" alignItems="stretch" gap={4}>
            <Typography variant="pi" textColor="neutral600">
              {language.code === 'en'
                ? 'Each key becomes an English override (text equal to the catalogue English clears it).'
                : `Each key becomes a manual ${language.name} text, kept until its English source changes.`}{' '}
              Keys not in the catalogue and texts missing a placeholder are skipped.
            </Typography>
            <input type="file" accept="application/json,.json" onChange={readFile} />
            <Field.Root
              name="json"
              error={parseError}
              hint={parsed ? `${Object.keys(parsed).length} keys ready to import.` : 'Paste { "key": "text" } JSON or choose a file.'}
            >
              <Field.Label>JSON</Field.Label>
              <Textarea
                value={text}
                onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value)}
              />
              <Field.Hint />
              <Field.Error />
            </Field.Root>
            {result ? (
              <Box padding={3} background={result.skipped.length ? 'warning100' : 'success100'} hasRadius>
                <Typography fontWeight="bold">{`${result.written} written, ${result.skipped.length} skipped.`}</Typography>
                {result.skipped.slice(0, 25).map((row) => (
                  <Typography key={row.key} tag="p" variant="pi">{`${row.key}: ${row.reason}`}</Typography>
                ))}
                {result.skipped.length > 25 ? (
                  <Typography tag="p" variant="pi">{`… and ${result.skipped.length - 25} more.`}</Typography>
                ) : null}
              </Box>
            ) : null}
          </Flex>
        </Modal.Body>
        <Modal.Footer>
          <Modal.Close>
            <Button variant="tertiary" disabled={busy}>Close</Button>
          </Modal.Close>
          <Button loading={busy} disabled={!parsed} onClick={submit}>
            Import
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
