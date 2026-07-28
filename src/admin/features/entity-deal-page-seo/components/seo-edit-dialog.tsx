import * as React from 'react';
import {
  Box,
  Button,
  Field,
  Flex,
  Modal,
  Textarea,
  TextInput,
  Toggle,
  Typography,
} from '@strapi/design-system';

import { toFormState, type SeoFormState } from '../api';
import { BLOCKER_LABELS, type EntityDealPageRow } from '../types';

// Mirrors SEO_LIMITS in the entity-deal-page service. Shown as a live counter
// so an editor sees the ceiling before the server rejects the save.
const LIMITS = {
  metaTitle: 70,
  metaDescription: 170,
  ogTitle: 95,
  ogDescription: 200,
  ogImageAlt: 125,
} as const;

type Props = {
  row: EntityDealPageRow;
  saving: boolean;
  onClose: () => void;
  onSave: (form: SeoFormState) => void;
};

function CountedField({
  label,
  hint,
  value,
  limit,
  multiline,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  limit?: number;
  multiline?: boolean;
  onChange: (value: string) => void;
}) {
  const over = limit !== undefined && value.trim().length > limit;
  const handleChange = (
    event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => onChange(event.target.value);

  return (
    <Field.Root
      name={label}
      error={over ? `Over ${limit} characters.` : undefined}
      hint={limit === undefined ? hint : `${hint} ${value.trim().length}/${limit}`}
    >
      <Field.Label>{label}</Field.Label>
      {multiline ? (
        <Textarea value={value} onChange={handleChange} />
      ) : (
        <TextInput value={value} onChange={handleChange} />
      )}
      <Field.Hint />
      <Field.Error />
    </Field.Root>
  );
}

export default function SeoEditDialog({ row, saving, onClose, onSave }: Props) {
  const [form, setForm] = React.useState<SeoFormState>(() => toFormState(row));
  const set = <K extends keyof SeoFormState>(key: K, value: SeoFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  // Blockers other than indexing-disabled cannot be cleared from this dialog,
  // so say what the editor would actually have to go and do.
  const externalBlockers = row.resolvedSeo.blockers.filter(
    (blocker) => blocker !== 'indexing-disabled',
  );

  return (
    <Modal.Root open onOpenChange={(open: boolean) => !open && onClose()}>
      <Modal.Content>
        <Modal.Header>
          <Modal.Title>{`Deal page SEO — ${row.name}`}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Flex direction="column" alignItems="stretch" gap={4}>
            <Box>
              <Typography variant="pi" textColor="neutral600">
                {row.permalink}
              </Typography>
            </Box>

            <Field.Root
              name="indexingEnabled"
              hint={
                row.liveDealCount > 0
                  ? 'Every other field below is optional — leave one empty and the generated value is used.'
                  : 'This page has no live Product Deals, so it stays noindex until it does.'
              }
            >
              <Field.Label>Allow search engines to index this page</Field.Label>
              <Toggle
                checked={form.indexingEnabled}
                onLabel="On"
                offLabel="Off"
                onChange={() => set('indexingEnabled', !form.indexingEnabled)}
              />
              <Field.Hint />
            </Field.Root>

            {externalBlockers.length > 0 ? (
              <Box
                padding={3}
                background="warning100"
                borderColor="warning200"
                hasRadius
              >
                <Typography variant="pi" textColor="warning600">
                  {`Still blocked after saving: ${externalBlockers
                    .map((blocker) => BLOCKER_LABELS[blocker])
                    .join('; ')}.`}
                </Typography>
              </Box>
            ) : null}

            <CountedField
              label="Meta title"
              hint={`Empty uses “${row.resolvedSeo.metaTitle}”.`}
              value={form.metaTitle}
              limit={LIMITS.metaTitle}
              onChange={(value) => set('metaTitle', value)}
            />
            <CountedField
              label="Meta description"
              hint="Empty uses the generated description."
              value={form.metaDescription}
              limit={LIMITS.metaDescription}
              multiline
              onChange={(value) => set('metaDescription', value)}
            />
            <CountedField
              label="Canonical URL"
              hint={`Root-relative only. Empty uses ${row.permalink}. Anything else makes the page noindex.`}
              value={form.canonicalUrl}
              onChange={(value) => set('canonicalUrl', value)}
            />
            <CountedField
              label="OG title"
              hint="Empty falls back to the meta title."
              value={form.ogTitle}
              limit={LIMITS.ogTitle}
              onChange={(value) => set('ogTitle', value)}
            />
            <CountedField
              label="OG description"
              hint="Empty falls back to the meta description."
              value={form.ogDescription}
              limit={LIMITS.ogDescription}
              multiline
              onChange={(value) => set('ogDescription', value)}
            />
            <CountedField
              label="OG image alt"
              hint="Empty falls back to the entity logo's alt text."
              value={form.ogImageAlt}
              limit={LIMITS.ogImageAlt}
              onChange={(value) => set('ogImageAlt', value)}
            />
          </Flex>
        </Modal.Body>
        <Modal.Footer>
          <Modal.Close>
            <Button variant="tertiary" disabled={saving}>
              Cancel
            </Button>
          </Modal.Close>
          <Button loading={saving} onClick={() => onSave(form)}>
            Save
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
