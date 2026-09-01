// Edit one key: an English override or one language's text. The textarea
// takes the language's direction; the counter shows the declared maxLength
// so the editor sees the ceiling before the server rejects the save.
import * as React from 'react';
import { Badge, Box, Button, Field, Flex, Modal, Textarea, Typography } from '@strapi/design-system';

import { ENGLISH_CODE, type UiDictionaryEntry, type UiLanguage } from '../types';

const MAX_TEXT_LENGTH = 2_000;
const PLACEHOLDER = /\{[a-zA-Z_][\w.-]*\}/gu;

export function placeholdersOf(text: string): string[] {
  return [...new Set(text.match(PLACEHOLDER) ?? [])];
}

export function initialText(entry: UiDictionaryEntry, isEnglish: boolean): string {
  if (isEnglish) return entry.source.overrideText ?? entry.source.text;
  return entry.translation?.text ?? '';
}

export function EntryEditDialog({
  entry,
  language,
  saving,
  onClose,
  onSave,
}: {
  entry: UiDictionaryEntry;
  language: UiLanguage;
  saving: boolean;
  onClose: () => void;
  onSave: (text: string) => void;
}) {
  const isEnglish = language.code === ENGLISH_CODE;
  const [text, setText] = React.useState(() => initialText(entry, isEnglish));
  const english = isEnglish ? entry.source.text : entry.source.effectiveText;
  const placeholders = placeholdersOf(english);
  const limit = entry.source.maxLength ?? MAX_TEXT_LENGTH;
  const length = text.trim().length;
  const missing = placeholders.filter((placeholder) => !text.includes(placeholder));
  const error =
    length === 0
      ? 'Text is required.'
      : length > limit
        ? `Over ${limit} characters.`
        : missing.length
          ? `Missing ${missing.join(', ')}.`
          : undefined;

  return (
    <Modal.Root open onOpenChange={(open: boolean) => !open && onClose()}>
      <Modal.Content>
        <Modal.Header>
          <Modal.Title>{`${isEnglish ? 'Override English' : `Edit ${language.name}`} — ${entry.key}`}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Flex direction="column" alignItems="stretch" gap={4}>
            {entry.source.description ? (
              <Typography variant="pi" textColor="neutral600">
                {entry.source.description}
              </Typography>
            ) : null}
            <Box padding={3} background="neutral100" hasRadius>
              <Typography variant="pi" textColor="neutral600">
                {isEnglish ? 'Catalogue English' : 'English source'}
              </Typography>
              <Typography tag="p">{english}</Typography>
            </Box>
            {placeholders.length ? (
              <Flex gap={2} alignItems="center" wrap="wrap">
                <Typography variant="pi" textColor="neutral600">Keep these placeholders:</Typography>
                {placeholders.map((placeholder) => (
                  <Badge key={placeholder}>{placeholder}</Badge>
                ))}
              </Flex>
            ) : null}
            <Field.Root name="text" error={error} hint={`${length}/${limit} characters`}>
              <Field.Label>{isEnglish ? 'English shown on the site' : `${language.name} text`}</Field.Label>
              <Textarea
                dir={language.dir}
                value={text}
                onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value)}
              />
              <Field.Hint />
              <Field.Error />
            </Field.Root>
            {isEnglish ? (
              <Typography variant="pi" textColor="neutral600">
                Saving text identical to the catalogue English clears the override. Changing it re-translates
                this key in every language.
              </Typography>
            ) : (
              <Typography variant="pi" textColor="neutral600">
                A manual text is kept until the English source of this key changes.
              </Typography>
            )}
          </Flex>
        </Modal.Body>
        <Modal.Footer>
          <Modal.Close>
            <Button variant="tertiary" disabled={saving}>Cancel</Button>
          </Modal.Close>
          <Button loading={saving} disabled={Boolean(error)} onClick={() => onSave(text.trim())}>
            Save
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
